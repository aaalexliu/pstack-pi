import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import interactiveSubagents, * as subagentsModule from "../pi-extension/subagents/index.ts";
import blockingSubagent, { childEnvironment } from "../../subagent/index.ts";

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

/** Load both pstack-pi delegation extensions the way Pi loads the package in a process with this env. */
function toolsWith(env: Partial<Record<(typeof CHILD_ENV)[number], string>>) {
  for (const name of CHILD_ENV) delete process.env[name];
  Object.assign(process.env, env);
  const pi = fakePi();
  interactiveSubagents(pi.api);
  blockingSubagent(pi.api, { env: process.env });
  return pi;
}

afterEach(() => {
  for (const name of CHILD_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("delegation tools in pstack-pi processes", () => {
  it("gives the root both the interactive tools and blocking_subagent", () => {
    const { tools } = toolsWith({});
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(tools.includes(tool), tool);
  });

  it("gives a blocking_subagent child neither, and does no UI work there", async () => {
    const { tools, handlers } = toolsWith({ PI_DENY_TOOLS: childEnvironment({}).PI_DENY_TOOLS });
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(!tools.includes(tool), tool);

    const uiCalls: string[] = [];
    const ui = new Proxy({}, { get: (_target, name) => () => uiCalls.push(String(name)) });
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { ui, hasUI: false });
    assert.deepEqual(uiCalls, []);
  });

  it("gives an interactive child neither unless its agent says spawning: true", () => {
    const denied = toolsWith({ PI_SUBAGENT_NAME: "Scout", PI_DENY_TOOLS: [...SPAWNING_TOOLS, "blocking_subagent"].join(",") }).tools;
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(!denied.includes(tool), tool);

    const spawning = toolsWith({ PI_SUBAGENT_NAME: "Planner" }).tools;
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(spawning.includes(tool), tool);
  });

  it("denies blocking_subagent with the other spawning tools when an agent file has no spawning: true", () => {
    const denied = subagentsModule.__test__.resolveDenyTools(null);
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(denied.has(tool), tool);
    assert.ok(!subagentsModule.__test__.resolveDenyTools({ spawning: true } as any).has("blocking_subagent"));
  });
});

describe("subagent role and model, shared with blocking_subagent", () => {
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

describe("runSubagentInPane, the runner blocking_subagent uses", () => {
  const key = Symbol.for("pstack-pi/interactive-subagents/pane-runner");
  const slots = () => (subagentsModule as any).__test__.spawnSlots;
  const params = { name: "child", task: "do it" };
  const ctx = {} as any;
  const running = { id: "x", name: "child" } as any;
  afterEach(() => slots().clear());

  async function start(hasUI: boolean) {
    const pi = fakePi();
    interactiveSubagents(pi.api);
    for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, { hasUI, ui: { setWidget() {} } });
    return pi;
  }

  it("is the live module's runner, so blocking children share the subagent tool's slots", { timeout: 2000 }, async () => {
    await start(false);
    const published = (globalThis as any)[key];
    assert.equal(published.runSubagentInPane, subagentsModule.runSubagentInPane);
    for (let i = 0; i < 4; i++) slots().take(`tool-${i}`);
    const stop = new AbortController();
    const pending = published.runSubagentInPane(params, ctx, stop.signal, undefined, () => assert.fail("launched past the cap"));
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
    const result = await subagentsModule.runSubagentInPane(params, ctx, new AbortController().signal, "low",
      async (_params, _ctx, given) => { options = given; return running; },
      async () => ({ name: "child", task: "do it", summary: "done", exitCode: 0, elapsed: 0 }));
    assert.equal(result.summary, "done");
    assert.deepEqual(options, { autoExit: true, systemPromptMode: "append", thinking: "low" });
  });

  it("frees its slot when the launch fails", async () => {
    await start(false);
    await assert.rejects(subagentsModule.runSubagentInPane(params, ctx, new AbortController().signal, undefined,
      async () => { throw new Error("no pane"); }), /no pane/);
    assert.equal(slots().held, 0);
  });

  it("starts the widget timer only when the parent has a UI", async () => {
    const timer = Symbol.for("pi-subagents/widget-interval");
    for (const hasUI of [false, true]) {
      await start(hasUI);
      let seen: unknown;
      await subagentsModule.runSubagentInPane(params, ctx, new AbortController().signal, undefined, async () => running,
        async () => { seen = (globalThis as any)[timer]; return { name: "child", task: "do it", summary: "done", exitCode: 0, elapsed: 0 }; });
      assert.equal(Boolean(seen), hasUI);
      clearInterval((globalThis as any)[timer]);
      (globalThis as any)[timer] = null;
    }
  });
});
