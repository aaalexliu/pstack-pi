import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import interactiveSubagents, * as subagentsModule from "../pi-extension/subagents/index.ts";
import { isMuxAvailable } from "../pi-extension/subagents/cmux.ts";
import { spawnHeadless, waitForHeadlessExit } from "../pi-extension/subagents/headless.ts";

const SPAWNING_TOOLS = ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"];
const CHILD_ENV = ["PI_SUBAGENT_NAME", "PI_DENY_TOOLS"] as const;
const saved = Object.fromEntries(CHILD_ENV.map((name) => [name, process.env[name]]));

function fakePi() {
  const tools: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools: () => [],
  };
  return { api: api as any, tools, handlers };
}

/** Load the subagents extension the way Pi loads the package in a process with this env. */
function toolsWith(env: Partial<Record<(typeof CHILD_ENV)[number], string>>) {
  for (const name of CHILD_ENV) delete process.env[name];
  Object.assign(process.env, env);
  const pi = fakePi();
  interactiveSubagents(pi.api);
  return pi;
}

afterEach(() => {
  for (const name of CHILD_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("delegation tools in pstack-pi processes", () => {
  it("gives the root every delegation tool", () => {
    const { tools } = toolsWith({});
    for (const tool of SPAWNING_TOOLS) assert.ok(tools.includes(tool), tool);
  });

  it("gives a child that denies them none, and does no UI work there", async () => {
    const { tools, handlers } = toolsWith({ PI_DENY_TOOLS: SPAWNING_TOOLS.join(",") });
    for (const tool of SPAWNING_TOOLS) assert.ok(!tools.includes(tool), tool);

    const uiCalls: string[] = [];
    const ui = new Proxy({}, { get: (_target, name) => () => uiCalls.push(String(name)) });
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { ui, hasUI: false });
    assert.deepEqual(uiCalls, []);
  });

  it("gives an interactive child neither unless its agent says spawning: true", () => {
    const denied = toolsWith({ PI_SUBAGENT_NAME: "Scout", PI_DENY_TOOLS: SPAWNING_TOOLS.join(",") }).tools;
    for (const tool of SPAWNING_TOOLS) assert.ok(!denied.includes(tool), tool);

    const spawning = toolsWith({ PI_SUBAGENT_NAME: "Planner" }).tools;
    for (const tool of SPAWNING_TOOLS) assert.ok(spawning.includes(tool), tool);
  });
});

describe("subagent role and model", () => {
  const api = () => (subagentsModule as any).__test__;
  const parent = { provider: "parent", id: "model" };
  let dir: string;
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
  });

  it("resolves explicit model, call role, agent role, agent model, then the parent model", async () => {
    dir = mkdtempSync(join(tmpdir(), "subagent-role-"));
    mkdirSync(join(dir, "pstack-pi"));
    writeFileSync(join(dir, "pstack-pi", "models.json"), JSON.stringify({ version: 1, roles: { review: "role/review:xhigh", scout: "role/scout" } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    const resolve = (params: object, defs: object | null) => api().resolvePiChildModel(params, defs, parent);
    assert.equal(await resolve({ model: "x/explicit", role: "scout" }, { role: "review" }), "x/explicit");
    assert.equal(await resolve({ role: "scout" }, { role: "review" }), "role/scout");
    assert.equal(await resolve({}, { role: "review", model: "a/b" }), "role/review:xhigh");
    assert.equal(await resolve({}, { role: "judgment", model: "a/b" }), "a/b");
    assert.equal(await resolve({}, { role: "judgment" }), "parent/model");
    assert.equal(await resolve({}, null), "parent/model");
  });

  it("builds the child's --model argv from a configured role, the parent fallback, and a role's thinking suffix", async () => {
    dir = mkdtempSync(join(tmpdir(), "subagent-argv-"));
    mkdirSync(join(dir, "pstack-pi"));
    writeFileSync(join(dir, "pstack-pi", "models.json"), JSON.stringify({ version: 1, roles: { review: "role/review:xhigh", judgment: "role/judgment" } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    const argv = (params: object, defs: object | null) => api().piModelArgs(params, defs, parent);
    assert.deepEqual(await argv({}, { role: "judgment", model: "old/pin", thinking: "medium" }), ["--model", "role/judgment:medium"]);
    assert.deepEqual(await argv({}, { role: "review", thinking: "medium" }), ["--model", "role/review:xhigh"]);
    assert.deepEqual(await argv({}, { thinking: "minimal" }), ["--model", "parent/model:minimal"]);
    assert.deepEqual(await argv({ model: "x/explicit" }, { role: "review" }), ["--model", "x/explicit"]);
    assert.deepEqual(await api().piModelArgs({}, null, undefined), []);
  });

  it("the subagent tool takes a role from the shared list", () => {
    for (const name of CHILD_ENV) delete process.env[name];
    const pi = fakePi();
    const schemas: any[] = [];
    interactiveSubagents({ ...pi.api, registerTool: (tool: any) => schemas.push(tool) });
    const subagent = schemas.find((tool) => tool.name === "subagent");
    assert.ok(Check(subagent.parameters, { name: "n", task: "t", role: "review" }));
    assert.ok(!Check(subagent.parameters, { name: "n", task: "t", role: "nope" }));
  });

  it("bundled agents pin roles, not stale model ids", () => {
    const defaults = (name: string) => api().loadAgentDefaults(name);
    assert.deepEqual([defaults("reviewer").role, defaults("reviewer").model], ["review", undefined]);
    assert.deepEqual([defaults("planner").role, defaults("planner").model], ["judgment", undefined]);
    assert.deepEqual([defaults("scout").role, defaults("scout").model], ["scout", undefined]);
    for (const name of ["worker", "visual-tester"]) assert.deepEqual([defaults(name).role, defaults(name).model], [undefined, undefined], name);
    assert.equal(defaults("claude-code").model, "sonnet");
  });
});

describe("runSubagentToEnd, the runner behind wait: true", () => {
  const api = () => (subagentsModule as any).__test__;
  const slots = () => api().spawnSlots;
  const params = { name: "child", task: "do it" };
  const ctx = {} as any;
  const running = { id: "x", name: "child" } as any;
  const done = async () => ({ name: "child", task: "do it", summary: "done", exitCode: 0, elapsed: 0 });
  afterEach(() => slots().clear());

  async function start(hasUI: boolean) {
    const pi = fakePi();
    interactiveSubagents(pi.api);
    for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, { hasUI, ui: { setWidget() {} } });
    return pi;
  }

  it("waits for a slot past the cap, and an abort drops the wait", { timeout: 2000 }, async () => {
    await start(false);
    for (let i = 0; i < 4; i++) slots().take(`tool-${i}`);
    const stop = new AbortController();
    const pending = api().runSubagentToEnd(params, ctx, stop.signal, undefined, () => assert.fail("launched past the cap"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(slots().waiting.map((entry: { name: string }) => entry.name), ["child"]);
    stop.abort();
    assert.equal((await pending).error, "cancelled");
    assert.equal(slots().held, 4);
    assert.deepEqual(slots().waiting, []);
  });

  it("launches with auto-exit, the append system prompt, and the thinking level", async () => {
    await start(false);
    let options: unknown;
    const result = await api().runSubagentToEnd(params, ctx, new AbortController().signal, "low",
      async (_params: unknown, _ctx: unknown, given: unknown) => { options = given; return running; }, done);
    assert.equal(result.summary, "done");
    assert.deepEqual(options, { autoExit: true, systemPromptMode: "append", thinking: "low", headless: !isMuxAvailable() });
  });

  it("passes the call's thinking level through", async () => {
    let seen: unknown;
    await api().runSubagentAndWait({ ...params, thinking: "high" }, ctx, undefined,
      async (_params: unknown, _ctx: unknown, _signal: unknown, thinking: unknown) => { seen = thinking; return done(); });
    assert.equal(seen, "high");
  });

  it("frees its slot when the launch fails", async () => {
    await start(false);
    await assert.rejects(api().runSubagentToEnd(params, ctx, new AbortController().signal, undefined,
      async () => { throw new Error("no pane"); }), /no pane/);
    assert.equal(slots().held, 0);
  });

  it("starts the widget timer only when the parent has a UI", async () => {
    const timer = Symbol.for("pi-subagents/widget-interval");
    for (const hasUI of [false, true]) {
      await start(hasUI);
      let seen: unknown;
      await api().runSubagentToEnd(params, ctx, new AbortController().signal, undefined, async () => running,
        async () => { seen = (globalThis as any)[timer]; return done(); });
      assert.equal(Boolean(seen), hasUI);
      clearInterval((globalThis as any)[timer]);
      (globalThis as any)[timer] = null;
    }
  });
});

describe("subagent with wait: true", () => {
  const fakePiScript = join(dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs");
  const ENV = ["PI_SUBAGENT_MUX", "TMUX", "PI_CODING_AGENT_DIR", "PATH", "CMUX_SOCKET_PATH"] as const;
  const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const savedScript = process.argv[1];
  let root: string;
  let shutdown = async () => {};

  /** Fail the test instead of hanging when a file never appears. */
  async function waitForFile(file: string) {
    const deadline = Date.now() + 5000;
    while (!existsSync(file)) {
      assert.ok(Date.now() < deadline, `${file} never appeared`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** A root Pi with no multiplexer whose children are the fake Pi. */
  async function setup() {
    for (const name of CHILD_ENV) delete process.env[name];
    root = mkdtempSync(join(tmpdir(), "subagent-wait-"));
    process.env.PI_SUBAGENT_MUX = "tmux";
    delete process.env.TMUX;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.argv[1] = fakePiScript;
    const tools = new Map<string, any>();
    const messages: any[] = [];
    const base = fakePi();
    const pi = { ...base.api, registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage: (message: any) => messages.push(message) };
    interactiveSubagents(pi);
    shutdown = async () => { for (const handler of base.handlers.get("session_shutdown") ?? []) await handler({}, {}); };
    const sessionFile = join(root, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const ctx = {
      cwd: root,
      hasUI: false,
      model: { provider: "parent", id: "model" },
      sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent-id", getSessionDir: () => root, getSessionName: () => undefined },
    };
    const call = (params: object, signal = new AbortController().signal) => tools.get("subagent").execute("call", params, signal, undefined, ctx);
    return { call, messages };
  }

  afterEach(async () => {
    await shutdown();
    shutdown = async () => {};
    process.argv[1] = savedScript;
    for (const name of ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    (subagentsModule as any).__test__.spawnSlots.clear();
  });

  it("outside cmux and tmux runs the child headless and returns its result with the model and session lines", async () => {
    const { call } = await setup();
    const result = await call({ name: "Look", task: "hello", wait: true });
    const text: string = result.content[0].text;
    const [model, id, path] = text.split("\n");
    assert.equal(model, "resolved-model: parent/model");
    assert.equal(id, "session-id: child-session-id");
    assert.match(path, /^session-path: .*\.jsonl$/);
    assert.ok(existsSync(path.slice("session-path: ".length)));
    const child = JSON.parse(text.slice(text.indexOf("done ") + 5));
    assert.equal(child.args[0], "-p");
    assert.equal(child.autoExit, "1");
    assert.ok(child.denied.split(",").includes("subagent"));
    assert.equal(result.isError, false);
    assert.equal(result.details.status, "finished");
  });

  it("stops a child that runs past timeoutMs, with its whole process group", async () => {
    const { call } = await setup();
    const pidFile = join(root, "pid");
    const result = await call({ name: "Stuck", task: `HANG ${pidFile}`, wait: true, timeoutMs: 500 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out after 500 ms/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it("reports a child that exits non-zero as an error, with its stderr", async () => {
    const { call } = await setup();
    const result = await call({ name: "Broken", task: "FAIL", wait: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /child exploded/);
  });

  it("throws when the parent aborts, and kills the child", async () => {
    const { call } = await setup();
    const pidFile = join(root, "pid");
    const stop = new AbortController();
    const pending = call({ name: "Stuck", task: `HANG ${pidFile}`, wait: true }, stop.signal);
    await waitForFile(pidFile);
    stop.abort();
    await assert.rejects(pending, /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
  });

  it("runs two wait calls side by side", async () => {
    const { call } = await setup();
    const logs = [join(root, "a.log"), join(root, "b.log")];
    const results = await Promise.all(logs.map((log, i) => call({ name: `Slow ${i}`, task: `SLOW 400 ${log}`, wait: true })));
    for (const result of results) assert.equal(result.isError, false);
    const times = logs.map((log) => Object.fromEntries(readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")).map(([k, v]) => [k, Number(v)])));
    assert.ok(times[0].start < times[1].end && times[1].start < times[0].end, JSON.stringify(times));
  });

  it("without wait, launches headless and delivers the result later as a new turn", async () => {
    const { call, messages } = await setup();
    const result = await call({ name: "Background", task: "hello" });
    assert.equal(result.details.status, "started");
    const deadline = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages[0]?.customType, "subagent_result");
    assert.match(messages[0].content, /completed[\s\S]*done /);
  });

  it("runs the child headless when cmux looks available but its pane will not open", async () => {
    const { call, messages } = await setup();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cmux"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, "cmux.log"))}\necho "Error: workspace create failed" >&2\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.PI_SUBAGENT_MUX = "cmux";
    process.env.CMUX_SOCKET_PATH = join(root, "no-such.sock");
    assert.ok(isMuxAvailable());

    const waited = await call({ name: "Fallback", task: "hello", wait: true });
    assert.equal(waited.isError, false, waited.content[0].text);
    assert.match(waited.content[0].text, /^resolved-model: parent\/model\n/);
    assert.equal(JSON.parse(waited.content[0].text.slice(waited.content[0].text.indexOf("done ") + 5)).args[0], "-p");

    assert.equal((await call({ name: "Background", task: "hello" })).details.status, "started");
    const deadline = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(messages[0]?.content ?? "", /completed[\s\S]*done /);
    assert.match(readFileSync(join(root, "cmux.log"), "utf8"), /workspace/);
  });

  it("kills a descendant that ignores SIGTERM after the grace period, even once the direct child is gone", async () => {
    root = mkdtempSync(join(tmpdir(), "subagent-group-"));
    const pidFile = join(root, "grandchild.pid");
    const script = join(root, "parent.mjs");
    writeFileSync(script, `import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    process.argv[1] = script;
    const proc = spawnHeadless([], { cwd: root, env: process.env });
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const stop = new AbortController();
    const exit = waitForHeadlessExit(proc, stop.signal, 200);
    stop.abort();
    assert.equal((await exit).aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, "SIGKILL");
    assert.equal(alive, false, "the descendant outlived the grace period");
  });

  it("refuses subagent_interrupt for a headless child, which has no pane", () => {
    const api = (subagentsModule as any).__test__;
    api.runningSubagents.set("h", { id: "h", name: "Headless", surface: "", statusState: {} });
    try {
      const result = api.handleSubagentInterrupt({ id: "h" }, () => assert.fail("sent Escape"));
      assert.match(result.content[0].text, /headless/);
    } finally {
      api.runningSubagents.delete("h");
    }
  });
});
