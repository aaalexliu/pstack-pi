import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import idleCompaction, { summaryTimeoutMs } from '../../extensions/idle-compaction/index.ts';
import { noticeEntryType } from '../../extensions/idle-compaction/summary.ts';
import { settingsPath } from '../../extensions/shared/settings.ts';

const minute = 60_000;
const start = Date.UTC(2026, 0, 5, 14, 0);
const sonnet = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-sonnet-5-5', contextWindow: 1_000_000, promptCache: { short: 300, long: 3600 } };
const plain = { fg: (/** @type {string} */ _c, /** @type {string} */ t) => t, bold: (/** @type {string} */ t) => t, italic: (/** @type {string} */ t) => t };
const flush = async () => {
  for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
};

const summary = [
  '## Goal',
  'Ship idle compaction for Pi.',
  '',
  '## Constraints & Preferences',
  '- Plain dashes only.',
  '',
  '## Progress',
  '### Done',
  '- [x] Wrote the plan.',
  '',
  '## Key Decisions',
  '- **Summary first**: typing during it stays cheap.',
  '',
  '## Next Steps',
  '1. Run the tests.',
  '',
  '## Critical Context',
  '- extensions/idle-compaction/index.ts',
].join('\n');

const replayUsage = { input: 1_000, cacheRead: 245_000, cacheWrite: 4_000, output: 800, totalTokens: 250_800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** @param {string} text @param {any} [extra] */
const answer = (text = `Here is the checkpoint.\n\n${summary}\n\`\`\``, extra = {}) => ({
  role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: replayUsage, timestamp: 0, ...extra,
});

/** @param {Array<[string, string]>} calls */
const toolUse = (...calls) => ({
  role: 'assistant', content: calls.map(([name, file], index) => ({ type: 'toolCall', id: `t${index}`, name, arguments: { path: file } })), stopReason: 'toolUse', usage: replayUsage, timestamp: 0,
});

/** @param {Array<[string, string]>} calls */
const codemodeResult = (...calls) => ({
  role: 'toolResult', toolCallId: 't0', toolName: 'codemode', content: [], isError: false, timestamp: 0,
  nestedCalls: { complete: true, calls: calls.map(([name, file]) => ({ name, arguments: { path: file } })) },
});

function pendingAnswer() {
  const pending = {
    /** @type {AbortSignal | undefined} */ signal: undefined,
    /** @type {(value: any) => void} */ finish: () => {},
    /** @param {any} call */
    respond(call) {
      pending.signal = call.options.signal;
      return new Promise((resolve) => {
        pending.finish = resolve;
        call.options.signal.addEventListener('abort', () => resolve(answer('', { stopReason: 'aborted' })));
      });
    },
  };
  return pending;
}

const envKeys = ['PI_CODING_AGENT_DIR', 'PI_CACHE_RETENTION', 'PSTACK_IDLE_COMPACT_MIN_TOKENS'];

/** @param {string} key @param {string | undefined} value */
function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * A fake Pi whose `ctx.compact()` runs the registered `session_before_compact` handlers like
 * Pi's `AgentSession.compact()`, and runs a recorded stand-in for Pi's own summarizer when no
 * handler returns a compaction.
 * @param {import('node:test').TestContext} t
 * @param {{ mode?: string, withStreamSimple?: boolean, withGetSettings?: boolean, retention?: string, minTokens?: string, settingsText?: string, model?: any, thinkingLevel?: string, respond?: (call: any) => any }} [options]
 */
async function harness(t, { mode = 'tui', withStreamSimple = true, withGetSettings = true, retention = 'long', minTokens, settingsText, model = sonnet, thinkingLevel = 'low', respond = () => answer() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pstack-idle-'));
  const saved = envKeys.map((key) => [key, process.env[key]]);
  t.after(async () => {
    for (const [key, value] of saved) setEnv(/** @type {string} */ (key), value);
    await rm(dir, { recursive: true, force: true });
  });
  setEnv('PI_CODING_AGENT_DIR', dir);
  setEnv('PI_CACHE_RETENTION', retention);
  setEnv('PSTACK_IDLE_COMPACT_MIN_TOKENS', minTokens);
  if (settingsText !== undefined) {
    await mkdir(path.dirname(settingsPath(dir)), { recursive: true });
    await writeFile(settingsPath(dir), settingsText);
  }

  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {Map<string, Function>} */
  const renderers = new Map();
  /** @type {any[]} */
  const branch = [];
  /** @type {any[]} */
  const replays = [];
  /** @type {Array<string | undefined>} */
  const compactCalls = [];
  /** @type {Array<string | undefined>} */
  const piSummaries = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Array<string | undefined>} */
  const statuses = [];
  const state = {
    idle: true,
    autoCompaction: true,
    brokenPreparation: false,
    /** @type {(() => void) | undefined} */
    beforeCompact: undefined,
  };
  let nextId = 0;
  /** @param {any} entry */
  const add = (entry) => {
    const added = { id: `e${++nextId}`, ...entry };
    branch.push(added);
    return added;
  };

  /** @param {'manual' | 'threshold' | 'overflow'} reason @param {string | undefined} customInstructions */
  const runCompaction = async (reason, customInstructions) => {
    state.beforeCompact?.();
    const preparation = state.brokenPreparation ? undefined : {
      firstKeptEntryId: branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'user').id,
      tokensBefore: 250_000,
    };
    /** @type {any} */
    let result;
    for (const handler of handlers.get('session_before_compact') ?? []) {
      try {
        const value = await handler({ type: 'session_before_compact', preparation, branchEntries: [...branch], customInstructions, reason, willRetry: false, signal: new AbortController().signal }, ctx);
        if (value) result = value;
        if (value?.cancel) break;
      } catch {}
    }
    if (result?.cancel) throw new Error('Compaction cancelled');
    if (!result?.compaction) piSummaries.push(customInstructions);
    const compaction = result?.compaction ?? { summary: 'Pi summary', firstKeptEntryId: preparation?.firstKeptEntryId, tokensBefore: preparation?.tokensBefore, details: { readFiles: [], modifiedFiles: [] } };
    add({ type: 'compaction', ...compaction, fromHook: Boolean(result?.compaction) });
    return compaction;
  };

  const ctx = {
    mode,
    model,
    thinkingLevel,
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    modelRegistry: withStreamSimple ? {
      streamSimple(/** @type {any} */ chosen, /** @type {any} */ context, /** @type {any} */ options) {
        const call = { model: chosen, context, options };
        replays.push(call);
        return { result: async () => respond(call) };
      },
    } : {},
    sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' },
    ui: {
      theme: plain,
      notify: (/** @type {string} */ text) => notes.push(text),
      setStatus: (/** @type {string} */ _key, /** @type {string | undefined} */ text) => statuses.push(text),
    },
    compact(/** @type {any} */ options = {}) {
      compactCalls.push(options.customInstructions);
      void (async () => {
        await Promise.resolve();
        try { options.onComplete?.(await runCompaction('manual', options.customInstructions)); }
        catch (error) { options.onError?.(error); }
      })();
    },
  };
  const pi = {
    on(/** @type {string} */ type, /** @type {Function} */ handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    registerCommand(/** @type {string} */ name, /** @type {any} */ command) { commands.set(name, command); },
    registerEntryRenderer(/** @type {string} */ type, /** @type {Function} */ renderer) { renderers.set(type, renderer); },
    appendEntry(/** @type {string} */ customType, /** @type {any} */ data) { add({ type: 'custom', customType, data }); },
    ...(withGetSettings ? { getSettings: () => ({ compaction: { enabled: state.autoCompaction } }) } : {}),
  };
  idleCompaction(/** @type {any} */ (pi));

  /** @param {string} type @param {any} [event] */
  const emit = async (type, event = {}) => {
    const results = [];
    for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
    return results;
  };

  const system = { role: 'system', sections: [{ id: 'base', text: 'You are Pi.' }], toolsAdded: [{ name: 'bash' }] };
  /** @param {{ tokens?: number, durationMs?: number, stopReason?: string, content?: any[], aborted?: boolean }} [options] */
  const run = async ({ tokens = 250_000, durationMs = 0, stopReason = 'stop', content = [{ type: 'text', text: 'Done.' }], aborted = false } = {}) => {
    await emit('input', { text: 'next step', source: 'interactive' });
    add({ type: 'message', message: { role: 'user', content: 'next step', timestamp: Date.now() } });
    await emit('agent_start');
    const since = branch.slice(branch.findLastIndex((entry) => entry.type === 'compaction') + 1);
    const messages = [system, ...since.filter((entry) => entry.type === 'message').map((entry) => entry.message)];
    const startedAt = Date.now();
    await emit('context_with_system', { messages });
    t.mock.timers.tick(durationMs);
    const usage = { input: 10, cacheRead: tokens - 1_010, cacheWrite: 500, output: 500, totalTokens: tokens };
    const reply = { role: 'assistant', content, stopReason, usage, timestamp: Date.now() };
    add({ type: 'message', message: reply });
    await emit('agent_settled', { aborted });
    return { messages, reply, startedAt };
  };

  await emit('session_start', { reason: 'startup' });
  return {
    dir, branch, replays, compactCalls, piSummaries, notes, statuses, renderers, state, emit, run, runCompaction, add,
    tick: (/** @type {number} */ ms) => t.mock.timers.tick(ms),
    command: (/** @type {string} */ args) => commands.get('idle-compaction').handler(args, ctx),
    compactions: () => branch.filter((entry) => entry.type === 'compaction'),
    notices: () => branch.filter((entry) => entry.customType === noticeEntryType).map((entry) => entry.data),
    status: async () => {
      await commands.get('idle-compaction').handler('status', ctx);
      return notes.pop() ?? '';
    },
  };
}

test('compacts 54 minutes after the last request started by replaying the cached request', async (t) => {
  const pi = await harness(t);
  pi.add({ type: 'message', message: toolUse(['read', 'src/a.ts'], ['read', 'src/b.ts'], ['edit', 'src/b.ts'], ['bash', 'ignored.ts']) });
  pi.add({ type: 'message', message: codemodeResult(['write', 'src/c.ts'], ['read', 'docs/settings.md']) });
  const { messages, reply, startedAt } = await pi.run({ durationMs: 10 * minute });
  pi.tick(44 * minute - 1);
  await flush();
  assert.equal(pi.replays.length, 0, 'nothing before 54 minutes');
  pi.tick(1);
  await flush();

  assert.equal(pi.replays.length, 1);
  const [{ model, context, options }] = pi.replays;
  assert.equal(model, sonnet);
  assert.deepEqual(Object.keys(context), ['messages']);
  assert.deepEqual(context.messages.slice(0, -1), [...messages, reply], 'the transcript as sent, then the reply');
  const instruction = context.messages.at(-1);
  assert.equal(instruction.role, 'user');
  assert.equal(instruction.timestamp, startedAt + 54 * minute);
  assert.match(instruction.content, /Do not call any tool/);
  assert.match(instruction.content, /replace every message above except your own last reply/);
  assert.match(instruction.content, /Your last reply stays verbatim right after the summary, so do not restate it\./);
  assert.match(instruction.content, /The system prompt also stays in place, so leave its instructions out/);
  assert.deepEqual(Object.keys(options).sort(), ['reasoning', 'sessionId', 'signal'], 'no maxTokens, toolChoice, tools, systemPrompt, or cacheRetention');
  assert.equal(options.reasoning, 'low');
  assert.equal(options.sessionId, 'session-1');

  const [compaction] = pi.compactions();
  assert.equal(compaction.firstKeptEntryId, pi.branch.find((entry) => entry.message === reply).id, 'keeps only the last reply after the summary');
  assert.equal(compaction.tokensBefore, 250_000);
  assert.deepEqual(compaction.usage, replayUsage);
  assert.deepEqual(compaction.details, { trigger: 'idle', readFiles: ['docs/settings.md', 'src/a.ts'], modifiedFiles: ['src/b.ts', 'src/c.ts'] });
  assert.equal(compaction.summary, `${summary}\n\n<read-files>\ndocs/settings.md\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>`);
  assert.deepEqual(pi.piSummaries, [], "Pi's uncached summarizer never ran");
  assert.deepEqual(pi.notices(), [{ tokensBefore: 250_000, cacheRead: 245_000, cacheWrite: 4_000, input: 1_000, idleMinutes: 54 }]);
  assert.deepEqual(pi.statuses, ['※ compacting while idle…', undefined]);
  assert.deepEqual(pi.notes, []);
  assert.match(await pi.status(), /^Idle compaction: on\. Not armed: compacted while idle at \d\d:\d\d\./);
});

test('the notice renderer draws a dim line and skips malformed entries', async (t) => {
  const pi = await harness(t);
  const render = /** @type {Function} */ (pi.renderers.get(noticeEntryType));
  const data = { tokensBefore: 212_400, cacheRead: 245_000, cacheWrite: 4_000, input: 1_000, idleMinutes: 54 };
  const component = render({ type: 'custom', customType: noticeEntryType, data }, { expanded: false }, plain);
  assert.deepEqual(component.render(200).map((/** @type {string} */ line) => line.trim()).filter(Boolean),
    ['※ Compacted while idle, before the prompt cache expired (54 min idle, 212,400 tokens, 98% read from cache)']);
  assert.equal(render({ type: 'custom', customType: noticeEntryType, data: { tokensBefore: 'x' } }, { expanded: false }, plain), undefined);
  assert.equal(render({ type: 'custom', customType: noticeEntryType, data: null }, { expanded: false }, plain), undefined);
});

test('never arms when a rule fails, and says which rule', async (t) => {
  const openai = { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5', contextWindow: 400_000 };
  /** @type {Array<[string, any, any, RegExp]>} */
  const cases = [
    ['5-minute cache tier', { retention: 'short' }, {}, /Pi uses the 5-minute prompt cache\. Start Pi with PI_CACHE_RETENTION=long/],
    ['model without promptCache.long', { model: { ...sonnet, promptCache: { short: 300 } } }, {}, /claude-sonnet-5-5 has no one-hour prompt cache/],
    ['OpenAI model', { model: openai }, {}, /gpt-5\.5 has no one-hour prompt cache/],
    ['below the default threshold', {}, { tokens: 143_210 }, /143,210 tokens is below the 200,000-token threshold \(PSTACK_IDLE_COMPACT_MIN_TOKENS\)/],
    ['below an env threshold', { minTokens: '300000' }, {}, /250,000 tokens is below the 300,000-token threshold/],
    ['env threshold under the 100,000 floor', { minTokens: '50000' }, { tokens: 80_000 }, /80,000 tokens is below the 100,000-token threshold/],
    ['print mode', { mode: 'print' }, {}, /only in the interactive TUI/],
    ['rpc mode', { mode: 'rpc' }, {}, /only in the interactive TUI/],
    ['json mode', { mode: 'json' }, {}, /only in the interactive TUI/],
    ['turned off in settings', { settingsText: '{"version":1,"idleCompaction":false}' }, {}, /^Idle compaction: off\. Not armed: turned off/],
    ['aborted run', {}, { aborted: true }, /the last run was stopped/],
    ['length stop', {}, { stopReason: 'length' }, /did not end on a plain answer/],
    ['error stop', {}, { stopReason: 'error' }, /did not end on a plain answer/],
    ['tool call', {}, { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }] }, /did not end on a plain answer/],
  ];
  for (const [name, options, run, expected] of cases) {
    await t.test(name, async (t) => {
      const pi = await harness(t, options);
      await pi.run(run);
      assert.match(await pi.status(), expected);
      pi.tick(60 * minute);
      await flush();
      assert.equal(pi.replays.length, 0);
      assert.deepEqual(pi.notes, []);
    });
  }

  await t.test("Pi's compaction.enabled false", async (t) => {
    const pi = await harness(t);
    pi.state.autoCompaction = false;
    await pi.run();
    assert.match(await pi.status(), /Pi's auto-compaction is off/);
    pi.tick(60 * minute);
    await flush();
    assert.equal(pi.replays.length, 0);
  });

  await t.test('PSTACK_IDLE_COMPACT_MIN_TOKENS lowers the threshold', async (t) => {
    const pi = await harness(t, { minTokens: '100000' });
    await pi.run({ tokens: 143_210 });
    assert.match(await pi.status(), /^Idle compaction: on\. Armed\. Compacts at \d\d:\d\d \(in 54 min\) if this session stays idle\.\nSetting: .*settings\.json$/);
    pi.tick(54 * minute);
    await flush();
    assert.equal(pi.compactions().length, 1);
  });
});

test('thinking off replays with no reasoning option, as Pi sends it', async (t) => {
  const pi = await harness(t, { thinkingLevel: 'off' });
  await pi.run();
  pi.tick(54 * minute);
  await flush();
  assert.equal(pi.replays[0].options.reasoning, undefined);
});

test('activity before 54 minutes cancels the timer', async (t) => {
  /** @type {Array<[string, (pi: any) => Promise<unknown>]>} */
  const cases = [
    ...['input', 'user_bash', 'agent_start', 'model_select', 'thinking_level_select', 'session_before_tree', 'session_shutdown']
      .map((type) => /** @type {[string, (pi: any) => Promise<unknown>]} */ ([type, (pi) => pi.emit(type)])),
    ['a new request', (pi) => pi.emit('context_with_system', { messages: [] })],
    ['/idle-compaction off', (pi) => pi.command('off')],
  ];
  for (const [name, act] of cases) {
    await t.test(name, async (t) => {
      const pi = await harness(t);
      await pi.run();
      pi.tick(30 * minute);
      await act(pi);
      pi.tick(30 * minute);
      await flush();
      assert.equal(pi.replays.length, 0);
    });
  }
});

test('activity during the summary aborts it without compacting or warning', async (t) => {
  /** @type {Array<[string, (pi: any) => Promise<unknown>]>} */
  const cases = [
    ...['input', 'user_bash', 'agent_start', 'model_select', 'thinking_level_select', 'session_before_tree', 'session_shutdown']
      .map((type) => /** @type {[string, (pi: any) => Promise<unknown>]} */ ([type, (pi) => pi.emit(type)])),
    ['a new request', (pi) => pi.emit('context_with_system', { messages: [] })],
    ['/idle-compaction off', (pi) => pi.command('off')],
    ['a user /compact', (pi) => pi.runCompaction('manual', 'keep it short')],
  ];
  for (const [name, act] of cases) {
    await t.test(name, async (t) => {
      const pending = pendingAnswer();
      const pi = await harness(t, { respond: pending.respond });
      await pi.run();
      pi.tick(54 * minute);
      await flush();
      assert.equal(pi.replays.length, 1);
      await act(pi);
      assert.equal(pending.signal?.aborted, true, 'replay request aborted');
      pending.finish(answer());
      await flush();
      assert.deepEqual(pi.compactCalls, []);
      assert.equal(pi.notices().length, 0);
      assert.deepEqual(pi.notes.filter((note) => note.startsWith('[idle-compaction]')), []);
      assert.equal(pi.statuses.at(-1), undefined);
    });
  }
});

test("a user's /compact during the summary still runs Pi's summarizer with the user's instructions", async (t) => {
  const pending = pendingAnswer();
  const pi = await harness(t, { respond: pending.respond });
  await pi.run();
  pi.tick(54 * minute);
  await flush();
  await pi.runCompaction('manual', 'keep it short');
  assert.deepEqual(pi.piSummaries, ['keep it short']);
});

test('/compact and threshold compactions pass through and cancel an armed timer', async (t) => {
  for (const [reason, instructions] of /** @type {const} */ ([['manual', 'keep it short'], ['threshold', undefined], ['overflow', undefined]])) {
    await t.test(reason, async (t) => {
      const pi = await harness(t);
      await pi.run();
      await pi.runCompaction(reason, instructions);
      assert.deepEqual(pi.piSummaries, [instructions]);
      assert.equal(pi.compactions()[0].summary, 'Pi summary');
      pi.tick(60 * minute);
      await flush();
      assert.equal(pi.replays.length, 0);
    });
  }
});

test('recap and other custom entries after the reply do not block firing, but conversation does', async (t) => {
  await t.test('recap entry', async (t) => {
    const pi = await harness(t);
    await pi.run();
    pi.tick(3 * minute);
    pi.add({ type: 'custom', customType: 'pstack-recap', data: { text: 'The goal was X.' } });
    pi.add({ type: 'label', targetId: 'e1', label: 'checkpoint' });
    pi.tick(51 * minute);
    await flush();
    assert.equal(pi.compactions().length, 1);
  });
  for (const entry of [
    { type: 'custom_message', customType: 'note', content: 'remember this', display: true },
    { type: 'message', message: { role: 'user', content: 'sent from elsewhere', timestamp: 0 } },
    { type: 'some_future_entry' },
  ]) {
    await t.test(entry.type, async (t) => {
      const pi = await harness(t);
      await pi.run();
      pi.add(entry);
      pi.tick(54 * minute);
      await flush();
      assert.equal(pi.replays.length, 0);
    });
  }
});

test('a conversation that moves during the summary or the hand-off is never compacted', async (t) => {
  await t.test('during the summary', async (t) => {
    const pending = pendingAnswer();
    const pi = await harness(t, { respond: pending.respond });
    await pi.run();
    pi.tick(54 * minute);
    await flush();
    pi.add({ type: 'custom_message', customType: 'note', content: 'late', display: true });
    pending.finish(answer());
    await flush();
    assert.deepEqual(pi.compactCalls, []);
  });
  await t.test('between ctx.compact and session_before_compact', async (t) => {
    const pi = await harness(t);
    await pi.run();
    pi.state.beforeCompact = () => pi.add({ type: 'custom_message', customType: 'note', content: 'late', display: true });
    pi.tick(54 * minute);
    await flush();
    assert.equal(pi.compactCalls.length, 1);
    assert.equal(pi.compactions().length, 0);
    assert.deepEqual(pi.piSummaries, []);
    assert.deepEqual(pi.notes, []);
  });
});

test('a timer that runs after the cache may have expired does nothing', async (t) => {
  const pi = await harness(t);
  const { startedAt } = await pi.run();
  t.mock.timers.setTime(startedAt + 58 * minute);
  pi.tick(0);
  await flush();
  assert.equal(pi.replays.length, 0);
  assert.match(await pi.status(), /may have expired.*asleep/);
});

test('a reply that is not a summary never reaches ctx.compact and warns once', async (t) => {
  const toolCall = { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } };
  /** @type {Array<[string, any, RegExp]>} */
  const cases = [
    ['tool call stop', answer(summary, { stopReason: 'toolUse', content: [toolCall] }), /tool call instead of a summary/],
    ['tool call next to text', answer(summary, { content: [{ type: 'text', text: summary }, toolCall] }), /tool call instead of a summary/],
    ['error', answer('', { stopReason: 'error', errorMessage: 'overloaded' }), /failed: overloaded/],
    ['length', answer(summary, { stopReason: 'length' }), /output limit/],
    ['no goal heading', answer('I will keep working on the task.'), /not a summary: no "## Goal" heading/],
    ['missing heading', answer(summary.replace('## Key Decisions', '## Decisions')), /not a summary: no "## Key Decisions" heading/],
    ['headings out of order', answer(summary.replace('## Progress', '## Later').replace('## Critical Context', '## Critical Context\n## Progress')), /no "## Key Decisions" heading/],
    ['inline heading', answer(summary.replace('## Next Steps', 'see ## Next Steps')), /no "## Next Steps" heading/],
    ['empty goal', answer(summary.replace('Ship idle compaction for Pi.', '  ')), /no goal/],
  ];
  for (const [name, reply, expected] of cases) {
    await t.test(name, async (t) => {
      const pi = await harness(t, { respond: () => reply });
      await pi.run();
      pi.tick(54 * minute);
      await flush();
      assert.equal(pi.replays.length, 1);
      assert.deepEqual(pi.compactCalls, []);
      assert.deepEqual(pi.piSummaries, []);
      assert.equal(pi.notes.length, 1);
      assert.match(pi.notes[0], /^\[idle-compaction\] skipped idle compaction: /);
      assert.match(pi.notes[0], expected);
      assert.equal(pi.statuses.at(-1), undefined);

      await pi.run();
      pi.tick(54 * minute);
      await flush();
      assert.equal(pi.replays.length, 2);
      assert.equal(pi.notes.length, 1, 'warns once per session');
    });
  }
});

