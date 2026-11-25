import { formatDuration } from './papercut-model.ts';

/** Calls at least this slow get a trailer, because a model cannot feel time. */
export const slowToolCallMs = 10_000;

export function formatToolTrailer(durationMs: number): string {
  return `[pstack: took ${formatDuration(durationMs)}]`;
}

/** Times each tool call by id and returns a trailer for the slow ones. */
export class PapercutObserver {
  private readonly starts = new Map<string, number>();

  start(toolCallId: string, startedAt: number): void {
    this.starts.set(toolCallId, startedAt);
  }

  finish(toolCallId: string, finishedAt: number): string | undefined {
    const startedAt = this.starts.get(toolCallId);
    if (startedAt === undefined) return undefined;
    this.starts.delete(toolCallId);
    const durationMs = Math.max(0, finishedAt - startedAt);
    return durationMs >= slowToolCallMs ? formatToolTrailer(durationMs) : undefined;
  }
}
