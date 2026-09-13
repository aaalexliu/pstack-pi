import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {import('./runner.mjs').PiTestRun} run */
export async function persistedStats(run) {
  const files = (await readdir(run.paths.sessions)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const sdk = pathToFileURL(join(dirname(run.process.args[0]), 'index.js')).href;
  const script = `
    const { createAgentSession, SessionManager, DefaultResourceLoader } = await import(${JSON.stringify(sdk)});
    const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ resourceLoader, sessionManager: SessionManager.open(${JSON.stringify(join(run.paths.sessions, files[0]))}) });
    try {
      await session.bindExtensions({ mode: 'json' });
      const before = session.getSessionStats();
      await session.reload();
      const after = session.getSessionStats();
      process.stdout.write(JSON.stringify({ before, after, messages: session.messages }));
    } finally { session.dispose(); }
  `;
  return JSON.parse(execFileSync(run.process.executable, ['--input-type=module', '-e', script], {
    cwd: run.paths.cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: run.paths.home, PI_CODING_AGENT_DIR: run.paths.profile, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
  }));
}
