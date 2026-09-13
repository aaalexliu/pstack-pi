import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { executionLimits, protocolLimits, type BoundedOutput } from './domain.ts';
import type { ModelIdentity } from './model-runtime.ts';
import { addUsage, parseUsage, usageReport, zeroUsage, type Usage, type UsageReason } from './usage.ts';

const object = Type.Object({ type: Type.String() });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const toolCall = Type.Object({ type: Type.Literal('toolCall'), id: Type.String(), name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) });
const text = Type.Object({ type: Type.Literal('text'), text: Type.String() });
const assistant = Type.Object({
  role: Type.Literal('assistant'), provider: Type.String(), model: Type.String(), timestamp,
  stopReason: Type.Enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
  content: Type.Array(Type.Union([text, Type.Object({ type: Type.Literal('thinking'), thinking: Type.String() }), toolCall])),
  usage: Type.Unknown(),
});
const otherMessage = Type.Union([
  Type.Object({ role: Type.Literal('user'), timestamp, content: Type.Union([Type.String(), Type.Array(Type.Unknown())]) }),
  Type.Object({ role: Type.Literal('toolResult'), timestamp, toolCallId: Type.String(), toolName: Type.String(), isError: Type.Boolean(), content: Type.Array(Type.Unknown()), usage: Type.Optional(Type.Unknown()) }),
]);
const messageEvent = Type.Object({ type: Type.String(), message: Type.Union([assistant, otherMessage]) });
const index = Type.Integer({ minimum: 0, maximum: protocolLimits.lineBytes });
const deltaEvent = Type.Union([
  Type.Object({ type: Type.Enum(['text_start', 'thinking_start']), contentIndex: index }),
  Type.Object({ type: Type.Enum(['text_delta', 'thinking_delta', 'toolcall_delta']), contentIndex: index, delta: Type.String() }),
  Type.Object({ type: Type.Enum(['text_end', 'thinking_end']), contentIndex: index, content: Type.String() }),
  Type.Object({ type: Type.Literal('toolcall_start'), contentIndex: index, id: Type.String(), toolName: Type.String() }),
  Type.Object({ type: Type.Literal('toolcall_end'), contentIndex: index, toolCall }),
]);
const updateEvent = Type.Object({ type: Type.Literal('message_update'), usage: Type.Unknown(), assistantMessageEvent: deltaEvent });
const compactionReason = Type.Enum(['manual', 'threshold', 'overflow']);
const compactionStart = Type.Object({ type: Type.Literal('compaction_start'), reason: compactionReason });
const compactionEnd = Type.Object({ type: Type.Literal('compaction_end'), reason: compactionReason, aborted: Type.Boolean(), willRetry: Type.Boolean(),
  errorMessage: Type.Optional(Type.String()), result: Type.Optional(Type.Object({ usage: Type.Optional(Type.Unknown()) })),
});
const eventTypes = new Set(['session', 'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end',
  'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished', 'queue_update', 'entry_appended',
  'session_info_changed', 'thinking_level_changed', 'bash_execution_update']);

type OpenMessage =
  | { role: 'assistant'; timestamp: number; provider: string; model: string; usage: Usage }
  | { role: 'user'; timestamp: number }
  | { role: 'toolResult'; timestamp: number; toolCallId: string };
type Final = Pick<Static<typeof assistant>, 'provider' | 'model' | 'stopReason'> & { output: BoundedOutput };

export function boundedOutput(text: string, limit = executionLimits.outputBytes): BoundedOutput {
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  const buffer = Buffer.from(text);
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes, truncated: true };
}
function assistantOutput(content: Static<typeof assistant>['content'], limit: number): BoundedOutput {
  let text = '';
  let bytes = 0;
  let retained = 0;
  for (const block of content) {
    if (block.type !== 'text') continue;
    const part = boundedOutput(block.text, limit - retained);
    bytes += part.bytes;
    text += part.text;
    retained += Buffer.byteLength(part.text);
    if (part.truncated) retained = limit;
  }
  return { text, bytes, truncated: bytes > limit };
}

