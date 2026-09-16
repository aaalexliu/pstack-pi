import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import subagentExtension from '../../extensions/subagent/index.ts';

/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition | undefined} */
let tool;
subagentExtension(/** @type {any} */ ({ registerTool(/** @type {NonNullable<typeof tool>} */ value) { tool = value; }, registerCommand() {}, on() {} }), { env: {} });
const theme = /** @type {import('@earendil-works/pi-coding-agent').Theme} */ ({ fg: (_color, text) => text, bold: (text) => text });
const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost: 0.1, contextTokens: 440, turns: 2 };
const row = (overrides = {}) => ({ agent: 'general-purpose', agentSource: 'user', task: 'Review', model: 'fixture/model', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'latest.ts' } }] }], usage, ...overrides });
/** @param {ReturnType<typeof row>[]} results */
function render(results, mode = 'parallel', expanded = false, width = 200) {
  assert.ok(tool?.renderResult);
  const context = /** @type {Parameters<typeof tool.renderResult>[3]} */ ({});
  return stripVTControlCharacters(tool.renderResult({ content: [], details: { mode, results } }, { expanded, isPartial: false }, theme, context).render(width).join('\n'));
}

test('legacy parallel cards keep each single-agent usage line and last activity plus total', () => {
  for (const exitCode of [0, -1, 1]) {
    const agent = row({ exitCode, ...(exitCode === 1 ? { stopReason: 'error', errorMessage: 'Timed out' } : {}) });
    const text = render([agent, row()]);
    const singleUsage = render([agent], 'single').split('\n').find((line) => line.includes('2 turns'))?.trim();
    assert.ok(singleUsage && text.includes(singleUsage));
    assert.equal(text.match(/2 turns ↑100 ↓20 R300 W40 \$0\.1000 ctx:440 fixture\/model/g)?.length, 2);
    assert.match(text, /Total: 4 turns ↑200 ↓40 R600 W80 \$0\.2000/);
    assert.match(text, /latest.ts/);
    assert.match(text, /\(user\)/);
    if (exitCode === 1) assert.match(text, /Error: Timed out/);
  }
});

test('legacy expanded, empty and narrow cards retain usage without overflowing', () => {
  const rows = [row(), row({ exitCode: 1, errorMessage: 'Timed out', messages: [] })];
  for (const expanded of [false, true]) {
    const text = render(rows, 'parallel', expanded);
    assert.match(text, /Total: 4 turns/);
    assert.equal(text.match(/ctx:440 fixture\/model/g)?.length, 2);
    assert.match(text, /Error: Timed out/);
    for (const width of [1, 28, 80]) {
      assert.ok(render(rows, 'parallel', expanded, width).split('\n').every((line) => visibleWidth(line) <= width));
    }
  }
});
