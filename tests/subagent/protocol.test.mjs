import assert from 'node:assert/strict';
import test from 'node:test';
import { childOutputParser } from '../../extensions/subagent/protocol.ts';
import { addUsage, zeroUsage } from '../../extensions/subagent/usage.ts';

const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, totalTokens: 26, reasoning: 2, cacheWrite1h: 1,
  cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 1, total: 1.875 } };
/** @param {Record<string, unknown>} [extra] */
const message = (extra = {}) => ({ role: 'assistant', timestamp: 1, provider: 'fixture', model: 'model', stopReason: 'stop',
  usage, content: [{ type: 'text', text: 'answer' }], ...extra });
/** @param {ReturnType<typeof childOutputParser>} parser @param {unknown} event */
const send = (parser, event) => parser.write(Buffer.from(JSON.stringify(event) + '\n'));
/** @param {ReturnType<typeof childOutputParser>} parser @param {Record<string, unknown>} [extra] */
const start = (parser, extra) => send(parser, { type: 'message_start', message: message(extra) });
/** @param {ReturnType<typeof childOutputParser>} parser @param {Record<string, unknown>} [extra] */
const end = (parser, extra) => send(parser, { type: 'message_end', message: message(extra) });
/** @param {ReturnType<typeof childOutputParser>} parser */
const settle = (parser) => send(parser, { type: 'agent_settled' });
/** @param {ReturnType<typeof childOutputParser>} parser @param {unknown} usage */
const update = (parser, usage) => send(parser, { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });

test('updates replace snapshots even when fields decrease; end commits once; copies never count', () => {
  const parser = childOutputParser();
  start(parser, { usage: zeroUsage(), stopReason: 'pending' });
  update(parser, { ...usage, input: 100, output: 1 });
  update(parser, { ...usage, input: 3, output: 10 });
  update(parser, usage);
  end(parser);
  for (let index = 0; index < 3; index++) {
    send(parser, { type: 'turn_end', message: message(), toolResults: [{ usage }] });
    send(parser, { type: 'agent_end', messages: [message()] });
    send(parser, { type: 'tool_execution_end', result: { usage } });
  }
  settle(parser); parser.end();
  assert.deepEqual(parser.report().direct, { kind: 'complete', usage });
  assert.deepEqual(parser.report().descendant, { kind: 'complete', usage: zeroUsage() });
});

test('unfinished assistant retains only the latest provisional usage after a later malformed event', () => {
  const parser = childOutputParser();
  start(parser); end(parser);
  start(parser, { timestamp: 2, usage: zeroUsage() });
  update(parser, { ...usage, input: 99 });
  update(parser, usage);
  assert.throws(() => parser.write(Buffer.from('not-json\n')));
  assert.throws(() => parser.end());
  const report = parser.report('cancelled');
  assert.equal(report.direct.kind, 'partial');
  if (report.direct.kind !== 'partial') throw new Error('Expected partial');
  assert.deepEqual(report.direct.usage, addUsage(usage, usage));
  assert.deepEqual(report.direct.provisional, usage);
  assert.ok(report.direct.reasons.includes('protocol') && report.direct.reasons.includes('cancelled'));
});

test('charged failed attempts count before retries; completed compactions count once', () => {
  const parser = childOutputParser();
  start(parser, { stopReason: 'error' }); end(parser, { stopReason: 'error' });
  send(parser, { type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: 'retry' });
  send(parser, { type: 'compaction_start', reason: 'overflow' });
  send(parser, { type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: 'retry', usage });
  send(parser, { type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'overflow', usage });
  send(parser, { type: 'summarization_retry_finished', usage });
  send(parser, { type: 'compaction_end', reason: 'overflow', result: { usage }, aborted: false, willRetry: true });
  send(parser, { type: 'entry_appended', entry: { type: 'compaction', usage } });
  start(parser, { timestamp: 2 }); end(parser, { timestamp: 2 });
  send(parser, { type: 'auto_retry_end', success: true, attempt: 1, usage });
  settle(parser); parser.end();
  assert.deepEqual(parser.report().direct.usage, addUsage(addUsage(usage, usage), usage));
});

