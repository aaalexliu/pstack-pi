import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseDepth, RunLease } from '../../extensions/subagent/domain.ts';
import { PiInvocation, processBackend } from '../../extensions/subagent/process.ts';
import { resolveCwd, runChild } from '../../extensions/subagent/runner.ts';

const invocation = await PiInvocation.resolve({ entrypoint: fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)) });
const provenance = { kind: /** @type {const} */ ('bundled'), path: '/agent.md', sha256: 'a'.repeat(64) };
const agent = { name: 'test', description: 'Test.', tools: [], systemPrompt: 'Test.', provenance };
const identity = { id: 'prompt', agent: { name: agent.name, provenance }, cwd: await resolveCwd({ current: process.cwd() }) };
const model = { provider: 'fixture', id: 'model', thinkingLevel: /** @type {const} */ ('off') };

for (const stalled of ['write', 'remove']) {
  test(`a stalled prompt ${stalled} cannot hold a cancelled request or shutdown open`, { timeout: 6000 }, async (t) => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    t.after(release);
    let entered = () => {};
    const started = new Promise((resolve) => { entered = () => resolve(undefined); });
    let directory = '';
    let spawns = 0;
    const controller = new AbortController();
    const lease = new RunLease();
    const pending = runChild({ identity, agent, model, task: 'fixture', invocation, depth: parseDepth(undefined), lease, signal: controller.signal,
      promptFiles: { mkdtemp,
        writeFile: async (filename, data) => {
          assert.equal(typeof filename, 'string');
          directory = path.dirname(String(filename));
          if (stalled === 'write') { entered(); await gate; }
          await writeFile(filename, data, { mode: 0o600, flag: 'wx' });
        },
        rm: async (filename, options) => { if (stalled === 'remove') { entered(); await gate; } await rm(filename, options); },
      },
      backend: { ...processBackend, spawn: (_invocation, argv, options) => {
        spawns++;
        return spawn(process.execPath, [fileURLToPath(new URL('./child-fixture.mjs', import.meta.url)), 'success', ...argv], options);
      } },
    });
    await started;
    const stopped = Date.now();
    controller.abort();
    const result = await pending;
    assert.ok(Date.now() - stopped < 3000);
    assert.equal(result.kind, 'cancelled');
    assert.equal(result.cleanup.verified, true);
    assert.deepEqual(result.diagnostics, ['Prompt file removal did not finish in time']);
    assert.equal(lease.state.kind, 'finished');
    assert.equal(spawns, stalled === 'write' ? 0 : 1);
    const next = new RunLease();
    next.prepare(); next.run(); next.verify(); next.finish();
    release();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) { try { await access(directory); await delay(10); } catch { break; } }
    await assert.rejects(access(directory), { code: 'ENOENT' });
  });
}
