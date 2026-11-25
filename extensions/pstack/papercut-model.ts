import { Type, type Static, type TSchemaOptions } from 'typebox';
import { Check } from 'typebox/value';

export const papercutRecordVersion = 3 as const;
export const papercutKindPattern = '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$';
export const maxPapercutNoteLength = 2000;
export const maxPapercutFixLength = 500;

const culpritName = Type.String({
  description: 'The tool, command or MCP server name, or the path of the doc or config, such as read, gh, or ~/project/AGENTS.md',
  minLength: 1,
  maxLength: 256,
  pattern: '\\S',
});
/** A culprit names its thing, unless it is the agent's own slip or unknown. */
const culpritSchema = (options?: TSchemaOptions) => Type.Union([
  Type.Object({
    type: Type.Union([
      Type.Literal('pi-tool'), Type.Literal('command'), Type.Literal('mcp'), Type.Literal('doc'), Type.Literal('config'), Type.Literal('environment'),
    ], { description: 'pi-tool, command, mcp (server), doc (doc or skill), config, or environment (machine or account)' }),
    name: culpritName,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Union([Type.Literal('self'), Type.Literal('unknown')], { description: 'self (your own slip) or unknown' }),
    name: Type.Optional(culpritName),
  }, { additionalProperties: false }),
], options);
const impactLiterals = (options?: TSchemaOptions) => Type.Union([Type.Literal('extra-steps'), Type.Literal('blocked'), Type.Literal('wrong-result')], options);

const kindSchema = Type.String({ minLength: 1, maxLength: 64, pattern: papercutKindPattern });
const noteSchema = Type.String({ minLength: 1, maxLength: maxPapercutNoteLength, pattern: '\\S' });
const fixSchema = Type.String({ minLength: 1, maxLength: maxPapercutFixLength, pattern: '\\S' });

const toolEvidenceSchema = Type.Object({
  tool: Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' }),
  durationMs: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  isError: Type.Boolean(),
}, { additionalProperties: false });

const commonFields = {
  source: Type.Literal('agent'),
  at: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  note: noteSchema,
};
const legacyFields = { ...commonFields, kind: kindSchema, evidence: Type.Optional(toolEvidenceSchema) };
const machineFields = {
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
};

export const papercutRecordSchema = Type.Union([
  Type.Object({ version: Type.Literal(1), ...legacyFields }, { additionalProperties: false }),
  Type.Object({ version: Type.Literal(2), ...legacyFields, ...machineFields }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal(papercutRecordVersion),
    ...commonFields,
    ...machineFields,
    callId: Type.String({ minLength: 1 }),
    repo: Type.Optional(Type.Object({ root: Type.String({ minLength: 1 }), head: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    build: Type.String({ minLength: 1 }),
    culprit: culpritSchema(),
    impact: impactLiterals(),
    fix: Type.Optional(fixSchema),
  }, { additionalProperties: false }),
]);

export const papercutParameters = Type.Object({
  note: Type.String({
    description: 'What you were doing, what happened, what it cost, and how you got past it.',
    maxLength: maxPapercutNoteLength,
    pattern: '\\S',
  }),
  culprit: culpritSchema({ description: 'The one thing whose change would have prevented this friction' }),
  impact: impactLiterals({
    description: 'extra-steps: you got past it with more work; blocked: you could not finish; wrong-result: something gave you a wrong answer or file',
  }),
  fix: Type.Optional(Type.String({
    description: 'The change that would have prevented it, if you know one',
    maxLength: maxPapercutFixLength,
    pattern: '\\S',
  })),
}, { additionalProperties: false });

export type PapercutRecord = Static<typeof papercutRecordSchema>;
export type CurrentPapercutRecord = Extract<PapercutRecord, { version: typeof papercutRecordVersion }>;
export type PapercutCulprit = CurrentPapercutRecord['culprit'];
export type PapercutParameters = Static<typeof papercutParameters>;

export function normalizePapercutNote(note: string): string {
  return note.trim().replace(/\s+/gu, ' ');
}

type Labeled = Readonly<{ culprit: PapercutCulprit } | { kind: string }>;

/** `type:name` for a version 3 record; the free-form `kind` for older ones. */
export function papercutLabel(record: Labeled): string {
  if (!('culprit' in record)) return record.kind;
  return record.culprit.name ? `${record.culprit.type}:${record.culprit.name}` : record.culprit.type;
}

/** Records with the same key describe the same papercut. Writers refuse a second one and readers keep the earliest. */
export function papercutKey(record: Labeled & Readonly<{ sessionId: string; note: string }>): string {
  return `${record.sessionId}\u0000${papercutLabel(record)}\u0000${normalizePapercutNote(record.note)}`;
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
