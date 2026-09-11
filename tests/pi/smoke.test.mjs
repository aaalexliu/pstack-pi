import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { FIXTURE_TEXT } from "./provider.mjs";
import { jsonlParser, PiTestError, runPiSmoke } from "./runner.mjs";

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
  assert.deepEqual(run.pack.files, ["LICENSE", "README.md", "package.json"]);
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
