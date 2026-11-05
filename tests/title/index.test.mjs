import assert from 'node:assert/strict';
import test from 'node:test';
import title from '../../extensions/title/index.ts';
import { maxTitleLength, parseReply, sanitizeTitle, titleEntryType } from '../../extensions/title/naming.ts';

const opus = { provider: 'anthropic', id: 'claude-opus-5-5' };
const haiku = { provider: 'anthropic', id: 'claude-haiku-5-5' };
const sol = { provider: 'openai', id: 'gpt-6-sol' };

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @param {string} text */
function reply(text, stopReason = 'stop') {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason };
}

/**
 * A fake Pi with one session. `answer(call)` returns the model's reply for a request.
 * @param {{ name?: string, entries?: any[], branch?: any[], model?: any, hasUI?: boolean, withComplete?: boolean, haikuAuth?: boolean, answer?: (call: any) => any }} options
 */
function harness({ name, entries = [], branch = [], model = opus, hasUI = true, withComplete = true, haikuAuth = true, answer = () => reply('{"newTask":true,"title":"Fixing login redirect"}') } = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const appended = [];
  /** @type {string[]} */
  const notes = [];
  let sessionName = name;
  const emit = (/** @type {string} */ type, /** @type {any} */ event) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, ...event }, ctx);
  };
  const pi = {
    on(/** @type {string} */ type, /** @type {Function} */ handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    getSessionName: () => sessionName,
    setSessionName(/** @type {string} */ value) { sessionName = value; emit('session_info_changed', { name: value }); },
    appendEntry(/** @type {string} */ customType, /** @type {any} */ data) { appended.push({ customType, data }); },
  };
  const registry = {
    find: (/** @type {string} */ provider, /** @type {string} */ id) => [opus, haiku, sol].find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (/** @type {any} */ m) => m !== haiku || haikuAuth,
    ...(withComplete ? { async complete(/** @type {any} */ m, /** @type {any} */ context, /** @type {any} */ options) {
      const call = { model: m, context, options };
      calls.push(call);
      return answer(call);
    } } : {}),
  };
  const ctx = {
    hasUI,
    model,
    modelRegistry: registry,
    sessionManager: { getEntries: () => entries, getBranch: () => branch },
    ui: { notify: (/** @type {string} */ message) => notes.push(message) },
  };
  title(/** @type {any} */ (pi));
  emit('session_start', { reason: 'startup' });
  return {
    calls, appended, notes,
    name: () => sessionName,
    rename(/** @type {string | undefined} */ value) { sessionName = value; emit('session_info_changed', { name: value }); },
    async type(/** @type {string} */ text) {
      emit('input', { text, source: 'interactive' });
      await flush();
    },
    emit,
  };
}

test('names an unnamed session from the first prompt with Haiku', async () => {
  const pi = harness({ branch: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } }] });
  await pi.type('the login page redirects to /404 after sign in');
  assert.equal(pi.name(), 'Fixing login redirect');
  assert.deepEqual(pi.appended, [{ customType: titleEntryType, data: { title: 'Fixing login redirect' } }]);
  assert.equal(pi.calls.length, 1);
  assert.deepEqual(pi.calls[0].model, haiku);
  const prompt = pi.calls[0].context.messages[0].content;
  assert.match(prompt, /Current title: none/);
  assert.match(prompt, /Earlier answer/);
  assert.match(prompt, /redirects to \/404/);
});

test('keeps the title while the task continues and renames on a new task', async () => {
  const answers = ['{"newTask":true,"title":"Fixing login redirect"}', '{"newTask":false,"title":null}', '{"newTask":false,"title":"Fixing the redirect"}', '{"newTask":true,"title":"Committing current changes"}'];
  const pi = harness({ answer: () => reply(answers.shift() ?? '') });
  await pi.type('fix the login redirect');
  await pi.type('yes do it');
  assert.equal(pi.name(), 'Fixing login redirect');
  await pi.type('also check the logout link');
  assert.equal(pi.name(), 'Fixing login redirect');
  await pi.type('commit and push');
  assert.equal(pi.name(), 'Committing current changes');
  assert.match(pi.calls[3].context.messages[0].content, /Current title: Fixing login redirect/);
});

