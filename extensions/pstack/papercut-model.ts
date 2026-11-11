import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const papercutRecordVersion = 2 as const;
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

const recordFieldsV1 = {
  source: Type.Literal('agent'),
  at: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  kind: kindSchema,
  note: noteSchema,
  evidence: Type.Optional(toolEvidenceSchema),
};

export const papercutRecordSchema = Type.Union([
  Type.Object({ version: Type.Literal(1), ...recordFieldsV1 }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal(papercutRecordVersion),
    ...recordFieldsV1,
    host: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  }, { additionalProperties: false }),
]);

export const papercutParameters = Type.Object({
  kind: Type.Optional(Type.String({
    description: 'Stable lowercase kind such as tool.slow, search.too-broad, or docs.confusing',
    maxLength: 64,
    pattern: papercutKindPattern,
  })),
  note: Type.String({
    description: 'What happened, the extra work it caused, and a possible improvement if known. Recovered failures and successful but onerous workflows count too.',
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
export type CurrentPapercutRecord = Extract<PapercutRecord, { version: typeof papercutRecordVersion }>;
export type PapercutParameters = Static<typeof papercutParameters>;

export function normalizePapercutNote(note: string): string {
  return note.trim().replace(/\s+/gu, ' ');
}

/** Records with the same key describe the same papercut. Writers refuse a second one and readers keep the earliest. */
export function papercutKey(record: Pick<PapercutRecord, 'sessionId' | 'kind' | 'note'>): string {
  return `${record.sessionId}\u0000${record.kind}\u0000${normalizePapercutNote(record.note)}`;
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
