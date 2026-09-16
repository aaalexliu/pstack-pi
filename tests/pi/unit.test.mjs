import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { FIXTURE_KEY, FIXTURE_MODEL, FIXTURE_TEXT, startProvider } from "./provider.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { jsonlParser, PiTestError, repositoryRevision, runPiSmoke } from "./runner.mjs";

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

test("a missing Pi executable retains setup errors and removes temporary state", async () => {
  await assert.rejects(runPiSmoke({ executable: "/nonexistent-pi-smoke-executable" }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /ENOENT/);
    assert.equal(error.run.process.pid, null);
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

test('provider bounds scripted steps and reply bytes before opening a socket', async () => {
  const reply = { kind: /** @type {const} */ ('text'), text: 'fixture' };
  for (const script of [[], Array.from({ length: 17 }, () => ({ reply })), [{ reply: { ...reply, text: 'x'.repeat(32769) } }]]) {
    await assert.rejects(startProvider({ script }));
  }
});
