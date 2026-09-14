import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { RunProgress, progressCard } from '../../extensions/subagent/progress.ts';
import { renderProgressResult, createProgressView } from '../../extensions/subagent/view.ts';

function fixture() {
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot | undefined} */
  let snapshot;
  const run = new RunProgress([{ agent: 'poteto-agent', role: 'review', task: 'Review cancellation.' }], (value) => { snapshot = value; });
  run.started(0);
  run.finish();
  assert.ok(snapshot);
  const row = snapshot.tasks[0];
  row.state = 'succeeded';
  row.model = 'pi-fixture/review-model';
  row.observedModel = row.model;
  row.message = 'Brief result preview.';
  row.todos = ['[done] Read', 'Verify'];
  row.lastEventAt = row.endedAt;
  return { snapshot, card: progressCard(snapshot) };
}
const theme = /** @type {Parameters<typeof renderProgressResult>[2]} */ ({ fg: (_color, text) => text });
const context = /** @type {Parameters<typeof renderProgressResult>[3]} */ ({});
/** @param {unknown} details @param {boolean} [expanded] @param {boolean} [isPartial] */
function render(details, expanded = false, isPartial = false) {
  return renderProgressResult({ content: [{ type: 'text', text: 'Original result\nline two\nline three\nline four\nline five\nFULL ORIGINAL OUTPUT' }], details }, { expanded, isPartial }, theme, context);
}

test('the tool card shows model, role, event age, usage and todos while collapsed or live', () => {
  const { snapshot, card } = fixture();
  for (const partial of [false, true]) {
    const text = render({ progressCard: progressCard(snapshot, partial) }, false, partial).render(100).join('\n');
    assert.match(text, /#1 review/);
    assert.match(text, /pi-fixture\/review-model/);
    assert.match(text, /last event 0s before finish/);
    assert.match(text, /tok \$/);
    assert.match(text, /todos 1\/2/);
    if (partial) assert.match(text, /Brief result preview/);
    else assert.match(text, /Original result/);
    assert.doesNotMatch(text, /FULL ORIGINAL OUTPUT/);
  }
  assert.match(render({ progressCard: card }, true).render(100).join('\n'), /FULL ORIGINAL OUTPUT/);
});
test('cards survive serialization, remain per-result, and fit a narrow terminal', () => {
  const { card } = fixture();
  const saved = JSON.parse(JSON.stringify({ progressCard: card }));
  render({ progressCard: { version: 1, lines: ['Another request'] } }).render(40);
  const lines = render(saved).render(28);
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.match(lines.join('\n'), /review-model/);
  assert.doesNotMatch(lines.join('\n'), /Another request/);
});
test('legacy and malformed cards retain original output; valid cards strip terminal controls', () => {
  for (const details of [undefined, {}, { progressCard: { version: 2, lines: ['bad'] } }, { progressCard: { version: 1, lines: ['x'.repeat(513)] } }]) {
    assert.match(render(details).render(80).join('\n'), /FULL ORIGINAL OUTPUT/);
  }
  const text = render({ progressCard: { version: 1, lines: ['\x1b[31mred\n\u202etext'] } }).render(80).join('\n');
  assert.doesNotMatch(text, /\x1b\[31m|\u202e/);
});
test('persisted cards stay bounded with eight tasks and long public messages', () => {
  const { snapshot } = fixture();
  snapshot.endedAt = null;
  snapshot.tasks = Array.from({ length: 8 }, (_, index) => ({ ...snapshot.tasks[0], index, message: '界'.repeat(10000) }));
  const card = progressCard(snapshot);
  assert.equal(card.lines.length, 33);
  assert.ok(card.lines.every((line) => Buffer.byteLength(line) <= 512));
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 18000);
  assert.ok(card.lines.some((line) => line.endsWith('...')));
});
test('the companion view no longer installs a duplicate widget', async (t) => {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_WORKSPACE_ID;
  t.after(() => { if (workspace !== undefined) process.env.CMUX_WORKSPACE_ID = workspace; });
  const pi = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) { assert.equal(name, 'registerCommand'); return () => {}; },
  });
  const ui = new Proxy({}, { get() { throw new Error('No widget or status UI calls expected'); } });
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionContext} */ ({ hasUI: true, ui });
  const view = createProgressView(pi);
  view.publish(fixture().snapshot, ctx);
  await view.close();
});
