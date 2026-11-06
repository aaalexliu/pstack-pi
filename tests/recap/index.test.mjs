import assert from 'node:assert/strict';
import test from 'node:test';
import recap, { idleMs } from '../../extensions/recap/index.ts';
import { cleanRecap, maxRecapLength, needsRecap, recapEntryType, transcript } from '../../extensions/recap/summary.ts';

const opus = { provider: 'anthropic', id: 'claude-opus-5-5' };
const haiku = { provider: 'anthropic', id: 'claude-haiku-5-5' };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = { fg: (/** @type {string} */ _c, /** @type {string} */ t) => t, bold: (/** @type {string} */ t) => t, italic: (/** @type {string} */ t) => t };

/** @param {string} text */
const reply = (text, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason });
/** @param {string} role @param {any} content */
const message = (role, content) => ({ type: 'message', message: { role, content } });

const conversation = () => [
  message('user', 'commit and push the dotfiles'),
  message('assistant', [{ type: 'text', text: 'Pushing now.' }, { type: 'toolCall', name: 'bash', arguments: { command: 'git push origin main' } }]),
  { type: 'message', message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] } },
  message('assistant', [{ type: 'text', text: 'Pushed d975120 to main.' }]),
];

/**
 * A fake Pi with one session whose branch grows as entries are appended.
 * @param {{ mode?: string, idle?: boolean, withComplete?: boolean, branch?: any[], answer?: (call: any) => any }} options
 */
function harness({ mode = 'tui', idle = true, withComplete = true, branch = conversation(), answer = () => reply('The goal was to push the dotfiles, and it is done. Next, run the rebuild.') } = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {Map<string, Function>} */
  const renderers = new Map();
  /** @type {any[]} */
  const calls = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Array<string | undefined>} */
  const statuses = [];
  const ctx = {
    mode,
    model: opus,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    modelRegistry: {
      find: (/** @type {string} */ provider, /** @type {string} */ id) => [opus, haiku].find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: () => true,
      ...(withComplete ? { async complete(/** @type {any} */ model, /** @type {any} */ context, /** @type {any} */ options) {
        const call = { model, context, options };
        calls.push(call);
        return answer(call);
      } } : {}),
    },
    sessionManager: { getBranch: () => branch },
    ui: { theme: plain, notify: (/** @type {string} */ text) => notes.push(text), setStatus: (/** @type {string} */ _key, /** @type {string | undefined} */ text) => statuses.push(text) },
  };
  const pi = {
    on(/** @type {string} */ type, /** @type {Function} */ handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    registerCommand(/** @type {string} */ name, /** @type {any} */ command) { commands.set(name, command); },
    registerEntryRenderer(/** @type {string} */ type, /** @type {Function} */ renderer) { renderers.set(type, renderer); },
    getSessionName: () => 'Committing current changes',
    appendEntry(/** @type {string} */ customType, /** @type {any} */ data) { branch.push({ type: 'custom', customType, data }); },
  };
  recap(/** @type {any} */ (pi));
  const emit = (/** @type {string} */ type, /** @type {any} */ event = {}) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, ...event }, ctx);
  };
  emit('session_start', { reason: 'startup' });
  return {
    branch, calls, notes, statuses, emit, renderers,
    recaps: () => branch.filter((entry) => entry.customType === recapEntryType).map((entry) => entry.data.text),
    run: (/** @type {string} */ name) => commands.get(name).handler('', ctx),
  };
}

test('writes one recap with Haiku three minutes after a run settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = harness();
  pi.emit('agent_settled');
  t.mock.timers.tick(idleMs - 1);
  assert.equal(pi.calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(pi.recaps(), ['The goal was to push the dotfiles, and it is done. Next, run the rebuild.']);
  assert.deepEqual(pi.calls[0].model, haiku);
  const prompt = pi.calls[0].context.messages[0].content;
  assert.match(prompt, /Session title: Committing current changes/);
  assert.match(prompt, /User: commit and push the dotfiles/);
  assert.match(prompt, /\[tool bash\] git push origin main/);
  assert.match(prompt, /Assistant: Pushed d975120 to main\./);
  assert.equal(pi.statuses.at(-1), undefined);

  pi.emit('agent_settled');
  t.mock.timers.tick(idleMs);
  await flush();
  assert.equal(pi.calls.length, 1, 'no new conversation since the last recap');
});

test('typing, a shell command, or a new run before the delay cancels the recap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const event of ['input', 'user_bash', 'agent_start']) {
    const pi = harness();
    pi.emit('agent_settled');
    t.mock.timers.tick(idleMs / 2);
    pi.emit(event);
    t.mock.timers.tick(idleMs);
    await flush();
    assert.equal(pi.calls.length, 0, event);
  }
});