test('unexpected nested tool usage is retained once and fails the leaf contract without dropping later direct usage', () => {
  const parser = childOutputParser();
  start(parser, { stopReason: 'toolUse' }); end(parser, { stopReason: 'toolUse' });
  const tool = { role: 'toolResult', timestamp: 2, toolCallId: 'nested', toolName: 'read', isError: false, content: [], usage };
  send(parser, { type: 'tool_execution_end', result: tool });
  send(parser, { type: 'message_start', message: tool });
  send(parser, { type: 'message_end', message: tool });
  send(parser, { type: 'turn_end', toolResults: [tool] });
  start(parser, { timestamp: 3 }); end(parser, { timestamp: 3 });
  settle(parser); assert.throws(() => parser.end(), /usage contract/);
  const report = parser.report();
  assert.deepEqual(report.direct.usage, addUsage(usage, usage));
  assert.deepEqual(report.descendant, { kind: 'partial', usage, reasons: ['unexpected-descendant'], provisional: null });
});

for (const stopReason of ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']) {
  test(`installed stop reason ${stopReason} retains usage`, () => {
    const parser = childOutputParser();
    start(parser, { stopReason }); end(parser, { stopReason }); settle(parser);
    assert.equal(parser.end().stopReason, stopReason);
    assert.deepEqual(parser.report().direct.usage, usage);
  });
}

test('truncation bounds before joining text blocks and keeps accounting after output fills', () => {
  const parser = childOutputParser(undefined, 4);
  start(parser);
  update(parser, usage);
  end(parser, { content: [{ type: 'text', text: '✓✓' }, { type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'more' }] });
  settle(parser);
  assert.deepEqual(parser.end().output, { text: '✓', bytes: 10, truncated: true });
  assert.equal(parser.report().direct.usage.input, 11);
  assert.ok(!JSON.stringify(parser.report()).includes('PRIVATE'));
});

for (const failure of ['duplicate-end', 'end-without-start', 'duplicate-start', 'duplicate-settled', 'after-settled', 'pending-end', 'unknown-stop', 'invalid-usage', 'overflow', 'bad-update', 'mismatched-end', 'duplicate-compaction']) {
  test(`strict lifecycle rejects ${failure} while preserving previous usage`, () => {
    const parser = childOutputParser();
    start(parser); end(parser);
    assert.throws(() => {
      switch (failure) {
        case 'duplicate-end': case 'end-without-start': end(parser); break;
        case 'duplicate-start': start(parser); start(parser); break;
        case 'duplicate-settled': settle(parser); settle(parser); break;
        case 'after-settled': settle(parser); send(parser, { type: 'agent_end' }); break;
        case 'pending-end': start(parser); end(parser, { stopReason: 'pending' }); break;
        case 'unknown-stop': start(parser); end(parser, { stopReason: 'invented' }); break;
        case 'invalid-usage': start(parser); update(parser, { ...usage, input: -1 }); break;
        case 'overflow': start(parser, { usage: zeroUsage() }); update(parser, { ...usage, input: Number.MAX_SAFE_INTEGER }); break;
        case 'bad-update': update(parser, usage); break;
        case 'mismatched-end': start(parser); end(parser, { timestamp: 22 }); break;
        case 'duplicate-compaction': send(parser, { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { usage } }); break;
      }
    });
    assert.ok(parser.report().direct.usage.input >= usage.input);
    assert.equal(parser.report().direct.kind, 'partial');
  });
}

for (const bytes of [Buffer.from([255, 10]), Buffer.from('{}\r\n'), Buffer.from('\ufeff{}\n'), Buffer.from('\n'), Buffer.from('{\n'), Buffer.from('{"type":"unknown"}\n'), Buffer.from('x'.repeat(256 * 1024 + 1)), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
  test(`strict JSONL rejects invalid bytes (${bytes.length}, ${bytes[0]})`, () => {
    const parser = childOutputParser();
    assert.throws(() => parser.write(bytes));
    assert.equal(parser.report().direct.kind, 'partial');
  });
}

test('unfinished LF, event bounds, missing compaction usage, and unfinished compaction cannot report success', () => {
  const parser = childOutputParser();
  parser.write(Buffer.from('{"type":"agent_start"}'));
  assert.throws(() => parser.end());
  assert.throws(() => childOutputParser().write(Buffer.from('{"type":"agent_start"}\n'.repeat(4097))));
  const compacted = childOutputParser();
  start(compacted); end(compacted);
  send(compacted, { type: 'compaction_start', reason: 'manual' });
  send(compacted, { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: {} });
  settle(compacted);
  assert.throws(() => compacted.end());
  assert.equal(compacted.report().direct.kind, 'partial');
  const unfinished = childOutputParser();
  start(unfinished); end(unfinished);
  send(unfinished, { type: 'compaction_start', reason: 'manual' });
  assert.throws(() => settle(unfinished));
});
