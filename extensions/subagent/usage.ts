import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

export type Usage = NonNullable<ToolResultEvent['usage']>;
const tokens = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const cost = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });
const usageSchema = Type.Object({
  input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, totalTokens: tokens,
  reasoning: Type.Optional(tokens), cacheWrite1h: Type.Optional(tokens),
  cost: Type.Object({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost, total: cost }, { additionalProperties: false }),
}, { additionalProperties: false });

export function parseUsage(value: unknown): Usage {
  if (!Check(usageSchema, value)) throw new Error('Invalid Pi usage');
  return { ...value, cost: { ...value.cost } };
}
export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(left: Usage, right: Usage): Usage {
  const sum = zeroUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) sum[key] = left[key] + right[key];
  for (const key of ['reasoning', 'cacheWrite1h'] as const) {
    if (left[key] !== undefined || right[key] !== undefined) sum[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) sum.cost[key] = left.cost[key] + right.cost[key];
  return parseUsage(sum);
}

export type UsageReason = 'unfinished-assistant' | 'unsettled' | 'protocol' | 'cancelled' | 'process-failure' | 'runner-failure'
  | 'cleanup-unverified' | 'compaction-usage-missing' | 'unexpected-descendant' | 'overflow';
export type UsageScope =
  | { kind: 'complete'; usage: Usage }
  | { kind: 'partial'; usage: Usage; reasons: UsageReason[]; provisional: Usage | null };
export type UsageReport = { scope: 'pi-reported'; direct: UsageScope; descendant: UsageScope };

export function usageReport({ committed = zeroUsage(), provisional = null, descendant = zeroUsage(), reasons = [], unexpectedDescendant = false }: {
  committed?: Usage; provisional?: Usage | null; descendant?: Usage; reasons?: UsageReason[]; unexpectedDescendant?: boolean;
} = {}): UsageReport {
  const partial = [...new Set([...reasons, ...(provisional ? ['unfinished-assistant' as const] : [])])];
  const usage = provisional ? addUsage(committed, provisional) : committed;
  return { scope: 'pi-reported',
    direct: partial.length ? { kind: 'partial', usage, reasons: partial, provisional } : { kind: 'complete', usage },
    descendant: unexpectedDescendant
      ? { kind: 'partial', usage: descendant, reasons: ['unexpected-descendant'], provisional: null }
      : { kind: 'complete', usage: descendant },
  };
}
export function aggregateUsage(reports: readonly UsageReport[]): { usage: Usage; overflow: boolean } {
  let usage = zeroUsage();
  let overflow = false;
  for (const report of reports) {
    for (const scope of [report.direct, report.descendant]) {
      try { usage = addUsage(usage, scope.usage); }
      catch { overflow = true; }
    }
  }
  return { usage, overflow };
}
