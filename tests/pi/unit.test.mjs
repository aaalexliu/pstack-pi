import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { FIXTURE_KEY, FIXTURE_MODEL, FIXTURE_TEXT, startProvider } from "./provider.mjs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonlParser, PiTestError, disposePreparedPackage, extractPreparedPackage, preparePackedPackage, repositoryRevision, runPiSmoke } from "./runner.mjs";
import { expectedPackFiles, contentInventory } from "../../scripts/check-content.mjs";
import { classifyTestFiles, listTestFiles, PI_UNIT_TESTS } from "../../scripts/run-tests.mjs";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));

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

test("run-tests classifies packed Pi files apart from the unified nonpacked set", async () => {
  const files = await listTestFiles(repository);
  const { packed, nonpacked } = classifyTestFiles(files);
  assert.equal(files.length, packed.length + nonpacked.length);
  assert.equal(nonpacked.includes("tests/pi/unit.test.mjs"), true);
  assert.equal(packed.includes("tests/pi/unit.test.mjs"), false);
  for (const file of PI_UNIT_TESTS) assert.equal(nonpacked.includes(file), true);
  assert.equal(nonpacked.includes("tests/pi/smoke.test.mjs"), false);
  assert.equal(packed.includes("tests/pi/smoke.test.mjs"), true);
  const future = "tests/pi/future-integration.test.mjs";
  const classified = classifyTestFiles([...files, future]);
  assert.equal(classified.packed.includes(future), true);
  assert.equal(classified.nonpacked.includes(future), false);
});

test("prepared production pack is reused and extracts stay isolated", async () => {
  const content = contentInventory(
    JSON.parse(await readFile(join(repository, "sync/manifest.json"), "utf8")),
    JSON.parse(await readFile(join(repository, "sync/upstream.lock.json"), "utf8")),
  );
  const files = expectedPackFiles(content);
  const [first, second] = await Promise.all([
    preparePackedPackage({ sourceRoot: repository, files, content }),
    preparePackedPackage({ sourceRoot: repository, files, content }),
  ]);
  assert.equal(first, second);
  assert.equal(first.tarball, second.tarball);
  assert.equal(first.shasum, second.shasum);
  assert.equal(first.hold, second.hold);
  assert.equal(existsSync(first.tarball), true);
  const root = await mkdtemp(join(tmpdir(), "pstack-pi-extract-"));
  try {
    const a = join(root, "a", "packed skills");
    const b = join(root, "b", "packed skills");
    await extractPreparedPackage(first, a);
    await extractPreparedPackage(first, b);
    const sample = first.files[0];
    assert.deepEqual(await readFile(join(a, sample)), await readFile(join(repository, sample)));
    await writeFile(join(a, sample), "mutated extract");
    assert.deepEqual(await readFile(join(b, sample)), await readFile(join(repository, sample)));
    assert.deepEqual(await readFile(join(first.hold, "package", sample)), await readFile(join(repository, sample)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed production pack and extract remove their temporary dirs", async () => {
  await disposePreparedPackage();
  const tmp = await mkdtemp(join(await realpath(tmpdir()), "pstack-pi-failed-pack-"));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    await assert.rejects(preparePackedPackage({ sourceRoot: repository, files: ["does-not-exist"] }));
    assert.deepEqual(await readdir(tmp), []);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    await rm(tmp, { recursive: true, force: true });
  }
  const content = contentInventory(
    JSON.parse(await readFile(join(repository, "sync/manifest.json"), "utf8")),
    JSON.parse(await readFile(join(repository, "sync/upstream.lock.json"), "utf8")),
  );
  const pack = await preparePackedPackage({
    sourceRoot: repository,
    files: expectedPackFiles(content),
    content,
  });
  const destRoot = await mkdtemp(join(tmpdir(), "pstack-pi-extract-fail-"));
  try {
    const dest = join(destRoot, "out");
    await writeFile(dest, "blocked");
    await assert.rejects(extractPreparedPackage(pack, dest));
    assert.equal((await readdir(destRoot)).some((name) => name.startsWith("extract-")), false);
  } finally {
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("custom fixture packs are not cached across source edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pstack-pi-fixture-pack-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "@aaalexliu/pstack-pi",
      version: "0.0.0",
      files: ["package.json"],
    }));
    const first = await preparePackedPackage({ sourceRoot: root, files: ["package.json"] });
    t.after(() => rm(first.hold, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "@aaalexliu/pstack-pi",
      version: "0.0.1",
      files: ["package.json"],
    }));
    const second = await preparePackedPackage({ sourceRoot: root, files: ["package.json"] });
    t.after(() => rm(second.hold, { recursive: true, force: true }));
    assert.notEqual(first.tarball, second.tarball);
    assert.notEqual(first.shasum, second.shasum);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keepArtifacts copies the production tarball into the retained run root", async () => {
  /** @type {string | undefined} */
  let root;
  try {
    await assert.rejects(runPiSmoke({ executable: "/nonexistent-pi-smoke-executable", keepArtifacts: true }), (error) => {
      assert.ok(error instanceof PiTestError);
      root = error.run.paths.root;
      assert.equal(error.run.cleanup.tempRemoved, false);
      assert.equal(existsSync(root), true);
      return true;
    });
    assert.ok(root);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tgz")), true);
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
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
