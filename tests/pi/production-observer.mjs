import assert from 'node:assert/strict';
import { processTable } from './process-observer.mjs';

export class ProductionObserver {
  /** @param {{maxLivePi?: number}} [options] */
  constructor({ maxLivePi = 2 } = {}) { this.maxLivePi = maxLivePi; }
  root = 0;
  startedAt = 0;
  /** @type {Map<number, import('./process-observer.mjs').ProcessIdentity>} */
  identities = new Map();
  /** @type {{atMs: number, pids: number[], piPids: number[]}[]} */
  samples = [];
  /** @type {string[]} */
  errors = [];
  maxDepth = 0;
  peakLivePi = 0;
  verifiedBeforeRescue = false;
  /** @type {NodeJS.Timeout | undefined} */
  timer;
  /** @param {number} pid */
  start(pid) {
    this.root = pid;
    this.startedAt = Date.now();
    this.sample();
    this.timer = setInterval(() => { try { this.sample(); } catch (error) { this.errors.push(String(error)); } }, 100);
  }
  sample() {
    assert.ok(this.samples.length < 512);
    const table = processTable();
    const owned = new Set([this.root, ...this.identities.keys()]);
    const groups = new Set([...this.identities.values()].filter((row) => row.pid === row.pgid).map((row) => row.pgid));
    for (let changed = true; changed;) {
      changed = false;
      for (const row of table) if (!owned.has(row.pid) && (owned.has(row.ppid) || groups.has(row.pgid))) { owned.add(row.pid); changed = true; }
    }
    const rows = table.filter((row) => owned.has(row.pid));
    assert.ok(rows.length <= 128);
    for (const row of rows) {
      const prior = this.identities.get(row.pid);
      if (prior) assert.equal(row.start, prior.start, 'PID reused during production observation');
      this.identities.set(row.pid, row);
    }
    const pi = rows.filter((row) => row.command === 'pi' || row.command.includes('/pi-coding-agent/dist/'));
    this.peakLivePi = Math.max(this.peakLivePi, pi.length);
    for (const row of pi) {
      let current = row;
      let depth = 0;
      const seen = new Set([row.pid]);
      while (current.pid !== this.root) {
        const parent = rows.find((candidate) => candidate.pid === current.ppid);
        if (!parent) break;
        assert.ok(!seen.has(parent.pid)); seen.add(parent.pid);
        if (pi.includes(parent)) depth++;
        current = parent;
      }
      this.maxDepth = Math.max(this.maxDepth, depth);
    }
    assert.ok(this.peakLivePi <= this.maxLivePi, 'Production exceeded its Pi process limit');
    assert.ok(this.maxDepth <= 1, 'Production exceeded one delegation edge');
    this.samples.push({ atMs: Date.now() - this.startedAt, pids: rows.map((row) => row.pid), piPids: pi.map((row) => row.pid) });
    return rows;
  }
  stop() { clearInterval(this.timer); }
  verifyGone() {
    this.stop();
    assert.deepEqual(this.errors, []);
    assert.deepEqual(this.sample(), [], 'Production left work before runner rescue');
    for (const row of this.identities.values()) {
      assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' });
      if (row.pid === row.pgid) assert.throws(() => process.kill(-row.pgid, 0), { code: 'ESRCH' });
    }
    this.verifiedBeforeRescue = true;
  }
  rescue() {
    this.stop();
    const table = processTable();
    for (const row of this.identities.values()) {
      if (table.some((current) => current.pid === row.pid && current.start === row.start)) {
        try { process.kill(row.pid, 'SIGKILL'); } catch {}
      }
    }
  }
  report() {
    return { root: this.root, maxDepth: this.maxDepth, peakLivePi: this.peakLivePi, verifiedBeforeRescue: this.verifiedBeforeRescue, identities: [...this.identities.values()], samples: this.samples, errors: this.errors };
  }
}
