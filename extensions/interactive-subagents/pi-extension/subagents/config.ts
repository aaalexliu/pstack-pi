import { readFileSync } from "node:fs";
import { settingsPath } from "../../../subagent/cmux-settings.ts";

/** The key that holds these settings in pstack-pi's `<agentDir>/pstack-pi/settings.json`. */
export const SUBAGENTS_SETTINGS_KEY = "interactiveSubagents";

export type CmuxLayout = "grid" | "tabs";

export interface SubagentsConfig {
  /** Most children one parent session runs at once. Extra spawns wait in a queue. */
  maxConcurrent: number;
  /** "grid": one pane per child in a 2x2 grid. "tabs": every child is a tab in one pane. */
  cmuxLayout: CmuxLayout;
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  maxConcurrent: 4,
  cmuxLayout: "grid",
};

function configError(source: string, message: string): Error {
  return new Error(`Invalid subagents config ${source}: ${message}`);
}

/** Parse the `interactiveSubagents` value. A missing value means the defaults. */
export function parseSubagentsConfig(raw: unknown, source: string): SubagentsConfig {
  if (raw === undefined) return DEFAULT_SUBAGENTS_CONFIG;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(source, `${SUBAGENTS_SETTINGS_KEY} must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULT_SUBAGENTS_CONFIG)) throw configError(source, `unknown key "${key}"`);
  }

  const { maxConcurrent = DEFAULT_SUBAGENTS_CONFIG.maxConcurrent } = record;
  if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
    throw configError(source, "maxConcurrent must be a positive integer");
  }

  const { cmuxLayout = DEFAULT_SUBAGENTS_CONFIG.cmuxLayout } = record;
  if (cmuxLayout !== "grid" && cmuxLayout !== "tabs") {
    throw configError(source, 'cmuxLayout must be "grid" or "tabs"');
  }

  return { maxConcurrent: maxConcurrent as number, cmuxLayout };
}

/** Read the `interactiveSubagents` key of `<agentDir>/pstack-pi/settings.json`. A missing file or key means the defaults. */
export function loadSubagentsConfig(agentDir: string): SubagentsConfig {
  const path = settingsPath(agentDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SUBAGENTS_CONFIG;
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw configError(path, error instanceof Error ? error.message : String(error));
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw configError(path, "expected a JSON object");
  return parseSubagentsConfig((raw as Record<string, unknown>)[SUBAGENTS_SETTINGS_KEY], path);
}
