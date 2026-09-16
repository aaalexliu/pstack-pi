import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after } from "node:test";
import { jsonlParser } from './jsonl.mjs';
export { jsonlParser } from './jsonl.mjs';
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FIXTURE_KEY, FIXTURE_MODEL, FIXTURE_TEXT, FIXTURE_USAGE, startProvider } from "./provider.mjs";
import { contentInventory, expectedPackFiles, checkPackedContent } from '../../scripts/check-content.mjs';

/** @typedef {Record<string, unknown> & { type: string }} PiEvent */
/** @typedef {{ text: string, bytes: number, truncated: boolean }} Diagnostics */
/**
 * @typedef {object} PiTestRun
 * @property {{ root: string, home: string, profile: string, cwd: string, sessions: string, package: string }} paths
 * @property {{ executable: string, version: string, revision: string, args: string[], pid: number | null, pgid: number | null }} process
 * @property {{ files: string[], inventory: string, listing: string, shasum: string }} pack
 * @property {PiEvent[]} events
 * @property {Diagnostics} stdout
 * @property {Diagnostics} stderr
 * @property {string[]} diagnostics
 * @property {PiEvent | null} resources
 * @property {{ code: number | null, signal: NodeJS.Signals | null } | null} exit
 * @property {{ limitMs: number, expired: boolean }} timeout
 * @property {{ signals: string[], remainingPids: number[], groupAlive: boolean, providerClosed: boolean, tempRemoved: boolean }} cleanup
 * @property {import("./provider.mjs").FixtureState | null} provider
 * @property {import('./process-observer.mjs').ProcessObservation | null} observation
 * @property {number} durationMs
 */

const MAX_OUTPUT = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const repository = fileURLToPath(new URL("../../", import.meta.url));

/**
 * @typedef {object} PreparedPackage
 * @property {string} hold
 * @property {string} tarball
 * @property {string[]} files
 * @property {string} inventory
 * @property {string} shasum
 */

/** @type {Promise<PreparedPackage> | null} */
let productionPack = null;
/** @type {string | null} */
let productionHold = null;

/** @type {{ executable: string, version: string, sdk: string } | null} */
let resolvedPi = null;