export function childOutputParser(expected?: ModelIdentity, outputBytes = executionLimits.outputBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const line = Buffer.alloc(protocolLimits.lineBytes);
  let pending = 0;
  let bytes = 0;
  let count = 0;
  let open: OpenMessage | undefined;
  let final: Final | undefined;
  let compaction: Static<typeof compactionReason> | undefined;
  let committed = zeroUsage();
  let descendant = zeroUsage();
  let unexpectedDescendant = false;
  let settled = false;
  let ended = false;
  let failed = false;
  const reasons = new Set<UsageReason>();

  const consume = (value: unknown) => {
    if (!Check(object, value) || !eventTypes.has(value.type)) throw new Error('Invalid child event');
    if (settled) throw new Error('Child event after settled');
    switch (value.type) {
      case 'message_start':
      case 'message_end': {
        if (!Check(messageEvent, value)) throw new Error('Invalid child message');
        const message = value.message;
        if (message.role === 'assistant' && expected && (message.provider !== expected.provider || message.model !== expected.id)) throw new Error('Child model differs from resolved model');
        if (value.type === 'message_start') {
          if (open || compaction !== undefined) throw new Error('Overlapping child message');
          switch (message.role) {
            case 'assistant': {
              const usage = parseUsage(message.usage);
              addUsage(committed, usage);
              open = { role: 'assistant', timestamp: message.timestamp, provider: message.provider, model: message.model, usage };
              break;
            }
            case 'user': open = { role: 'user', timestamp: message.timestamp }; break;
            case 'toolResult': open = { role: 'toolResult', timestamp: message.timestamp, toolCallId: message.toolCallId }; break;
          }
          return;
        }
        if (!open || open.role !== message.role || open.timestamp !== message.timestamp) throw new Error('Unmatched child message end');
        if (message.role === 'assistant') {
          if (open.role !== 'assistant' || open.provider !== message.provider || open.model !== message.model || message.stopReason === 'pending') throw new Error('Invalid assistant completion');
          const usage = parseUsage(message.usage);
          committed = addUsage(committed, usage);
          final = { provider: message.provider, model: message.model, stopReason: message.stopReason, output: assistantOutput(message.content, outputBytes) };
        } else if (message.role === 'toolResult') {
          if (open.role !== 'toolResult' || open.toolCallId !== message.toolCallId) throw new Error('Unmatched tool result');
          if (message.usage !== undefined) {
            unexpectedDescendant = true;
            const usage = parseUsage(message.usage);
            descendant = addUsage(descendant, usage);
          }
        }
        open = undefined;
        break;
      }
      case 'message_update': {
        if (!Check(updateEvent, value) || open?.role !== 'assistant') throw new Error('Invalid child update');
        const usage = parseUsage(value.usage);
        addUsage(committed, usage);
        open = { ...open, usage };
        break;
      }
      case 'compaction_start':
        if (!Check(compactionStart, value) || compaction !== undefined || open) throw new Error('Invalid compaction start');
        compaction = value.reason;
        break;
      case 'compaction_end':
        if (!Check(compactionEnd, value) || compaction !== value.reason) throw new Error('Invalid compaction end');
        if (value.result !== undefined && !value.aborted && value.errorMessage === undefined) {
          if (value.result.usage === undefined) reasons.add('compaction-usage-missing');
          else committed = addUsage(committed, parseUsage(value.result.usage));
        } else reasons.add('compaction-usage-missing');
        compaction = undefined;
        break;
      case 'agent_settled':
        if (open || compaction !== undefined || !final) throw new Error('Child settled with unfinished work');
        settled = true;
        break;
    }
  };
  return {
    write(chunk: Buffer) {
      try {
        if (ended || failed) throw new Error('Child protocol is closed');
        if (chunk.length > protocolLimits.stdoutBytes - bytes) throw new Error('Child stdout limit exceeded');
        bytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          const size = end - offset;
          if (size > line.length - pending) throw new Error('Child JSONL line limit exceeded');
          chunk.copy(line, pending, offset, end);
          pending += size;
          if (newline === -1) break;
          if (++count > protocolLimits.events) throw new Error('Child event limit exceeded');
          const text = decoder.decode(line.subarray(0, pending));
          if (text.includes('\r')) throw new Error('Child JSONL requires LF');
          const value: unknown = JSON.parse(text);
          consume(value);
          pending = 0;
          offset = newline + 1;
        }
      } catch (error) { failed = true; reasons.add('protocol'); throw error; }
    },
    end(): Final {
      if (ended || failed || pending || !settled || !final) {
        failed = true;
        reasons.add('protocol');
        throw new Error('Child has no valid settled final response');
      }
      ended = true;
      if (unexpectedDescendant || reasons.size) throw new Error('Child usage contract incomplete');
      return final;
    },
    report(reason?: UsageReason) {
      return usageReport({ committed, provisional: open?.role === 'assistant' ? open.usage : null, descendant, unexpectedDescendant,
        reasons: [...reasons, ...(!settled ? ['unsettled' as const] : []), ...(reason ? [reason] : [])] });
    },
  };
}
