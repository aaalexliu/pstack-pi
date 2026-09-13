import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { FIXTURE_KEY, FIXTURE_MODEL, FIXTURE_TEXT, startProvider } from "./provider.mjs";
import { checkContent, expectedPackFiles } from '../../scripts/check-content.mjs';
import { contentFixture, skillText } from '../content/fixture.mjs';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/sync-upstream.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const productionSkills = ['bro', 'principle-boundary-discipline', 'principle-encode-lessons-in-structure', 'principle-type-system-discipline', 'tdd', 'technical-writing', 'typescript-best-practices', 'unslop'];

async function productionInventory() {
  return checkContent({ root: repository,
    manifest: JSON.parse(await readFile(join(repository, 'sync/manifest.json'), 'utf8')),
    lock: JSON.parse(await readFile(join(repository, 'sync/upstream.lock.json'), 'utf8')),
  });
}

/** @param {import('./runner.mjs').PiTestRun} run */
function assertOnlyDeclaredTools(run) {
  assert.deepEqual(run.diagnostics, []);
  const runtime = run.pack.files.includes('extensions/subagent/index.ts');
  assert.deepEqual(run.resources?.extensions, runtime ? [join(run.paths.package, 'extensions/pstack/index.ts'), join(run.paths.package, 'extensions/subagent/index.ts')] : []);
  const tools = run.provider?.decodedRequests[0]?.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['bash', 'edit', ...(runtime ? ['pstack_todo'] : []), 'read', ...(runtime ? ['subagent'] : []), 'write']);
  assert.ok(!run.events.some((event) => event.type.startsWith('tool_execution')));
}
import { jsonlParser, PiTestError, repositoryRevision, runPiSmoke } from "./runner.mjs";

test('revision is optional without metadata and preserves the full checkout SHA', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-pi-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  assert.equal(repositoryRevision(root), 'unknown');
  git(['init', '--object-format=sha1']);
  assert.equal(repositoryRevision(root), 'unknown');
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
  const revision = git(['rev-parse', 'HEAD']);
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(repositoryRevision(root), revision);
  const archive = join(root, 'archive');
  await mkdir(archive);
  assert.equal(existsSync(join(archive, '.git')), false);
  assert.equal(repositoryRevision(archive), 'unknown');
});

/** @param {import("./runner.mjs").PiTestRun} run */
function assertClean(run) {
  assert.equal(run.cleanup.groupAlive, false);
  assert.deepEqual(run.cleanup.remainingPids, []);
  assert.equal(run.cleanup.providerClosed, true);
  assert.equal(run.cleanup.tempRemoved, true);
  assert.equal(existsSync(run.paths.root), false);
  const { pid, pgid } = run.process;
  if (pid !== null) {
    assert.ok(pgid !== null);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
  }
}

test("JSONL uses LF and preserves split UTF-8 and Unicode separators", () => {
  /** @type {import("./runner.mjs").PiEvent[]} */
  const events = [];
  const parser = jsonlParser((event) => events.push(event));
  const input = Buffer.from(`${JSON.stringify({ type: "text", text: FIXTURE_TEXT })}\r\n`);
  for (const byte of input) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(events, [{ type: "text", text: FIXTURE_TEXT }]);
});

test("JSONL rejects malformed, unfinished, and oversized records", () => {
  for (const line of ["not JSON\n", "[]\n", "{}\n", "\n", "x".repeat(65_537)]) {
    assert.throws(() => jsonlParser(() => {}).write(Buffer.from(line)));
  }
  const parser = jsonlParser(() => {});
  parser.write(Buffer.from('{"type":"text"}'));
  assert.throws(() => parser.end(), /without LF/);
  const many = jsonlParser(() => {});
  assert.throws(() => many.write(Buffer.from('{"type":"text"}\n'.repeat(257))), /count exceeded/);
});