/** @param {string} hold */
function packEnv(hold) {
  return {
    PATH: process.env.PATH,
    HOME: hold,
    TMPDIR: hold,
    npm_config_cache: join(hold, "npm-cache"),
    npm_config_userconfig: join(hold, "user.npmrc"),
    npm_config_globalconfig: join(hold, "global.npmrc"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
  };
}

/** @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} bin @param {string[]} args */
function runCommand(env, cwd, bin, args) {
  return execFileSync(bin, args, {
    cwd, env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function disposePreparedPackage() {
  const pack = await productionPack?.catch(() => null);
  try {
    if (pack) await rm(pack.hold, { recursive: true, force: true });
  } finally {
    productionPack = null;
    productionHold = null;
    resolvedPi = null;
  }
}

process.once("exit", () => {
  if (!productionHold) return;
  try { rmSync(productionHold, { recursive: true, force: true }); } catch { /* process is exiting */ }
});

after(async () => {
  await disposePreparedPackage();
});

/**
 * @param {{ sourceRoot: string, files: string[], content?: ReturnType<typeof contentInventory>, hold?: string }} options
 * @returns {Promise<PreparedPackage>}
 */
async function packOnce({ sourceRoot, files, content, hold }) {
  const owned = hold === undefined;
  const packHold = hold ?? await mkdtemp(join(await realpath(tmpdir()), "pstack-pi-pack-"));
  try {
    const env = packEnv(packHold);
    const packed = JSON.parse(runCommand(env, sourceRoot, "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packHold]))[0];
    const packFiles = packed.files.map(/** @param {{ path: string }} file */ (file) => file.path).sort();
    assert.deepEqual(packFiles, [...files].sort());
    const tarball = join(packHold, packed.filename);
    const inventory = runCommand(env, packHold, "tar", ["-tf", tarball]);
    assert.deepEqual(inventory.trim().split("\n").sort(), files.map((name) => `package/${name}`).sort(), "Tar inventory differs");
    runCommand(env, packHold, "tar", ["-xf", tarball, "-C", packHold]);
    const extracted = join(packHold, "package");
    if (content) await checkPackedContent(extracted, content);
    for (const name of files) {
      const filename = join(extracted, name);
      const stat = await lstat(filename);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o7777, 0o644);
      assert.deepEqual(await readFile(filename), await readFile(join(sourceRoot, name)), `Packed bytes differ: ${name}`);
    }
    const manifest = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
    assert.equal(manifest.name, "@aaalexliu/pstack-pi");
    assert.equal(manifest.dependencies, undefined, "The packed package must not need an install step");
    return { hold: packHold, tarball, files: packFiles, inventory, shasum: packed.shasum };
  } catch (error) {
    if (owned) await rm(packHold, { recursive: true, force: true });
    throw error;
  }
}

/**
 * @param {{ sourceRoot: string, files: string[], content?: ReturnType<typeof contentInventory> }} options
 * @returns {Promise<PreparedPackage>}
 */
export async function preparePackedPackage({ sourceRoot, files, content }) {
  if (sourceRoot !== repository) return packOnce({ sourceRoot, files, content });
  if (!productionPack) {
    productionPack = packOnce({ sourceRoot, files, content }).then((pack) => {
      productionHold = pack.hold;
      return pack;
    }).catch((error) => {
      productionPack = null;
      productionHold = null;
      throw error;
    });
  }
  return productionPack;
}

/** @param {PreparedPackage} pack @param {string} destination */
export async function extractPreparedPackage(pack, destination) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, "extract-"));
  try {
    execFileSync("tar", ["-xf", pack.tarball, "-C", staging], {
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await rename(join(staging, "package"), destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** @param {string} root @returns {string} */
export function repositoryRevision(root) {
  if (!existsSync(join(root, ".git"))) return "unknown";
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 15_000,
      killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Diagnostics} diagnostics @param {Buffer} chunk */
function capture(diagnostics, chunk) {
  diagnostics.bytes += chunk.length;
  diagnostics.text += chunk.toString("utf8");
  if (diagnostics.text.length > MAX_LINE) {
    diagnostics.text = diagnostics.text.slice(-MAX_LINE);
    diagnostics.truncated = true;
  }
}

/** @param {number} pgid */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (record(error).code === 'ESRCH') return false;
    if (record(error).code === 'EPERM') return true;
    throw error;
  }
}

/** @param {PiTestRun} run */
function killGroup(run) {
  const pgid = run.process.pgid;
  if (pgid === null || !groupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
    run.cleanup.signals.push("SIGKILL");
  } catch (error) {
    if (record(error).code !== "ESRCH") throw error;
  }
}

export class PiWatchdogTimeout extends Error {
  /** @param {number} limitMs */
  constructor(limitMs) { super(`Pi exceeded ${limitMs} ms`); this.name = 'PiWatchdogTimeout'; }
}

export class PiTestError extends Error {
  /** @param {unknown} cause @param {PiTestRun} run */
  constructor(cause, run) {
    super(`${String(cause)}\nPiTestRun ${JSON.stringify(run, null, 2)}`, { cause });
    this.name = "PiTestError";
    this.run = run;
  }
}

/**
 * @typedef {{kind: 'packed'}} TestLaunch
 */
/**
 * @param {{ startFixture?: typeof startProvider, thinkingLevel?: 'off' | 'high', configureModels?: (paths: PiTestRun['paths'], baseUrl: string) => Promise<void>, launch?: TestLaunch, expectedExit?: {code: number | null, signal: NodeJS.Signals | null}, launchEnvironment?: NodeJS.ProcessEnv, observer?: import('./process-observer.mjs').ProcessObserver, verifyStopped?: (run: PiTestRun) => Promise<void>, fixture?: import("./provider.mjs").FixtureOptions, timeoutMs?: number, executable?: string, prompt?: string, packageFixture?: {root: string, files: string[]}, discoverResources?: boolean, allowDiagnostics?: boolean, expectedText?: string, expectedRequests?: number, setup?: (paths: PiTestRun['paths']) => Promise<void>, verify?: (run: PiTestRun) => Promise<void>, keepArtifacts?: boolean, onSpawn?: (pid: number) => void }} options
 * @returns {Promise<PiTestRun>}
 */
export async function runPiSmoke({ startFixture = startProvider, thinkingLevel = 'off', configureModels, launch = { kind: 'packed' }, launchEnvironment, expectedExit = { code: 0, signal: null }, observer, verifyStopped, fixture, timeoutMs = 20_000, executable = "pi", prompt = 'Return the fixture response.', packageFixture, discoverResources, allowDiagnostics = false, expectedText = FIXTURE_TEXT, expectedRequests = 1, setup, verify, keepArtifacts = false, onSpawn } = {}) {
  assert.notEqual(process.platform, "win32", "Pi process-group tests require Unix; Windows cleanup is unverified");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const started = Date.now();
  const root = await mkdtemp(join(await realpath(tmpdir()), "pstack-pi-test-"));
  /** @type {PiTestRun} */
  const run = {
    paths: { root, home: join(root, "home"), profile: join(root, "profile"), cwd: join(root, "work"), sessions: join(root, "sessions"), package: join(root, "relocated", "packed skills") },
    process: { executable, version: "", revision: "", args: [], pid: null, pgid: null },
    pack: { files: [], inventory: "", listing: "", shasum: "" },
    events: [],
    stdout: { text: "", bytes: 0, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    diagnostics: [],
    resources: null,
    exit: null,
    timeout: { limitMs: timeoutMs, expired: false },
    cleanup: { signals: [], remainingPids: [], groupAlive: false, providerClosed: false, tempRemoved: false },
    provider: null,
    durationMs: 0,
    observation: observer?.state ?? null,
  };
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env.PATH,
    HOME: run.paths.home,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(run.paths.home, ".config"),
    XDG_CACHE_HOME: join(run.paths.home, ".cache"),
    PI_CODING_AGENT_DIR: run.paths.profile,
    PI_CODING_AGENT_SESSION_DIR: run.paths.sessions,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
  };
  /** @type {Awaited<ReturnType<typeof startProvider>> | undefined} */
  let provider;
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
  let child;
  /** @type {Promise<void> | undefined} */
  let closed;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {unknown[]} */
  const failures = [];
  const parser = jsonlParser((event) => run.events.push(event));
  /** @param {string} command @param {string[]} args @param {string} [cwd] */
  const command = (command, args, cwd = run.paths.cwd) => runCommand(env, cwd, command, args);
  try {
    for (const path of [run.paths.home, run.paths.profile, run.paths.cwd, run.paths.sessions]) {
      await mkdir(path, { recursive: true });
    }
    run.process.revision = repositoryRevision(repository);
    const packageRoot = packageFixture?.root ?? repository;
    const inventory = packageFixture ? undefined : contentInventory(
      JSON.parse(await readFile(join(repository, 'sync/manifest.json'), 'utf8')),
      JSON.parse(await readFile(join(repository, 'sync/upstream.lock.json'), 'utf8')),
    );
    const expectedFiles = packageFixture?.files ?? (inventory ? expectedPackFiles(inventory) : []);
    const prepared = packageFixture
      ? await packOnce({ sourceRoot: packageRoot, files: expectedFiles, hold: root })
      : await preparePackedPackage({ sourceRoot: repository, files: expectedFiles, content: inventory });
    run.pack.files = prepared.files;
    run.pack.shasum = prepared.shasum;
    run.pack.inventory = prepared.inventory;
    await mkdir(join(root, "relocated"), { recursive: true });
    await extractPreparedPackage(prepared, run.paths.package);
    if (keepArtifacts && dirname(prepared.tarball) !== root) {
      await copyFile(prepared.tarball, join(root, basename(prepared.tarball)));
    }
    const manifest = JSON.parse(await readFile(join(run.paths.package, "package.json"), "utf8"));
    assert.equal(manifest.name, "@aaalexliu/pstack-pi");
    assert.equal(manifest.dependencies, undefined, "The packed package must not need an install step");
    await writeFile(join(run.paths.profile, "settings.json"), JSON.stringify({
      packages: [run.paths.package],
      enableInstallTelemetry: false,
      enableAnalytics: false,
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }));
    await setup?.(run.paths);
    const scanResources = discoverResources ?? Boolean(packageFixture);
    if (!resolvedPi || resolvedPi.executable !== executable) {
      const version = command(executable, ["--version"]).trim();
      assert.equal(version, "0.85.1", "Tests require Pi 0.85.1");
      const cliPath = await realpath(command("which", [executable]).trim());
      const resolveSdk = ["--input-type=module", "-e", "process.stdout.write(import.meta.resolve('@earendil-works/pi-coding-agent'))"];
      let sdk;
      try { sdk = command(process.execPath, resolveSdk, dirname(cliPath)); }
      catch { sdk = command(process.execPath, resolveSdk, join(dirname(dirname(cliPath)), "libexec/lib")); }
      resolvedPi = { executable, version, sdk };
    }
    run.process.version = resolvedPi.version;
    const sdk = resolvedPi.sdk;
    if (scanResources) {
      run.pack.listing = command(executable, ["list", "--no-approve"]);
      assert.ok(run.pack.listing.includes(run.paths.package), "Pi did not list the extracted package");
      const resourceOutput = command(process.execPath, ["--input-type=module", "-e", `
      const { DefaultResourceLoader } = await import(${JSON.stringify(sdk)});
      const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      const { extensions, errors } = loader.getExtensions();
      process.stdout.write(JSON.stringify({ type: 'resources',
        skills: skills.map(({ name, baseDir, disableModelInvocation }) => ({ name, baseDir, disableModelInvocation })),
        diagnostics, extensions: extensions.map(({ path }) => path), errors,
      }) + '\\n');
    `]);
      const resourceParser = jsonlParser((event) => {
        assert.equal(run.resources, null, "Expected one resource record");
        assert.equal(event.type, "resources");
        assert.ok(Array.isArray(event.diagnostics) && Array.isArray(event.errors));
        run.resources = event;
        run.diagnostics.push(...[...event.diagnostics, ...event.errors].map((item) => JSON.stringify(item)));
      });
      resourceParser.write(Buffer.from(resourceOutput));
      resourceParser.end();
      assert.ok(run.resources, "Missing resource record");
    }
    provider = await startFixture(fixture);
    run.provider = provider.state;
    await writeFile(join(run.paths.profile, "models.json"), JSON.stringify({
      providers: {
        "pi-fixture": {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: FIXTURE_KEY,
          models: [{ id: FIXTURE_MODEL, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 128 }],
        },
      },
    }));
    await configureModels?.(run.paths, provider.baseUrl);
    const invocation = { node: await realpath(process.execPath), cli: await realpath(join(dirname(fileURLToPath(sdk)), 'cli.js')) };
    switch (launch.kind) {
      case 'packed':
        run.process.args = [invocation.cli,
          '--mode', 'json', '--print', '--offline', '--no-approve', '--no-context-files',
          '--provider', 'pi-fixture', '--model', FIXTURE_MODEL, '--thinking', thinkingLevel,
          '--session-dir', run.paths.sessions, '--', prompt,
        ];
        break;
      default: throw new Error('Unknown test launch');
    }
    run.process.executable = invocation.node;
    const pi = spawn(invocation.node, run.process.args, { cwd: run.paths.cwd, env: { ...env, ...launchEnvironment }, detached: true, shell: false, stdio: 'pipe' });
    child = pi;
    run.process.pid = pi.pid ?? null;
    run.process.pgid = pi.pid ?? null;

    closed = new Promise((resolve) => {
      pi.once("close", (code, signal) => {
        run.exit = { code, signal };
        resolve();
      });
    });
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        run.timeout.expired = true;
        try { observer?.watchdog(); } catch (error) { failures.push(error); }
        reject(new PiWatchdogTimeout(timeoutMs));
      }, timeoutMs);
      if (pi.pid !== undefined) {
        observer?.start(pi.pid, invocation, reject);
        onSpawn?.(pi.pid);
      }
      pi.once("error", reject);
      pi.stdin.on("error", reject);
      pi.stdout.on("data", (chunk) => {
        capture(run.stdout, chunk);
        try { parser.write(chunk); } catch (error) { reject(error); }
      });
      pi.stderr.on("data", (chunk) => {
        capture(run.stderr, chunk);
        if (run.stderr.bytes > MAX_OUTPUT) reject(new Error("Pi stderr exceeded 1 MiB"));
      });
      void closed?.then(() => resolve(undefined));
      pi.stdin.end();
    });
    assert.equal(run.timeout.expired, false);
    assert.deepEqual(run.exit, expectedExit, "Pi did not exit as expected");
    run.diagnostics.push(...[run.stderr.text, ...run.events.filter((event) => /warning|diagnostic|error/i.test(event.type)).map((event) => JSON.stringify(event))].filter(Boolean));
    if (!allowDiagnostics) assert.deepEqual(run.diagnostics, [], 'Pi emitted diagnostics');
    assert.equal(run.events[0]?.type, "session");
    assert.equal(run.events[0]?.cwd, run.paths.cwd);
    if (expectedExit.code === 0) {
      assert.ok(run.events.some((event) => event.type === "agent_settled"), "Pi did not emit agent_settled");
      const terminal = run.events.findLast((event) => event.type === "message_end" && record(event.message).role === "assistant");
      assert.ok(terminal, "Pi did not emit a terminal assistant message");
      const message = record(terminal.message);
      assert.equal(message.stopReason, "stop", `Pi failed the assistant turn: ${message.errorMessage}`);
      assert.equal(message.provider, "pi-fixture");
      assert.equal(message.model, FIXTURE_MODEL);
      assert.ok(Array.isArray(message.content));
      const text = message.content.map((block) => {
        const content = record(block);
        assert.equal(content.type, "text");
        assert.equal(typeof content.text, "string");
        return content.text;
      }).join("");
      assert.equal(text, expectedText, "Wrong terminal assistant text");
      const usage = record(message.usage);
      assert.equal(usage.input, FIXTURE_USAGE.input);
      assert.equal(usage.output, FIXTURE_USAGE.output);
      assert.equal(usage.totalTokens, FIXTURE_USAGE.totalTokens);
      assert.ok(run.events.findIndex((event) => event.type === "agent_settled") > run.events.indexOf(terminal));
    }
    assert.equal(provider.state.requests, expectedRequests);
    assert.deepEqual(provider.state.errors, []);
    assert.ok(run.process.pgid !== null && !groupAlive(run.process.pgid), "Pi left a live descendant");
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('pstack-subagent-')), 'Child left a temporary prompt');
    await verify?.(run);
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    observer?.stop();
    try {
      killGroup(run);
      if (closed) await Promise.race([closed, delay(2_000, undefined, { ref: false })]);
      const pgid = run.process.pgid;
      if (pgid !== null) {
        const deadline = Date.now() + 2_000;
        while (groupAlive(pgid) && Date.now() < deadline) await delay(25);
        run.cleanup.groupAlive = groupAlive(pgid);
        if (run.cleanup.groupAlive) {
          run.cleanup.remainingPids = command("ps", ["-axo", "pid=,pgid="]).trim().split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number))
            .filter(([, group]) => group === pgid).map(([pid]) => pid);
          throw new Error("Pi process group survived cleanup");
        }
      }
    } catch (error) { failures.push(error); }
    try {
      if (child) parser.end();
      if (observer?.state.rootPid) observer.verifyCleanup();
    } catch (error) { failures.push(error); }
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    try {
      await provider?.close();
      run.cleanup.providerClosed = provider?.state.closed ?? true;
    } catch (error) { failures.push(error); }
    try { await verifyStopped?.(run); } catch (error) { failures.push(error); }
    try {
      if (!keepArtifacts) {
        await rm(root, { recursive: true, force: true });
        run.cleanup.tempRemoved = true;
      }
    } catch (error) { failures.push(error); }
    run.durationMs = Date.now() - started;
    if (keepArtifacts) {
      try { await writeFile(join(root, 'run.json'), JSON.stringify(run, null, 2)); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new PiTestError(new AggregateError(failures, failures.map(String).join("\n")), run);
  return run;
}