test('a replay past the timeout aborts and warns once', async (t) => {
  const pending = pendingAnswer();
  const pi = await harness(t, { respond: pending.respond });
  await pi.run();
  pi.tick(54 * minute);
  await flush();
  pi.tick(summaryTimeoutMs);
  await flush();
  assert.equal(pending.signal?.aborted, true);
  assert.deepEqual(pi.compactCalls, []);
  assert.deepEqual(pi.notes, ['[idle-compaction] skipped idle compaction: no summary within 5 minutes']);
});

test('an idle token that is not the live hand-off cancels instead of reaching Pi', async (t) => {
  const pi = await harness(t);
  await pi.run();
  await assert.rejects(pi.runCompaction('manual', 'pstack-idle-compaction:stale'), /Compaction cancelled/);
  assert.deepEqual(pi.piSummaries, []);
  pi.tick(54 * minute);
  await flush();
  assert.equal(pi.compactions().length, 1, 'a stale token does not cancel the armed timer');
});

test('a hand-off whose compaction cannot be built cancels instead of reaching Pi', async (t) => {
  const pi = await harness(t);
  await pi.run();
  pi.state.brokenPreparation = true;
  pi.tick(54 * minute);
  await flush();
  assert.equal(pi.compactCalls.length, 1);
  assert.equal(pi.compactions().length, 0);
  assert.deepEqual(pi.piSummaries, []);
});