test("real Pi loads the packed package and settles with fixture text and usage", async (context) => {
  const run = await runPiSmoke();
  assertClean(run);
  assert.deepEqual(run.cleanup.signals, []);
  assert.deepEqual(run.pack.files, expectedPackFiles(await productionInventory()));
  assert.equal(run.pack.files.length, 25);
  assertOnlyDeclaredTools(run);
  context.diagnostic(JSON.stringify({
    pi: run.process.version, revision: run.process.revision, pid: run.process.pid,
    events: run.events.map((event) => event.type), durationMs: run.durationMs,
    requests: run.provider?.requests, exit: run.exit, cleanup: run.cleanup,
    pack: run.pack.files, shasum: run.pack.shasum,
  }));
});

test("smoke rejects wrong terminal text without a timeout", async () => {
  await assert.rejects(runPiSmoke({ fixture: { text: "controlled wrong response" } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /Wrong terminal assistant text/);
    assert.equal(error.run.timeout.expired, false);
    assert.equal(error.run.provider?.requests, 1);
    assert.ok(error.run.events.some((event) => event.type === "agent_settled"));
    assertClean(error.run);
    return true;
  });
});

test("provider errors retain diagnostics and clean up", async () => {
  await assert.rejects(runPiSmoke({ fixture: { mode: "error" } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /controlled fixture error/);
    assert.equal(error.run.timeout.expired, false);
    assertClean(error.run);
    return true;
  });
});

test("a missing Pi executable retains setup errors and removes temporary state", async () => {
  await assert.rejects(runPiSmoke({ executable: "/nonexistent-pi-smoke-executable" }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /ENOENT/);
    assert.equal(error.run.process.pid, null);
    assertClean(error.run);
    return true;
  });
});

test("deadline kills the owned Pi process group", async () => {
  await assert.rejects(runPiSmoke({ fixture: { mode: "stall" }, timeoutMs: 5_000 }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.equal(error.run.timeout.expired, true);
    assert.deepEqual(error.run.cleanup.signals, ["SIGKILL"]);
    assert.equal(error.run.exit?.signal, "SIGKILL");
    assertClean(error.run);
    return true;
  });
});

/** @param {import('./runner.mjs').PiTestRun} run @returns {string} */
function requestUserText(run) {
  const request = run.provider?.decodedRequests[0];
  assert.ok(request && Array.isArray(request.messages));
  const users = request.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 1);
  const content = users[0].content;
  assert.ok(Array.isArray(content));
  return content.map((block) => {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
    return block.text;
  }).join('');
}

for (const name of productionSkills) {
  test(`real packed Pi expands /skill:${name} with exact body, arguments, and relocated paths`, async (t) => {
    const inventory = await productionInventory();
    assert.deepEqual([...inventory.bySkillName.keys()].sort(), productionSkills);
    const skill = inventory.bySkillName.get(name);
    assert.ok(skill);
    const run = await runPiSmoke({ prompt: `/skill:${name} inspect α` });
    assertClean(run);
    assertOnlyDeclaredTools(run);
    const location = join(run.paths.package, skill.destination);
    const user = requestUserText(run);
    assert.equal(user, `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${skill.body}\n</skill>\n\ninspect α`);
    assert.ok(!user.includes(repository));
    const discovered = run.resources?.skills;
    assert.ok(Array.isArray(discovered));
    assert.deepEqual(discovered.map((entry) => entry.name).sort(), productionSkills);
    assert.ok(discovered.every((entry) => entry.disableModelInvocation === true && entry.baseDir.startsWith(run.paths.package + '/')));
    const messages = run.provider?.decodedRequests[0]?.messages;
    assert.ok(Array.isArray(messages));
    const system = JSON.stringify(messages.filter((message) => message.role === 'system'));
    for (const selected of inventory.bySkillName.values()) assert.ok(!system.includes(selected.description), 'Manual skill leaked into model discovery');
    t.diagnostic(JSON.stringify({ name, pi: run.process.version, bodySha256: sha256(skill.body), userBytes: Buffer.byteLength(user), location, tools: ['bash', 'edit', 'read', 'write'], diagnostics: run.diagnostics, cleanup: run.cleanup }));
  });
}

