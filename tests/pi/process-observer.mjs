import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const OBSERVATION_LIMITS = Object.freeze({ intervalMs: 100, pollTimeoutMs: 1_000, maxGapMs: 1_500, maxSamples: 512, maxProcesses: 16_384, maxTableBytes: 8 * 1024 * 1024, maxIdentities: 32, maxCommandBytes: 4_096 });

/** @typedef {{pid: number, ppid: number, pgid: number, state: string, start: string, command: string}} ProcessIdentity */
/** @typedef {{atMs: number, source: string, processes: (ProcessIdentity & {depth: number | null, pi: boolean})[], chain: number[]}} ProcessSample */
/**
 * @typedef {object} ProcessObservation
 * @property {number | null} rootPid
 * @property {{node: string, cli: string} | null} invocation
 * @property {ProcessIdentity[]} identities
 * @property {ProcessSample[]} samples
 * @property {number} peakLivePi
 * @property {number} maxDepth
 * @property {number} droppedPolls
 * @property {number} failedPolls
 * @property {number} overlappingPolls
 * @property {string[]} errors
 * @property {{kind: 'timeout', atMs: number, chain: number[]} | null} watchdog
 * @property {{checked: boolean, remainingIdentities: number[], groupMembers: number[], descendants: number[]} } cleanup
 */

export function processTable() {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'Process observation requires macOS or Linux ps');
  const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,args='], {
    encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC' },
    timeout: OBSERVATION_LIMITS.pollTimeoutMs, maxBuffer: OBSERVATION_LIMITS.maxTableBytes, killSignal: 'SIGKILL',
  });
  const lines = output.trim().split('\n');
  assert.ok(lines.length <= OBSERVATION_LIMITS.maxProcesses, 'Process table row limit exceeded');
  return lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    assert.ok(match, 'Malformed ps row');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], start: match[5].replace(/\s+/g, ' '), command: match[6].trimEnd() };
  });
}

/** @param {ProcessIdentity[]} table @param {number} rootPid */
function descendants(table, rootPid) {
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) if (owned.has(row.ppid) && !owned.has(row.pid)) {
      owned.add(row.pid);
      changed = true;
    }
  }
  return owned;
}

