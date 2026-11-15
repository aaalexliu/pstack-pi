/**
 * pstack-pi: run a Pi child with no terminal multiplexer. The child owns a detached
 * process group, so an abort, a timeout, or session shutdown kills everything it spawned.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export const TERM_GRACE_MS = 3000;
const STDERR_CAP = 16 * 1024;

/** Run the same Pi that is running us, never whatever `pi` is first in PATH. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** The child is a detached session leader, so -pid reaches everything it spawned. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export type SpawnHeadless = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

/** Start `pi -p <argv>` in its own process group. */
export const spawnHeadless: SpawnHeadless = (argv, { cwd, env }) => {
  const invocation = getPiInvocation(["-p", ...argv]);
  return spawn(invocation.command, invocation.args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "ignore", "pipe"] });
};

/** Wait for a headless child to exit. An abort sends SIGTERM to its group, then SIGKILL after the grace period. */
export function waitForHeadlessExit(
  proc: ChildProcess,
  signal: AbortSignal,
  termGraceMs = TERM_GRACE_MS,
): Promise<{ exitCode: number; stderr: string; aborted: boolean }> {
  return new Promise((resolve) => {
    let stderr = "";
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (aborted || proc.pid === undefined) return;
      aborted = true;
      killProcessGroup(proc.pid, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(proc.pid!, "SIGKILL"), termGraceMs);
    };
    const finish = (exitCode: number) => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      resolve({ exitCode, stderr, aborted });
    };
    proc.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-STDERR_CAP); });
    proc.once("close", (code) => finish(code ?? 1));
    proc.once("error", (error) => { stderr += error.message; finish(1); });
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}
