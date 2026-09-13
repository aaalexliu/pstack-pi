import { Type } from 'typebox';
import { Check } from 'typebox/value';

export const modeEntryType = 'pstack-poteto-mode';
export const modeStateVersion = 1 as const;
const modeStateSchema = Type.Object({
  version: Type.Literal(modeStateVersion),
  enabled: Type.Boolean(),
}, { additionalProperties: false });

export type ModeState = Readonly<{ version: typeof modeStateVersion; enabled: boolean }>;
export type ModeSessionEntry = Readonly<{ type: string; customType?: string; data?: unknown }>;

export const disabledModeState: ModeState = Object.freeze({ version: modeStateVersion, enabled: false });
export const enabledModeState: ModeState = Object.freeze({ version: modeStateVersion, enabled: true });

export function decodeModeState(value: unknown): ModeState | null {
  if (!Check(modeStateSchema, value)) return null;
  return value.enabled ? enabledModeState : disabledModeState;
}

export function restoreMode(entries: readonly ModeSessionEntry[]): ModeState {
  let restored = disabledModeState;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== modeEntryType) continue;
    const candidate = decodeModeState(entry.data);
    if (candidate) restored = candidate;
  }
  return restored;
}

export function invokesPotetoMode(text: string): boolean {
  return /^\/skill:poteto-mode(?:\s|$)/u.test(text);
}
