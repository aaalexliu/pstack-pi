import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { jsonlParser } from '../jsonl.mjs';

export const CONTROL_PROMPT = 'Run the local recursion positive control.';
export const CONTROL_ARGS = ['--mode', 'json', '--print', '--offline', '--no-approve', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-session', '--tools', 'read,subagent', '--provider', 'pi-fixture', '--model', 'pi-smoke-model', '--thinking', 'off'];

/** @param {Pick<import('@earendil-works/pi-coding-agent').ExtensionAPI, 'registerTool'>} pi */
export default function unsafeRecursion(pi) {
  const nonce = process.env.PSTACK_RECURSION_TEST_NONCE;
  const raw = process.env.PSTACK_RECURSION_TEST_CONFIG;
  if (!raw || !nonce) return;
  assert.ok(raw.length <= 4_096 && /^[a-f0-9]{32}$/.test(nonce), 'Invalid recursion test configuration');
  const config = JSON.parse(raw);
  assert.equal(config.kind, 'unsafe-recursion-positive-control');
  assert.equal(config.nonce, nonce);
  assert.equal(config.extension, realpathSync(fileURLToPath(import.meta.url)));
  for (const field of ['node', 'cli', 'evidence']) assert.equal(typeof config[field], 'string');
  assert.equal(config.node, realpathSync(process.execPath));
  assert.equal(config.cli, realpathSync(process.argv[1]));
  assert.ok(process.argv.includes('--no-extensions') && process.argv.includes(config.extension), 'Fixture requires explicit extension loading');

  pi.registerTool({
    name: 'subagent', label: 'Unsafe recursion test',
    description: 'Test-only positive control. Spawn one Pi and await its exit without a depth policy. Output is limited to 64 KiB per stream.',
    parameters: Type.Object({}),
    async execute() {
      const child = spawn(config.node, [config.cli, ...CONTROL_ARGS, '--no-extensions', '-e', config.extension, '--', CONTROL_PROMPT], {
        cwd: process.cwd(), env: process.env, detached: false, shell: false, stdio: 'pipe',
      });
      const output = join(config.evidence, `child-${child.pid}.jsonl`);
      const errors = join(config.evidence, `child-${child.pid}.stderr`);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const parser = jsonlParser(() => {});
      await new Promise((resolve, reject) => {
        /** @type {unknown} */
        let failure;
        /** @param {unknown} error */
        const fail = (error) => {
          if (failure) return;
          failure = error;
          appendFileSync(errors, String(error).slice(0, 1_024) + '\n');
        };
        child.once('error', fail);
        child.stdin.on('error', fail);
        child.stdout.on('data', (chunk) => {
          try {
            stdoutBytes += chunk.length;
            assert.ok(stdoutBytes <= 64 * 1024, 'Child stdout exceeded 64 KiB');
            appendFileSync(output, chunk);
            parser.write(chunk);
          } catch (error) { fail(error); child.stdout.removeAllListeners('data'); child.stdout.resume(); }
        });
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= 64 * 1024) appendFileSync(errors, chunk);
          if (stderrBytes > 64 * 1024) { fail(new Error('Child stderr exceeded 64 KiB')); child.stderr.removeAllListeners('data'); child.stderr.resume(); }
        });
        child.once('close', (code, signal) => {
          try {
            if (failure) throw failure;
            parser.end();
            assert.equal(stderrBytes, 0, 'Child emitted stderr');
            assert.equal(signal, null);
            assert.equal(code, 0, 'Child did not exit cleanly');
            resolve(undefined);
          } catch (error) { fail(error); reject(error); }
        });
        child.stdin.end();
      });
      return { content: [{ type: 'text', text: 'Child exited.' }], details: {} };
    },
  });
}
