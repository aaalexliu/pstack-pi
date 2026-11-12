import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SUBAGENTS_CONFIG_FILE = "interactive-subagents.json";

export type CmuxLayout = "grid" | "tabs";

export interface SubagentsConfig {
  /** Most children one parent session runs at once. Extra spawns wait in a queue. */
  maxConcurrent: number;
  /** "grid": one pane per child in a 2x2 grid. "tabs": every child is a tab in one pane. */
  cmuxLayout: CmuxLayout;
  /** Extra folders of agent .md files, searched after the user dir and before bundled agents. */
  agentDirs: string[];
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  maxConcurrent: 4,
  cmuxLayout: "grid",
  agentDirs: [],
};

function configError(source: string, message: string): Error {
  return new Error(`Invalid subagents config ${source}: ${message}`);
}

/** Parse the user config. Relative and `~/` agent dirs resolve against `baseDir` and the home dir. */
export function parseSubagentsConfig(raw: unknown, source: string, baseDir: string): SubagentsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(source, "expected a JSON object");
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

  const { agentDirs = [] } = record;
  if (!Array.isArray(agentDirs) || agentDirs.some((dir) => typeof dir !== "string" || dir === "")) {
    throw configError(source, "agentDirs must be an array of folder paths");
  }

  return {
    maxConcurrent: maxConcurrent as number,
    cmuxLayout,
    agentDirs: (agentDirs as string[]).map((dir) =>
      dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : resolve(baseDir, dir),
    ),
  };
}

/** Read `<agentDir>/interactive-subagents.json`. A missing file means the defaults. */
export function loadSubagentsConfig(agentDir: string): SubagentsConfig {
  const path = join(agentDir, SUBAGENTS_CONFIG_FILE);
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
  return parseSubagentsConfig(raw, path, agentDir);
}