test('file lists merge the previous compaction with the whole new transcript', async (t) => {
  const pi = await harness(t);
  pi.add({ type: 'message', message: toolUse(['read', 'src/a.ts'], ['edit', 'src/b.ts']) });
  pi.add({ type: 'message', message: codemodeResult(['write', 'src/c.ts'], ['read', 'docs/settings.md']) });
  await pi.run();
  pi.tick(54 * minute);
  await flush();
  pi.add({ type: 'message', message: toolUse(['read', 'src/d.ts'], ['read', 'src/a.ts']) });
  pi.add({ type: 'message', message: codemodeResult(['edit', 'src/a.ts']) });
  const { messages } = await pi.run();
  assert.ok(!JSON.stringify(messages).includes('src/c.ts'), 'the second transcript never names src/c.ts');
  pi.tick(54 * minute);
  await flush();
  const second = pi.compactions()[1];
  assert.deepEqual(second.details, { trigger: 'idle', readFiles: ['docs/settings.md', 'src/d.ts'], modifiedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  assert.ok(second.summary.endsWith('<read-files>\ndocs/settings.md\nsrc/d.ts\n</read-files>\n\n<modified-files>\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts\n</modified-files>'));
});

test('two settled runs in a row leave one timer', async (t) => {
  const pi = await harness(t);
  await pi.run();
  pi.tick(10 * minute);
  await pi.emit('agent_settled', { aborted: false });
  pi.tick(44 * minute);
  await flush();
  pi.tick(60 * minute);
  await flush();
  assert.equal(pi.replays.length, 1);
});

test('/idle-compaction on and off persist the setting and keep other keys', async (t) => {
  const pi = await harness(t, { settingsText: '{"version":1,"cmuxTabs":true}' });
  await pi.run();
  await pi.command('off');
  assert.match(pi.notes.pop() ?? '', /^Idle compaction: off\. Not armed: turned off\. Run \/idle-compaction on to turn it back on\.\nSetting: /);
  assert.deepEqual(JSON.parse(await readFile(settingsPath(pi.dir), 'utf8')), { version: 1, cmuxTabs: true, idleCompaction: false });
  await pi.command('on');
  assert.match(pi.notes.pop() ?? '', /^Idle compaction: on\. Not armed: waiting for the next run to finish\./);
  assert.deepEqual(JSON.parse(await readFile(settingsPath(pi.dir), 'utf8')), { version: 1, cmuxTabs: true, idleCompaction: true });
  await pi.command('later');
  assert.equal(pi.notes.pop(), 'Usage: /idle-compaction on|off|status');
});

test('on Pi 0.85.1 it never arms, never warns, and says why', async (t) => {
  const pi = await harness(t, { withStreamSimple: false, withGetSettings: false });
  assert.match(await pi.status(), /this Pi version cannot replay requests from an extension/);
  await pi.run();
  pi.tick(60 * minute);
  await flush();
  assert.equal(pi.replays.length, 0);
  assert.deepEqual(pi.notes, []);
  assert.match(await pi.status(), /this Pi version cannot replay requests from an extension/);
});

test('a broken settings file turns idle compaction off and warns once', async (t) => {
  const pi = await harness(t, { settingsText: 'broken' });
  assert.equal(pi.notes.length, 1);
  assert.match(pi.notes[0], /^\[idle-compaction\] idle compaction is off: Invalid JSON in /);
  await pi.run();
  pi.tick(60 * minute);
  await flush();
  assert.equal(pi.replays.length, 0);
});