export class ProcessObserver {
  /** @type {ProcessObservation} */
  state = { rootPid: null, invocation: null, identities: [], samples: [], peakLivePi: 0, maxDepth: 0, droppedPolls: 0, failedPolls: 0, overlappingPolls: 0, errors: [], watchdog: null, cleanup: { checked: false, remainingIdentities: [], groupMembers: [], descendants: [] } };
  /** @type {NodeJS.Timeout | undefined} */
  timer;
  started = 0;
  lastPoll = 0;
  polling = false;
  /** @param {number} pid @param {{node: string, cli: string}} invocation @param {(error: unknown) => void} fail */
  start(pid, invocation, fail) {
    assert.equal(this.state.rootPid, null, 'Observer already started');
    this.state.rootPid = pid;
    this.state.invocation = invocation;
    this.started = Date.now();
    this.timer = setInterval(() => {
      try { this.sample('interval'); } catch (error) { fail(error); }
    }, OBSERVATION_LIMITS.intervalMs);
  }
  /** @param {string} source */
  sample(source) {
    const state = this.state;
    try {
      if (this.polling) {
        state.overlappingPolls++;
        throw new Error('Overlapping process polls');
      }
      this.polling = true;
      assert.ok(state.rootPid && state.invocation, 'Observer has not started');
      assert.ok(state.samples.length < OBSERVATION_LIMITS.maxSamples, 'Process sample limit exceeded');
      const now = Date.now();
      if (this.lastPoll && now - this.lastPoll > OBSERVATION_LIMITS.maxGapMs) {
        state.droppedPolls++;
        throw new Error('Process polling gap exceeded');
      }
      this.lastPoll = now;
      const table = processTable();
      const owned = descendants(table, state.rootPid);
      const rows = table.filter((row) => owned.has(row.pid) || row.pgid === state.rootPid);
      assert.ok(rows.length <= OBSERVATION_LIMITS.maxIdentities, 'Owned process limit exceeded');
      const invocation = `${state.invocation.node} ${state.invocation.cli} `;
      const processes = rows.map((row) => {
        assert.ok(Buffer.byteLength(row.command) <= OBSERVATION_LIMITS.maxCommandBytes, 'Owned command limit exceeded');
        assert.equal(row.pgid, state.rootPid, 'Descendant escaped root process group');
        const prior = state.identities.find((identity) => identity.pid === row.pid && identity.start === row.start);
        const pi = row.command.startsWith(invocation) || (row.command === 'pi' && prior?.command.startsWith(invocation) === true);
        let cursor = row;
        let depth = 0;
        const seen = new Set([row.pid]);
        while (cursor.pid !== state.rootPid) {
          const parent = rows.find((candidate) => candidate.pid === cursor.ppid);
          if (!parent) { depth = -1; break; }
          assert.ok(!seen.has(parent.pid), 'Process ancestry cycle');
          seen.add(parent.pid);
          cursor = parent;
          depth++;
        }
        return { ...row, pi, depth: depth < 0 ? null : depth };
      });
      const livePi = processes.filter((row) => row.pi && !/[ZX]/.test(row.state));
      state.peakLivePi = Math.max(state.peakLivePi, livePi.length);
      for (const row of processes) {
        const previous = state.identities.find((identity) => identity.pid === row.pid);
        if (previous) assert.equal(previous.start, row.start, 'PID was reused during observation');
        else {
          assert.ok(state.identities.length < OBSERVATION_LIMITS.maxIdentities, 'Process identity limit exceeded');
          const { pi: _pi, depth: _depth, ...identity } = row;
          state.identities.push(identity);
        }
      }
      assert.ok(livePi.length <= 5, 'Observed a sixth Pi');
      assert.ok(processes.every((row) => row.pi), 'Owned process lacks observed Pi invocation evidence');
      const chain = livePi.sort((a, b) => (a.depth ?? -1) - (b.depth ?? -1));
      assert.equal(chain[0]?.pid, state.rootPid, `Missing live root Pi ${JSON.stringify(rows)}`);
      for (let index = 0; index < chain.length; index++) {
        assert.equal(chain[index].depth, index, 'Pi processes are not one live ancestry chain');
        if (index) assert.equal(chain[index].ppid, chain[index - 1].pid, 'Pi chain has a non-Pi edge');
      }
      for (const previous of state.identities) assert.ok(processes.some((row) => row.pid === previous.pid && !/[ZX]/.test(row.state)), 'Recorded process exited before watchdog');
      state.maxDepth = Math.max(state.maxDepth, chain.length - 1);
      const sample = { atMs: now - this.started, source, processes, chain: chain.map((row) => row.pid) };
      state.samples.push(sample);
      return sample;
    } catch (error) {
      state.failedPolls++;
      if (state.errors.length < 16) state.errors.push(String(error).slice(0, 1_024));
      throw error;
    } finally { this.polling = false; }
  }
  watchdog() {
    const sample = this.sample('watchdog');
    this.state.watchdog = { kind: 'timeout', atMs: sample.atMs, chain: sample.chain };
  }
  stop() { clearInterval(this.timer); }
  verifyCleanup() {
    const state = this.state;
    assert.ok(state.rootPid);
    const table = processTable();
    const owned = descendants(table, state.rootPid);
    state.cleanup = {
      checked: true,
      remainingIdentities: table.filter((row) => state.identities.some((identity) => identity.pid === row.pid && identity.start === row.start)).map((row) => row.pid),
      groupMembers: table.filter((row) => row.pgid === state.rootPid).map((row) => row.pid),
      descendants: table.filter((row) => owned.has(row.pid)).map((row) => row.pid),
    };
    assert.deepEqual(state.cleanup, { checked: true, remainingIdentities: [], groupMembers: [], descendants: [] }, 'Processes survived cleanup');
    for (const identity of state.identities) assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
  }
}
