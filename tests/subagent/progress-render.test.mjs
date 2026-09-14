import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { visibleWidth, matchesKey } from '@earendil-works/pi-tui';
const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } = await import(hostRequire.resolve('@earendil-works/pi-tui'));
import { RunProgress, progressCard, progressLines } from '../../extensions/subagent/progress.ts';
import { renderProgressResult, createProgressView } from '../../extensions/subagent/view.ts';

setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
  'app.tools.expand': { defaultKeys: 'ctrl+o' }, 'app.interrupt': { defaultKeys: 'escape' },
}));

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
function fixture(count = 1, live = false) {
  /** @type {import('../../extensions/subagent/progress.ts').ProgressSnapshot | undefined} */ let snapshot;
  const run = new RunProgress(Array.from({ length: count }, () => ({ agent: 'poteto-agent', role: 'review', task: 'Review cancellation.', model: 'pi-fixture/review-model' })), (value) => { snapshot = value; });
  run.started(0);
  run.event(0, { type: 'message_end', message: { role: 'assistant', provider: 'pi-fixture', model: 'review-model', content: [{ type: 'text', text: 'Brief result preview.' }] } }, zero());
  run.event(0, { type: 'tool_execution_end', toolName: 'pstack_todo', result: { details: { version: 1, items: ['[done] Read', 'Verify'] } } }, zero());
  run.publish();
  assert.ok(snapshot);
  const running = snapshot;
  run.result(0, { exitCode: 0, usage: zero() });
  run.finish();
  return live ? running : snapshot;
}
const theme = /** @type {Parameters<typeof renderProgressResult>[2]} */ ({ fg: (_color, text) => text });
const context = /** @type {Parameters<typeof renderProgressResult>[3]} */ ({});
/** @param {unknown} details @param {boolean} [expanded] @param {boolean} [isPartial] */
function render(details, expanded = false, isPartial = false) {
  return renderProgressResult({ content: [{ type: 'text', text: 'Original result\nline two\nline three\nline four\nline five\nFULL ORIGINAL OUTPUT' }], details }, { expanded, isPartial }, theme, context);
}

test('inline metadata shows role, model, timing, usage and todos with live previews or original completed output', () => {
  for (const partial of [false, true]) {
    const snapshot = fixture(1, partial);
    const text = render({ progress: snapshot }, false, partial).render(100).join('\n');
    assert.match(text, /#1 review/);
    assert.match(text, /pi-fixture\/review-model/);
    assert.match(text, partial ? /last event 0s ago/ : /last event 0s before finish/);
    assert.match(text, /tok \$/);
    assert.match(text, /todos 1\/2/);
    if (partial) {
      assert.match(text, /Brief result preview/);
      assert.doesNotMatch(text, /Original result/);
    } else {
      assert.match(text, /Original result/);
      assert.match(text, /ctrl\+o: full output/i);
      assert.doesNotMatch(text, /Brief result preview/);
    }
    assert.doesNotMatch(text, /FULL ORIGINAL OUTPUT/);
  }
  assert.match(render({ progress: fixture() }, true).render(100).join('\n'), /FULL ORIGINAL OUTPUT/);
});

test('parallel cards show each usage and the full batch total while running and after reload', () => {
  for (const live of [false, true]) {
    const snapshot = fixture(3, live);
    for (const [index, row] of snapshot.tasks.entries()) {
      row.usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost: (index + 1) / 10, contextTokens: 440, turns: 2 };
    }
    for (const expanded of [false, true]) {
      const text = render(JSON.parse(JSON.stringify({ progress: snapshot })), expanded, live).render(100).join('\n');
      for (const cost of ['0.1000', '0.2000', '0.3000']) assert.ok(text.includes(`460 tok $${cost}`));
      assert.match(text, /Total: 1380 tok \$0\.6000/);
    }
  }
});

test('batch totals include hidden tasks and match the inspector without summing context', () => {
  const snapshot = fixture(24, true);
  for (const row of snapshot.tasks) row.usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, contextTokens: 99, turns: 1 };
  const card = progressCard(snapshot).lines.join('\n');
  assert.match(card, /Total: 240 tok \$2\.4000/);
  assert.match(card, /16 tasks omitted/);
  assert.match(progressLines(snapshot).join('\n'), /Total: 240 tok \$2\.4000/);
  assert.doesNotMatch(progressCard(fixture()).lines.join('\n'), /Total:/);
});

