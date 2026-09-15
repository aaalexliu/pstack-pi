import { Buffer } from 'node:buffer';
import type { ToolEvidence } from './papercut-model.ts';

type ToolStart = Readonly<{ toolName: string; startedAt: number }>;

export type ToolFinish = Readonly<{
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError: boolean;
  finishedAt: number;
}>;

export type ToolObservation = Readonly<{ evidence: ToolEvidence; trailer: string }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function countToolResultBytes(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const item of content) {
    if (!isObject(item)) continue;
    if (typeof item.text === 'string') bytes += Buffer.byteLength(item.text, 'utf8');
    if (typeof item.data === 'string') bytes += Buffer.byteLength(item.data, 'utf8');
  }
  return bytes;
}

/** One-line measurement appended to every tool result, in units the agent can copy into a papercut's evidence. */
export function formatToolTrailer(evidence: ToolEvidence): string {
  const failed = evidence.isError ? ' failed' : '';
  return `[pstack: ${evidence.tool} ${evidence.durationMs}ms ${evidence.outputBytes}B${failed}]`;
}

/** Measures each tool call by id and turns the measurement into a result trailer. */
export class PapercutObserver {
  private readonly starts = new Map<string, ToolStart>();

  start(toolCallId: string, toolName: string, startedAt: number): void {
    this.starts.set(toolCallId, { toolName, startedAt });
  }

  finish(input: ToolFinish): ToolObservation | undefined {
    const start = this.starts.get(input.toolCallId);
    if (!start) return undefined;
    this.starts.delete(input.toolCallId);
    const evidence: ToolEvidence = {
      tool: input.toolName || start.toolName,
      durationMs: Math.round(Math.max(0, input.finishedAt - start.startedAt)),
      outputBytes: countToolResultBytes(input.content),
      isError: input.isError,
    };
    return { evidence, trailer: formatToolTrailer(evidence) };
  }
}
