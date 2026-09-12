import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';
import { startProvider } from './provider.mjs';

test('provider bounds scripted steps and reply bytes before opening a socket', async () => {
  const reply = { kind: /** @type {const} */ ('text'), text: 'fixture' };
  for (const script of [[], Array.from({ length: 17 }, () => ({ reply })), [{ reply: { ...reply, text: 'x'.repeat(32769) } }]]) {
    await assert.rejects(startProvider({ script }));
  }
});

/** @param {Record<string, unknown>} request */
function toolNames(request) {
  if (request.tools === undefined) return [];
  assert.ok(Array.isArray(request.tools));
  return request.tools.map((tool) => tool.function.name).sort();
}

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return JSON.stringify(result.content);
}

/** @param {Record<string, unknown>} request @param {string[]} tools */
function assertChild(request, tools) {
  assert.deepEqual(toolNames(request), [...tools].sort());
  assert.ok(!JSON.stringify(request).includes('UNTRUSTED_CONTEXT_MARKER'));
  assert.ok(!JSON.stringify(request).includes('APPENDED_CONTEXT_MARKER'));
  assert.ok(!JSON.stringify(request).includes('available_skills'));
}

/** @param {import('./runner.mjs').PiTestRun['paths']} paths */
async function setupProject(paths) {
  await mkdir(path.join(paths.cwd, '.pi/agents'), { recursive: true });
  await writeFile(path.join(paths.cwd, '.pi/agents/project.md'), '---\nname: project\ndescription: Untrusted.\ntools: [bash]\n---\nUNTRUSTED_CONTEXT_MARKER');
  await writeFile(path.join(paths.cwd, 'AGENTS.md'), 'UNTRUSTED_CONTEXT_MARKER');
  await writeFile(path.join(paths.profile, 'APPEND_SYSTEM.md'), 'APPENDED_CONTEXT_MARKER');
}

test('packed real parent delegates a file read, then runs harmless bash containing Git action text', async (t) => {
  const marker = 'DELEGATE_FILE_7f6b2a';
  const final = `The child read ${marker}. The parent shell ran.`;
  /** @type {string[]} */
  let childProcesses = [];
  let parentPid = 0;
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 5, keepArtifacts: true,
    onSpawn: (pid) => { parentPid = pid; },
    prompt: 'Delegate the fixture read, then run the harmless shell check and report both.',
    setup: async (paths) => {
      await setupProject(paths);
      await writeFile(path.join(paths.cwd, 'fixture.txt'), marker);
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Read fixture.txt and report its exact contents.' } }, check: (request) => assert.ok(toolNames(request).includes('subagent')) },
      { reply: { kind: 'tool', id: 'read-fixture', name: 'read', arguments: { path: 'fixture.txt' } }, check: (request) => {
        assertChild(request, ['read', 'grep', 'find', 'ls']);
        childProcesses = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => Number(line.trim().split(/\s+/)[1]) === parentPid && /(?:\bpi$|pi-coding-agent\/dist\/)/.test(line.trimEnd()));
        assert.equal(childProcesses.length, 1, `Expected one real child Pi: ${execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => Number(line.trim().split(/\s+/)[1]) === parentPid).join('\n')}`);
        assert.match(childProcesses[0], /pi/);
      } },
      { reply: { kind: 'text', text: marker }, check: (request) => {
        assertChild(request, ['read', 'grep', 'find', 'ls']);
        assert.ok(toolResult(request, 'read-fixture').includes(marker));
      } },
      { reply: { kind: 'tool', id: 'harmless-shell', name: 'bash', arguments: { command: 'printf "%s\\n" "literal git push and gh pr edit" > parent-bash.txt' } }, check: (request) => assert.ok(toolResult(request, 'delegate').includes(marker)) },
      { reply: { kind: 'text', text: final }, check: (request) => { toolResult(request, 'harmless-shell'); } },
    ] },
    verify: async (run) => {
      assert.equal(await readFile(path.join(run.paths.cwd, 'parent-bash.txt'), 'utf8'), 'literal git push and gh pr edit\n');
      assert.deepEqual(run.diagnostics, []);
      const result = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.ok(result && result.isError === false);
      assert.ok(result.result && typeof result.result === 'object' && 'details' in result.result);
      const details = result.result.details;
      assert.ok(details && typeof details === 'object' && 'kind' in details && 'usage' in details && 'agent' in details && 'cwd' in details);
      assert.equal(details.kind, 'succeeded');
      assert.equal(details.usage, null);
      assert.equal(details.cwd, run.paths.cwd);
      assert.ok(JSON.stringify(details.agent).includes(path.join(run.paths.package, 'agents/general-purpose.md')));
      assert.ok(!(await readdir(run.paths.root)).some((name) => name.startsWith('pstack-subagent-')));
      const pid = Number(childProcesses[0].trim().split(/\s+/)[0]);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    },
  });
  assert.equal(run.cleanup.groupAlive, false);
  assert.deepEqual(run.cleanup.signals, []);
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, pi: run.process.version, parentPid: run.process.pid, childProcesses, requests: run.provider?.requests, result: final, diagnostics: run.diagnostics, cleanup: run.cleanup, pack: run.pack.files }));
});

for (const scenario of ['project agent', 'different cwd']) {
  test(`real parent rejects ${scenario} before any child request`, async (t) => {
    const final = `Rejected ${scenario}.`;
    const run = await runPiSmoke({
      expectedText: final, expectedRequests: 2, setup: setupProject,
      fixture: { script: [
        { reply: { kind: 'tool', id: 'deny', name: 'subagent', arguments: scenario === 'project agent'
          ? { agent: 'project', task: 'Do not run this project agent.' }
          : { agent: 'general-purpose', task: 'Do not change cwd.', cwd: '..' } } },
        { reply: { kind: 'text', text: final }, check: (request) => {
          assert.ok(toolNames(request).includes('subagent'), 'Unexpected child request');
          assert.match(toolResult(request, 'deny'), scenario === 'project agent' ? /Unknown agent/ : /cwd differs/);
        } },
      ] },
      verify: async (run) => {
        const result = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
        assert.equal(result?.isError, true);
      },
    });
    t.diagnostic(JSON.stringify({ scenario, requests: run.provider?.requests, cleanup: run.cleanup, diagnostics: run.diagnostics }));
  });
}

test('empty-tools user override reaches a real child with no tools or delegation', async (t) => {
  const marker = 'EMPTY_USER_AGENT';
  const final = 'The user agent had no tools.';
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 3,
    setup: async (paths) => {
      await setupProject(paths);
      await mkdir(path.join(paths.profile, 'agents'), { recursive: true });
      await writeFile(path.join(paths.profile, 'agents/general-purpose.md'), `---\nname: general-purpose\ndescription: Test an empty allowlist.\ntools: []\n---\n${marker}. Do not delegate.`);
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'empty', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Report that no tools are available.', cwd: '.' } } },
      { reply: { kind: 'text', text: 'No tools available.' }, check: (request) => {
        assertChild(request, []);
        assert.ok(JSON.stringify(request).includes(marker));
      } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.ok(toolResult(request, 'empty').includes('No tools available.')) },
    ] },
    verify: async (run) => {
      const event = run.events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.equal(event?.isError, false);
      assert.ok(JSON.stringify(event).includes(path.join(run.paths.profile, 'agents/general-purpose.md')));
      assert.ok(JSON.stringify(event).includes('"kind":"user"'));
    },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, diagnostics: run.diagnostics, cleanup: run.cleanup }));
});