test('completion wins over partial flag and serialized metadata stays per-result after reload', () => {
  const saved = JSON.parse(JSON.stringify({ progress: fixture() }));
  const other = fixture();
  other.tasks[0].role = 'Another request';
  render({ progress: other }).render(40);
  const text = render(saved, false, true).render(100).join('\n');
  assert.match(text, /Original result/);
  assert.match(text, /review-model/);
  assert.doesNotMatch(text, /Another request|Brief result preview|stop batch/);
});

test('normal, long and Unicode rows fit narrow widths without dropping the card', () => {
  for (const count of [1, 8, 24]) {
    const snapshot = fixture(count, true);
    snapshot.tasks[0].message = '界👩‍💻é'.repeat(20);
    for (const width of [0, 1, 2, 12, 28, 40, 80]) {
      const lines = render({ progress: snapshot }, false, true).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `count ${count}, width ${width}`);
      if (width >= 28) assert.match(lines.join('\n'), /review-model/);
    }
  }
});

test('long chains keep all structured rows but bound inline rows and prefer unfinished work', () => {
  const snapshot = fixture(24, true);
  for (const row of snapshot.tasks.slice(0, 18)) { row.state = 'succeeded'; row.endedAt = snapshot.updatedAt; }
  snapshot.tasks[18].state = 'running';
  snapshot.tasks[18].startedAt = snapshot.updatedAt;
  const card = progressCard(snapshot);
  assert.equal(card.lines.length, 35);
  assert.match(card.lines.join('\n'), /#19 review \| running/);
  assert.match(card.lines.join('\n'), /#24 review \| queued/);
  assert.doesNotMatch(card.lines.join('\n'), /#1 review/);
  assert.match(card.lines.at(-1) ?? '', /16 tasks omitted/);
  assert.equal(snapshot.tasks.length, 24);
  const inspector = progressLines(snapshot, true).join('\n');
  assert.match(inspector, /#1 review/);
  assert.match(inspector, /#24 review/);
  assert.match(render({ progress: snapshot }, false, true).render(100).join('\n'), /#19 review/);
  for (const row of snapshot.tasks) { row.state = 'succeeded'; row.endedAt = snapshot.updatedAt; }
  snapshot.endedAt = snapshot.updatedAt;
  assert.equal(progressCard(snapshot).lines.length, 27);
  assert.match(progressCard(snapshot).lines.join('\n'), /#24 review/);
});

test('expanding a saved long-chain card exposes every task without using the latest inspector', () => {
  const saved = JSON.parse(JSON.stringify({ progress: fixture(24) }));
  const collapsed = render(saved).render(100).join('\n');
  assert.match(collapsed, /tasks omitted/);
  const expanded = render(saved, true).render(100).join('\n');
  assert.match(expanded, /#1 review/);
  assert.match(expanded, /#24 review/);
  assert.doesNotMatch(expanded, /tasks omitted|\/subagents: all tasks/);
});

test('absent and malformed snapshots retain all original output, and metadata strips controls', () => {
  for (const progress of [undefined, {}, { version: 2 }, { ...fixture(), tasks: [null] }, { ...fixture(), tasks: [{ ...fixture().tasks[0], usage: {} }] }]) {
    assert.match(render({ progress }).render(80).join('\n'), /FULL ORIGINAL OUTPUT/);
  }
  assert.match(render(undefined).render(80).join('\n'), /FULL ORIGINAL OUTPUT/);
  const snapshot = fixture();
  snapshot.tasks[0].model = '\x1b[31mred\n\u202etext';
  snapshot.tasks[0].observedModel = null;
  snapshot.tasks[0].role = '\x1b[31mreview';
  const text = render({ progress: snapshot }).render(80).join('\n');
  assert.match(text, /red text/);
  assert.doesNotMatch(text, /\x1b\[31m|\u202e/);
});

/** @param {import('node:test').TestContext} t */
function inspectorFixture(t) {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_WORKSPACE_ID;
  t.after(() => { if (workspace !== undefined) process.env.CMUX_WORKSPACE_ID = workspace; });
  /** @type {Parameters<import('@earendil-works/pi-coding-agent').ExtensionAPI['registerCommand']>[1] | undefined} */ let command;
  const pi = new Proxy(/** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({}), {
    get(_target, name) {
      assert.equal(name, 'registerCommand');
      return (/** @type {string} */ name, /** @type {NonNullable<typeof command>} */ value) => { assert.equal(name, 'subagents'); command = value; };
    },
  });
  const view = createProgressView(pi);
  view.begin('request');
  t.after(() => view.close());
  assert.ok(command);
  const registered = command;
  /** @type {import('@earendil-works/pi-tui').Component | undefined} */ let component;
  let renders = 0;
  let throwRefresh = false;
  /** @type {string[]} */ const notifications = [];
  const ui = new Proxy({}, {
    get(_target, name) {
      if (name === 'notify') return (/** @type {string} */ text) => notifications.push(text);
      assert.equal(name, 'custom', 'No widgets, footers or separate panes');
      return (/** @type {any} */ factory) => new Promise((resolve) => {
        component = factory({ terminal: { rows: 24 }, requestRender() { renders++; if (throwRefresh) throw new Error('Display closed'); } }, theme,
          { matches: (/** @type {string} */ data, /** @type {string} */ key) => {
            const defaults = { 'tui.select.cancel': 'escape', 'tui.select.down': 'down', 'tui.select.up': 'up', 'tui.select.pageDown': 'pageDown', 'tui.select.pageUp': 'pageUp' };
            return matchesKey(data, /** @type {any} */ (defaults[/** @type {keyof typeof defaults} */ (key)]));
          } }, () => resolve(undefined));
      });
    },
  });
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionCommandContext} */ ({ hasUI: true, mode: 'tui', ui });
  return { view, ctx, command: registered, notifications, renders: () => renders, throwRefresh: () => { throwRefresh = true; }, component: () => { assert.ok(component); return component; } };
}

test('/subagents opens without waiting for work, scrolls all chain rows, refreshes live, and closes without aborting', async (t) => {
  const f = inspectorFixture(t);
  await f.command.handler('', f.ctx);
  assert.deepEqual(f.notifications, ['No subagent request yet.']);
  const snapshot = fixture(24, true);
  f.view.publish(snapshot, f.ctx, 'request');
  const opening = f.command.handler('', f.ctx);
  const inspector = f.component();
  let lines = inspector.render(80);
  assert.match(lines.join('\n'), /#1 review/);
  assert.ok(lines.length <= 18);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.ok(inspector.handleInput);
  inspector.handleInput('\x1b[F');
  lines = inspector.render(80);
  assert.match(lines.join('\n'), /#24 review/);
  inspector.handleInput('\x1b[H');
  inspector.render(80);
  const refreshed = structuredClone(snapshot);
  refreshed.tasks[0].message = 'NEW PUBLIC UPDATE';
  f.view.publish(refreshed, f.ctx, 'request');
  assert.ok(f.renders() > 0);
  assert.match(inspector.render(80).join('\n'), /NEW PUBLIC UPDATE/);
  for (const width of [1, 12, 28]) assert.ok(inspector.render(width).every((line) => visibleWidth(line) <= width));
  f.throwRefresh();
  assert.doesNotThrow(() => f.view.publish(refreshed, f.ctx, 'request'));
  inspector.handleInput('\x1b');
  await opening;
  assert.equal(snapshot.tasks[0].state, 'running');
});

test('older concurrent calls cannot replace the latest request in the inspector', async (t) => {
  const f = inspectorFixture(t);
  const older = fixture();
  older.tasks[0].role = 'older';
  f.view.publish(older, f.ctx, 'request');
  const latest = fixture();
  latest.tasks[0].role = 'newer';
  f.view.begin('newer');
  f.view.publish(latest, f.ctx, 'newer');
  f.view.publish(older, f.ctx, 'request');
  await f.command.handler('raw', { ...f.ctx, mode: 'rpc' });
  assert.deepEqual(JSON.parse(f.notifications[0]), latest);
});

test('/subagents raw is public structured JSON, stays live, and RPC avoids custom UI', async (t) => {
  const f = inspectorFixture(t);
  const snapshot = fixture(12, true);
  f.view.publish(snapshot, f.ctx, 'request');
  const opening = f.command.handler('raw', f.ctx);
  const component = f.component();
  assert.match(component.render(100).join('\n'), /public snapshot JSON/);
  await f.view.close();
  await opening;
  const rpc = inspectorFixture(t);
  rpc.view.publish(snapshot, rpc.ctx, 'request');
  await rpc.command.handler('raw', { ...rpc.ctx, mode: 'rpc' });
  assert.deepEqual(JSON.parse(rpc.notifications[0]), snapshot);
  assert.doesNotMatch(rpc.notifications[0], /thinking|protocol|SECRET/);
});
