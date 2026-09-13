import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';
import { FIXTURE_TEXT } from './provider.mjs';
import { persistedStats } from './session-stats.mjs';

/** @param {unknown} value */
function record(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}

const usage = { input: 101, output: 23, cacheRead: 5, cacheWrite: 7, totalTokens: 999,
  cost: { input: 0.11, output: 0.23, cacheRead: 0.05, cacheWrite: 0.07, total: 0.46 } };
const content = [{ type: 'text', text: 'owned contract failure' }];
const details = { marker: 'retained details' };

for (const mode of ['returned', 'thrown', 'patched']) {
  test(`installed Pi accounting contract: ${mode}`, { timeout: 30000 }, async () => {
    await runPiSmoke({
      expectedRequests: 2,
      fixture: { script: [
        { reply: { kind: 'tool', name: 'accounting_probe', id: 'contract-id', arguments: { mode } } },
        { reply: { kind: 'text', text: FIXTURE_TEXT }, check(payload) {
          assert.ok(Array.isArray(payload.messages));
          const result = record(payload.messages.find((message) => message.role === 'tool'));
          assert.ok(typeof result.content === 'string' && result.content.includes(content[0].text));
        } },
      ] },
      async setup(paths) {
        await mkdir(join(paths.profile, 'extensions'));
        await writeFile(join(paths.profile, 'extensions/contract.ts'), `
          import { Type } from 'typebox';
          export default function(pi) {
            let input;
            const envelope = ${JSON.stringify({ content, details, usage })};
            pi.registerTool({ name: 'accounting_probe', label: 'Probe', description: 'Accounting contract probe',
              parameters: Type.Object({ mode: Type.String() }),
              async execute(id, params) {
                input = params;
                if (params.mode === 'returned') return { ...envelope, isError: true };
                throw Object.assign(new Error(envelope.content[0].text), envelope);
              }
            });
            pi.on('tool_result', (event) => {
              if (event.toolName !== 'accounting_probe') return;
              if (event.input !== input || event.toolCallId !== 'contract-id') throw new Error('Input identity changed');
              if (event.input.mode === 'patched') {
                if (!event.isError || event.content[0].text !== envelope.content[0].text || event.usage !== undefined || Object.keys(event.details).length) throw new Error('Native error changed');
                return { ...envelope, isError: true };
              }
            });
          }
        `);
      },
      async verify(run) {
        const end = run.events.find((event) => event.type === 'tool_execution_end');
        const final = record(run.events.find((event) => event.type === 'message_end' && record(event.message).role === 'toolResult')?.message);
        assert.ok(end);
        assert.equal(end.isError, mode !== 'returned');
        assert.equal(final.isError, mode !== 'returned');
        assert.deepEqual(record(end.result).content, content);
        assert.deepEqual(final.content, content);
        for (const result of [record(end.result), final]) {
          assert.deepEqual(result.details, mode === 'thrown' ? {} : details);
          assert.deepEqual(result.usage, mode === 'thrown' ? undefined : usage);
        }
        const stats = await persistedStats(run);
        assert.deepEqual(stats.before, stats.after, 'Reload must not add usage');
        assert.deepEqual(stats.before.tokens, mode === 'thrown'
          ? { input: 22, output: 14, cacheRead: 0, cacheWrite: 0, total: 36 }
          : { input: 123, output: 37, cacheRead: 5, cacheWrite: 7, total: 172 });
        assert.equal(stats.before.cost, mode === 'thrown' ? 0 : 0.46);
        assert.equal(stats.messages.filter((/** @type {{role: string}} */ message) => message.role === 'toolResult').length, 1);
      },
    });
  });
}
