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

/** A child gets the agent's tools and its own checklist, but no delegation. */
/** @param {Record<string, unknown>} request @param {string[]} builtins */
function assertChild(request, builtins) {
  assert.deepEqual(toolNames(request), [...builtins, 'pstack_todo'].sort());
  const text = JSON.stringify(request);
  assert.ok(text.includes('PROJECT_CONTEXT_MARKER'), 'Child reads the project AGENTS.md');
}

/** @param {import('./runner.mjs').PiTestRun['paths']} paths */
async function setupProject(paths) {
  await mkdir(path.join(paths.cwd, '.pi/agents'), { recursive: true });
  await writeFile(path.join(paths.cwd, '.pi/agents/project.md'), '---\nname: project\ndescription: Untrusted.\ntools: [bash]\n---\nPROJECT_AGENT_MARKER');
  await writeFile(path.join(paths.cwd, 'AGENTS.md'), 'PROJECT_CONTEXT_MARKER');
}

/** @param {import('./runner.mjs').PiTestRun} run */
function subagentEnds(run) {
  return run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
}

test('packed real parent delegates a file read to a bundled agent, then keeps running', async (t) => {
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
        childProcesses = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => Number(line.trim().split(/\s+/)[1]) === parentPid && /(?:\bpi$|pi-coding-agent\/dist\/)/.test(line.trimEnd()));
        assert.equal(childProcesses.length, 1, `Expected one real child Pi under ${parentPid}`);
        const [pid, , pgid] = childProcesses[0].trim().split(/\s+/).map(Number);
        assert.equal(pid, pgid, 'The child leads its own process group');
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
      const [end] = subagentEnds(run);
      assert.ok(end && end.isError === false);
      const details = /** @type {import('../../extensions/subagent/index.ts').SubagentDetails} */ (/** @type {any} */ (end.result).details);
      assert.equal(details.mode, 'single');
      assert.equal(details.results.length, 1);
      const [result] = details.results;
      assert.equal(result.exitCode, 0);
      assert.equal(result.stopReason, 'stop');
      assert.equal(result.agentSource, 'bundled');
      assert.equal(result.modelSource, 'parent');
      assert.equal(result.model, 'pi-fixture/pi-smoke-model');
      assert.equal(result.usage.turns, 2);
      assert.ok(result.usage.input > 0 && result.usage.output > 0);
      assert.ok(!(await readdir(run.paths.root)).some((name) => name.startsWith('pi-subagent-')), 'Prompt temp directories are removed');
      const pid = Number(childProcesses[0].trim().split(/\s+/)[0]);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    },
  });
  assert.equal(run.cleanup.groupAlive, false);
  assert.deepEqual(run.cleanup.signals, []);
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, pi: run.process.version, parentPid: run.process.pid, childProcesses, requests: run.provider?.requests, cleanup: run.cleanup }));
});

test('project agents stay hidden until agentScope opts in', async (t) => {
  const final = 'Project agent rejected.';
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 2, setup: setupProject,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'deny', name: 'subagent', arguments: { agent: 'project', task: 'Do not run this project agent.' } } },
      { reply: { kind: 'text', text: final }, check: (request) => {
        assert.ok(toolNames(request).includes('subagent'), 'Unexpected child request');
        assert.match(toolResult(request, 'deny'), /Unknown agent \\"project\\"/);
        assert.match(toolResult(request, 'deny'), /general-purpose \(bundled\)/);
      } },
    ] },
    verify: async (run) => {
      const [end] = subagentEnds(run);
      assert.equal(end?.isError, false, 'Guidance about a bad request is not an error result');
    },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, cleanup: run.cleanup, diagnostics: run.diagnostics }));
});

test('a user agent overrides the bundled one by name and runs in a subdirectory cwd', async (t) => {
  const marker = 'USER_AGENT_PROMPT_MARKER';
  const final = 'The user agent answered.';
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 3,
    setup: async (paths) => {
      await setupProject(paths);
      await mkdir(path.join(paths.cwd, 'sub'));
      await mkdir(path.join(paths.profile, 'agents'), { recursive: true });
      await writeFile(path.join(paths.profile, 'agents/general-purpose.md'), `---\nname: general-purpose\ndescription: Bash-only override.\ntools: [bash]\n---\n${marker}`);
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'override', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Print the working directory.', cwd: 'sub' } } },
      { reply: { kind: 'text', text: 'Ran in sub.' }, check: (request) => {
        assertChild(request, ['bash']);
        assert.ok(JSON.stringify(request).includes(marker));
      } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.ok(toolResult(request, 'override').includes('Ran in sub.')) },
    ] },
    verify: async (run) => {
      const [end] = subagentEnds(run);
      assert.equal(end?.isError, false);
      const details = /** @type {import('../../extensions/subagent/index.ts').SubagentDetails} */ (/** @type {any} */ (end?.result).details);
      assert.equal(details.results[0].agentSource, 'user');
    },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, diagnostics: run.diagnostics, cleanup: run.cleanup }));
});

test('packed poteto-agent can edit through its explicit tool set', async () => {
  const final = 'Poteto delegate finished.';
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 4,
    prompt: 'Delegate the bounded fixture edit.',
    setup: setupProject,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate-poteto', name: 'subagent', arguments: { agent: 'poteto-agent', task: 'Create poteto-created.txt with the exact text POTETO_LEAF.' } } },
      { reply: { kind: 'tool', id: 'write-poteto', name: 'bash', arguments: { command: 'printf %s POTETO_LEAF > poteto-created.txt' } }, check: (request) => {
        assertChild(request, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
      } },
      { reply: { kind: 'text', text: 'Created poteto-created.txt.' }, check: (request) => { toolResult(request, 'write-poteto'); } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.match(toolResult(request, 'delegate-poteto'), /Created poteto-created\.txt/) },
    ] },
    verify: async (result) => {
      assert.equal(await readFile(path.join(result.paths.cwd, 'poteto-created.txt'), 'utf8'), 'POTETO_LEAF');
    },
  });
  assert.deepEqual(run.diagnostics, []);
});
