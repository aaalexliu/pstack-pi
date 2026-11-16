import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

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

/** A child gets the agent's tools, its own checklist, and the two control tools, but no delegation. */
/** @param {Record<string, unknown>} request @param {string[]} builtins */
function assertChild(request, builtins) {
  assert.deepEqual(toolNames(request), [...builtins, 'caller_ping', 'pstack_todo', 'subagent_done'].sort());
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

test('packed real parent waits for a headless child of a bundled agent, then keeps running', async (t) => {
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
      { reply: { kind: 'tool', id: 'delegate', name: 'subagent', arguments: { name: 'Reader', agent: 'general-purpose', task: 'Read fixture.txt and report its exact contents.', wait: true } }, check: (request) => assert.ok(toolNames(request).includes('subagent')) },
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
      const text = /** @type {any} */ (end.result).content[0].text;
      assert.match(text, /^resolved-model: pi-fixture\/pi-smoke-model\nsession-id: \S+\nsession-path: \S+\.jsonl\n/);
      assert.equal(/** @type {any} */ (end.result).details.status, 'finished');
      const pid = Number(childProcesses[0].trim().split(/\s+/)[0]);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    },
  });
  assert.equal(run.cleanup.groupAlive, false);
  assert.deepEqual(run.cleanup.signals, []);
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, pi: run.process.version, parentPid: run.process.pid, childProcesses, requests: run.provider?.requests, cleanup: run.cleanup }));
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
      { reply: { kind: 'tool', id: 'override', name: 'subagent', arguments: { name: 'Override', agent: 'general-purpose', task: 'Print the working directory.', cwd: 'sub', wait: true } } },
      { reply: { kind: 'text', text: 'Ran in sub.' }, check: (request) => {
        assertChild(request, ['bash']);
        assert.ok(JSON.stringify(request).includes(marker));
      } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.ok(toolResult(request, 'override').includes('Ran in sub.')) },
    ] },
    verify: async (run) => {
      const [end] = subagentEnds(run);
      assert.equal(end?.isError, false);
    },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, diagnostics: run.diagnostics, cleanup: run.cleanup }));
});

test('a child with host default tools gets neither delegation tool set', async (t) => {
  const final = 'The default-tools child answered.';
  const delegation = ['subagent', 'subagent_interrupt', 'subagent_resume', 'subagents_list'];
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 3,
    setup: async (paths) => {
      await setupProject(paths);
      await mkdir(path.join(paths.profile, 'agents'), { recursive: true });
      await writeFile(path.join(paths.profile, 'agents/default-tools.md'), '---\nname: default-tools\ndescription: No tool list.\n---\nAnswer briefly.');
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'default-tools', name: 'subagent', arguments: { name: 'Default', agent: 'default-tools', task: 'Say hello.', wait: true } }, check: (request) => {
        for (const tool of delegation) assert.ok(toolNames(request).includes(tool), `Parent has ${tool}`);
      } },
      { reply: { kind: 'text', text: 'hello' }, check: (request) => {
        const tools = toolNames(request);
        assert.ok(tools.includes('read') && tools.includes('pstack_todo'), 'Child keeps host default tools');
        for (const tool of delegation) assert.ok(!tools.includes(tool), `Child lacks ${tool}`);
      } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.ok(toolResult(request, 'default-tools').includes('hello')) },
    ] },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, diagnostics: run.diagnostics }));
});

test('packed poteto-agent can edit through its explicit tool set', async () => {
  const final = 'Poteto delegate finished.';
  let packageRoot = '';
  let sessions = '';
  const run = await runPiSmoke({
    expectedText: final, expectedRequests: 4,
    prompt: 'Delegate the bounded fixture edit.',
    setup: async (paths) => {
      await setupProject(paths);
      packageRoot = paths.package;
      sessions = paths.sessions;
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate-poteto', name: 'subagent', arguments: { name: 'Poteto', agent: 'poteto-agent', task: 'Create poteto-created.txt with the exact text POTETO_LEAF.', wait: true } } },
      { reply: { kind: 'tool', id: 'write-poteto', name: 'bash', arguments: { command: 'printf %s POTETO_LEAF > poteto-created.txt' } }, check: async (request) => {
        assertChild(request, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
        const skillPath = path.join(packageRoot, 'skills/poteto-mode/SKILL.md');
        const [artifacts] = await readdir(path.join(sessions, 'artifacts'));
        const [prompt] = (await readdir(path.join(sessions, 'artifacts', artifacts, 'context'))).filter((name) => name.startsWith('poteto-sysprompt-'));
        const text = await readFile(path.join(sessions, 'artifacts', artifacts, 'context', prompt), 'utf8');
        assert.equal(text.includes(skillPath), true);
        assert.equal(text.includes('{{PSTACK_ROOT}}'), false);
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

test('packed real parent gets one quiet-log ping for a headless child while it runs another tool', async () => {
  /** @type {string[]} */
  const pings = [];
  const run = await runPiSmoke({
    expectedText: 'Done.', expectedRequests: 6, keepArtifacts: true, timeoutMs: 30000,
    prompt: 'Start a quiet child, then run a slow shell command.',
    setup: async (paths) => {
      await writeFile(path.join(paths.package, 'extensions/interactive-subagents/config.json'), JSON.stringify({ status: { enabled: true, quietMinutes: 0.02 } }));
    },
    fixture: { script: [
      { reply: { kind: 'tool', id: 'delegate', name: 'subagent', arguments: { name: 'Quiet', agent: 'poteto-agent', task: 'quiet-leaf' } } },
      { reply: { kind: 'tool', id: 'hold', name: 'bash', arguments: { command: 'sleep 6' } } },
      { reply: { kind: 'tool', id: 'build', name: 'bash', arguments: { command: 'sleep 4' } } },
      { reply: { kind: 'text', text: 'Child done.' } },
      { reply: { kind: 'text', text: 'Done.' }, check: (request) => { pings.push(JSON.stringify(request)); } },
      { reply: { kind: 'text', text: 'Done.' }, check: (request) => { pings.push(JSON.stringify(request)); } },
    ] },
  });
  const ping = /Subagent \\"Quiet\\" has written nothing to its session log for \d+ min: it is mid tool call: bash\./;
  assert.ok(pings.some((request) => ping.test(request)), 'The parent request carries the quiet ping');
  const logs = execFileSync('find', [run.paths.sessions, '-name', '*.jsonl'], { encoding: 'utf8' }).trim().split('\n');
  const texts = await Promise.all(logs.map((file) => readFile(file, 'utf8')));
  const quietEntries = texts.flatMap((text) => text.split('\n')).filter((line) => line.includes('"subagent_status"') && line.includes('written nothing'));
  assert.equal(quietEntries.length, 1, 'One ping per quiet stretch');
});