test('leaves a hand-set name alone until it is cleared', async () => {
  const pi = harness({ name: 'Release prep' });
  await pi.type('bump the version');
  assert.equal(pi.calls.length, 0);
  assert.equal(pi.name(), 'Release prep');
  pi.rename(undefined);
  await pi.type('bump the version');
  assert.equal(pi.name(), 'Fixing login redirect');
});

test('a resumed session keeps renaming the name it set before', async () => {
  const pi = harness({ name: 'Fixing login redirect', entries: [{ type: 'custom', customType: titleEntryType, data: { title: 'Fixing login redirect' } }], answer: () => reply('{"newTask":true,"title":"Writing release notes"}') });
  await pi.type('now write the release notes');
  assert.equal(pi.name(), 'Writing release notes');
});

test('a newer prompt replaces a request still in flight', async () => {
  /** @type {Array<(value: any) => void>} */
  const pending = [];
  const pi = harness({ answer: (call) => new Promise((resolve) => {
    pending.push(resolve);
    call.options.signal.addEventListener('abort', () => resolve(reply('', 'aborted')));
  }) });
  await pi.type('first task');
  await pi.type('second task');
  assert.equal(pi.calls[0].options.signal.aborted, true);
  pending[1](reply('{"newTask":true,"title":"Doing the second task"}'));
  await flush();
  assert.equal(pi.name(), 'Doing the second task');
  assert.deepEqual(pi.notes, []);
});

test('a /name during a request wins', async () => {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const pi = harness({ answer: () => new Promise((r) => { resolve = r; }) });
  await pi.type('fix the login redirect');
  pi.rename('My name');
  resolve(reply('{"newTask":true,"title":"Fixing login redirect"}'));
  await flush();
  assert.equal(pi.name(), 'My name');
  assert.deepEqual(pi.appended, []);
});

test('does nothing without a UI, without typed input, or on Pi without ModelRegistry.complete', async () => {
  const headless = harness({ hasUI: false });
  await headless.type('fix it');
  assert.equal(headless.calls.length, 0);

  const extension = harness();
  extension.emit('input', { text: 'from an extension', source: 'extension' });
  await flush();
  assert.equal(extension.calls.length, 0);

  const oldPi = harness({ withComplete: false });
  await oldPi.type('fix it');
  assert.equal(oldPi.name(), undefined);
  assert.deepEqual(oldPi.notes, []);
});

test('uses the session model when the provider has no small model or Haiku has no login', async () => {
  const openai = harness({ model: sol });
  await openai.type('fix it');
  assert.deepEqual(openai.calls[0].model, sol);
  const noHaiku = harness({ haikuAuth: false });
  await noHaiku.type('fix it');
  assert.deepEqual(noHaiku.calls[0].model, opus);
});

test('warns once per session when naming fails and keeps the old name', async () => {
  const pi = harness({ answer: () => reply('', 'error') });
  await pi.type('one');
  await pi.type('two');
  assert.equal(pi.notes.length, 1);
  assert.match(pi.notes[0], /could not name this session/);
  assert.equal(pi.name(), undefined);
  const garbled = harness({ answer: () => reply('I think the title is X') });
  await garbled.type('one');
  assert.equal(garbled.name(), undefined);
  assert.deepEqual(garbled.notes, []);
});

test('parseReply reads JSON inside prose or fences and rejects other shapes', () => {
  assert.deepEqual(parseReply('```json\n{"newTask": true, "title": "Fixing tests"}\n```'), { newTask: true, title: 'Fixing tests' });
  assert.deepEqual(parseReply('Sure: {"newTask": false, "title": null}'), { newTask: false, title: undefined });
  assert.equal(parseReply('{"newTask": "yes", "title": "x"}'), undefined);
  assert.equal(parseReply('{"title": "x"}'), undefined);
  assert.equal(parseReply('no json'), undefined);
});

test('sanitizeTitle strips terminal escapes, quotes, and a trailing period, and caps the length', () => {
  assert.equal(sanitizeTitle('"Fixing\u001b[31m login\u001b[0m\nredirect."'), 'Fixing login redirect');
  assert.equal(sanitizeTitle('  \u0007 '), undefined);
  const long = sanitizeTitle('Refactoring '.repeat(10));
  assert.equal(long?.length, maxTitleLength);
  assert.ok(long?.endsWith('…'));
});
