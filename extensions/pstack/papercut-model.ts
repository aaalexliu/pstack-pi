import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const papercutRecordVersion = 1 as const;
export const papercutKindPattern = '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$';
export const maxPapercutNoteLength = 2000;

const kindSchema = Type.String({ minLength: 1, maxLength: 64, pattern: papercutKindPattern });
const noteSchema = Type.String({ minLength: 1, maxLength: maxPapercutNoteLength, pattern: '\\S' });

export const toolEvidenceSchema = Type.Object({
  tool: Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' }),
  durationMs: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  isError: Type.Boolean(),
}, { additionalProperties: false });

export const papercutRecordSchema = Type.Object({
  version: Type.Literal(papercutRecordVersion),
  source: Type.Literal('agent'),
  at: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  kind: kindSchema,
  note: noteSchema,
  evidence: Type.Optional(toolEvidenceSchema),
}, { additionalProperties: false });

export const papercutParameters = Type.Object({
  kind: Type.Optional(Type.String({
    description: 'Stable lowercase kind such as tool.slow, search.too-broad, or docs.confusing',
    maxLength: 64,
    pattern: papercutKindPattern,
  })),
  note: Type.String({
    description: 'A concise account of the friction and why it was unexpected',
    maxLength: maxPapercutNoteLength,
    pattern: '\\S',
  }),
  evidence: Type.Optional(Type.Object({
    tool: Type.String({ description: 'Tool name from the trailer', maxLength: 128, pattern: '\\S' }),
    durationMs: Type.Integer({ description: 'Duration from the trailer, in ms', minimum: 0 }),
    outputBytes: Type.Integer({ description: 'Output size from the trailer, in bytes', minimum: 0 }),
    isError: Type.Optional(Type.Boolean({ description: 'True when the trailer says failed' })),
  }, {
    additionalProperties: false,
    description: 'Measurement of the tool call this note is about. Copy it from that result\'s [pstack: <tool> <ms>ms <bytes>B] trailer.',
  })),
}, { additionalProperties: false });

export type ToolEvidence = Static<typeof toolEvidenceSchema>;
export type PapercutRecord = Static<typeof papercutRecordSchema>;
export type PapercutParameters = Static<typeof papercutParameters>;

export function normalizePapercutNote(note: string): string {
  return note.trim().replace(/\s+/gu, ' ');
}

export function decodePapercutRecord(value: unknown): PapercutRecord | null {
  if (!Check(papercutRecordSchema, value)) return null;
  if (Number.isNaN(Date.parse(value.at))) return null;
  return value;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