for (const name of ['how', 'poteto-mode', 'setup-pstack']) {
  test(`real packed Pi leaves unsupported /skill:${name} unexpanded`, async () => {
    const prompt = `/skill:${name} unsupported argument`;
    const run = await runPiSmoke({ prompt });
    assertClean(run);
    assertOnlyDeclaredTools(run);
    assert.equal(requestUserText(run), prompt);
  });
}

for (const name of ['copied', 'transformed']) {
  test('packed fixture expands /skill:' + name + ' with arguments after relocation', async (t) => {
    const f = await contentFixture(t);
    const inventory = await checkContent(f);
    const run = await runPiSmoke({ packageFixture: { root: f.root, files: expectedPackFiles(inventory) }, prompt: '/skill:' + name + ' argument α' });
    assertClean(run);
    const skill = inventory.bySkillName.get(name);
    assert.ok(skill);
    const user = requestUserText(run);
    const location = join(run.paths.package, skill.destination);
    assert.equal(user, `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${skill.body}\n</skill>\n\nargument α`);
    assert.ok(!user.includes(f.root));
    assert.deepEqual(run.diagnostics, []);
    t.diagnostic(JSON.stringify({ name, user, relocated: run.paths.package, requests: run.provider?.requests }));
  });
}

test('packed fixture leaves unsupported skill commands unexpanded', async (t) => {
  const f = await contentFixture(t);
  const inventory = await checkContent(f);
  const prompt = '/skill:omitted leave this alone';
  const run = await runPiSmoke({ packageFixture: { root: f.root, files: expectedPackFiles(inventory) }, prompt });
  assertClean(run);
  assert.equal(requestUserText(run), prompt);
});

test('real Pi reports duplicate skill names in fixture packages', async (t) => {
  const f = await contentFixture(t);
  await f.put('skills/transformed/SKILL.md', skillText('copied', 'SHADOW_MARKER'));
  const run = await runPiSmoke({ packageFixture: { root: f.root, files: f.pkg.files }, prompt: '/skill:copied argument', allowDiagnostics: true });
  assertClean(run);
  t.diagnostic(JSON.stringify(run.diagnostics));
  assert.match(run.diagnostics.join('\n'), /collision|duplicate|conflict/i);
  assert.ok(requestUserText(run).includes('COPIED_MARKER'));
  assert.ok(!requestUserText(run).includes('SHADOW_MARKER'));
  await assert.rejects(runPiSmoke({ packageFixture: { root: f.root, files: f.pkg.files } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /Pi emitted diagnostics/);
    assertClean(error.run);
    return true;
  });
});

test('provider bounds decoded request retention and rejects oversized requests', async () => {
  const provider = await startProvider();
  try {
    const payload = { model: FIXTURE_MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Fixture α' }] };
    /** @param {unknown} body */
    const send = (body) => fetch(provider.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + FIXTURE_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (let i = 0; i < 16; i++) {
      const response = await send(payload);
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await send(payload)).status, 400);
    assert.equal(provider.state.decodedRequests.length, 16);
    assert.deepEqual(provider.state.decodedRequests[0], payload);
    const oversized = await send({ ...payload, padding: 'x'.repeat(256 * 1024) });
    assert.equal(oversized.status, 400);
    assert.equal(provider.state.decodedRequests.length, 16);
    assert.ok(provider.state.retainedBytes <= 1024 * 1024);
    assert.ok(provider.state.errors.some((error) => error.includes('capture limit')));
    assert.ok(provider.state.errors.some((error) => error.includes('256 KiB')));
  } finally {
    await provider.close();
  }
});

test('provider rejects capture beyond the total byte budget', async () => {
  const provider = await startProvider();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(provider.baseUrl + '/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + FIXTURE_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model: FIXTURE_MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'x'.repeat(220 * 1024) }] }),
      });
      assert.equal(response.status, i < 4 ? 200 : 400);
      await response.text();
    }
    assert.equal(provider.state.decodedRequests.length, 4);
    assert.ok(provider.state.retainedBytes <= 1024 * 1024);
  } finally {
    await provider.close();
  }
});