test('typing while the recap is being written drops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const pi = harness({ answer: (call) => new Promise((r) => {
    resolve = r;
    call.options.signal.addEventListener('abort', () => r(reply('', 'aborted')));
  }) });
  pi.emit('agent_settled');
  t.mock.timers.tick(idleMs);
  await flush();
  pi.emit('input', { text: 'next task', source: 'interactive' });
  resolve(reply('Too late.'));
  await flush();
  assert.deepEqual(pi.recaps(), []);
  assert.deepEqual(pi.notes, []);
  assert.equal(pi.statuses.at(-1), undefined);
});

test('/recap writes one now and refuses while the agent works', async () => {
  const pi = harness();
  await pi.run('recap');
  assert.equal(pi.recaps().length, 1);
  await pi.run('recap');
  assert.equal(pi.recaps().length, 2, 'a manual recap runs even with nothing new');

  const busy = harness({ idle: false });
  await busy.run('recap');
  assert.equal(busy.calls.length, 0);
  assert.match(busy.notes[0], /wait until the agent finishes/);

  const empty = harness({ branch: [] });
  await empty.run('recap');
  assert.match(empty.notes[0], /no conversation/);

  const oldPi = harness({ withComplete: false });
  await oldPi.run('recap');
  assert.match(oldPi.notes[0], /cannot call a model/);
});

test('never arms outside the TUI or on Pi without ModelRegistry.complete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const pi of [harness({ mode: 'print' }), harness({ mode: 'rpc' }), harness({ withComplete: false })]) {
    pi.emit('agent_settled');
    t.mock.timers.tick(idleMs);
    await flush();
    assert.deepEqual(pi.recaps(), []);
    assert.deepEqual(pi.notes, []);
  }
});

test('a failed automatic recap warns once per session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = harness({ answer: () => reply('', 'error') });
  for (let run = 0; run < 2; run++) {
    pi.branch.push(message('user', `prompt ${run}`));
    pi.emit('agent_settled');
    t.mock.timers.tick(idleMs);
    await flush();
  }
  assert.equal(pi.calls.length, 2);
  assert.equal(pi.notes.length, 1);
  assert.match(pi.notes[0], /could not write a recap/);
});

test('the renderer draws a dim recap line and skips malformed entries', () => {
  const pi = harness();
  const render = /** @type {Function} */ (pi.renderers.get(recapEntryType));
  const component = render({ type: 'custom', customType: recapEntryType, data: { text: 'The goal was X. Next, Y.' } }, { expanded: false }, plain);
  assert.deepEqual(component.render(80).map((/** @type {string} */ line) => line.trim()), ['※ recap: The goal was X. Next, Y.']);
  assert.equal(render({ type: 'custom', customType: recapEntryType, data: {} }, { expanded: false }, plain), undefined);
});

test('needsRecap looks for conversation after the last recap', () => {
  const recapEntry = { type: 'custom', customType: recapEntryType, data: { text: 'x' } };
  assert.equal(needsRecap([]), false);
  assert.equal(needsRecap(conversation()), true);
  assert.equal(needsRecap([...conversation(), recapEntry]), false);
  assert.equal(needsRecap([...conversation(), recapEntry, { type: 'custom', customType: 'other' }]), false);
  assert.equal(needsRecap([...conversation(), recapEntry, message('user', 'more')]), true);
});

test('transcript keeps the newest 12,000 characters and failed tool output', () => {
  const branch = [
    message('user', 'old '.repeat(4000)),
    message('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Latest answer' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }]),
    { type: 'message', message: { role: 'toolResult', toolName: 'read', isError: true, content: [{ type: 'text', text: 'ENOENT a.ts' }] } },
  ];
  const text = transcript(branch, undefined);
  assert.ok(text.length <= 12_000);
  assert.doesNotMatch(text, /hidden|Session title/);
  assert.match(text, /Assistant: Latest answer\n\n\[tool read\] \{"path":"a.ts"\}\n\n\[tool read failed\] ENOENT a.ts$/);
  assert.equal(transcript([{ type: 'custom', customType: 'x' }], 'Name'), '');
});

test('cleanRecap strips a label, quotes, and escapes, and caps the length', () => {
  assert.equal(cleanRecap('**Recap:** "The goal was X.\u001b[31m\nNext, Y."'), 'The goal was X. Next, Y.');
  assert.equal(cleanRecap('  \u0007 '), undefined);
  const long = cleanRecap('word '.repeat(200));
  assert.equal(long?.length, maxRecapLength);
  assert.ok(long?.endsWith('…'));
});
