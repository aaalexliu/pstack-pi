import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import interactiveSubagents from "../pi-extension/subagents/index.ts";
import blockingSubagent from "../../subagent/index.ts";

const SPAWNING_TOOLS = ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"];
const CHILD_ENV = ["PSTACK_SUBAGENT_DEPTH", "PI_SUBAGENT_NAME", "PI_DENY_TOOLS"] as const;
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
    const { tools, handlers } = toolsWith({ PSTACK_SUBAGENT_DEPTH: "1" });
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(!tools.includes(tool), tool);

    const uiCalls: string[] = [];
    const ui = new Proxy({}, { get: (_target, name) => () => uiCalls.push(String(name)) });
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { ui, hasUI: false });
    assert.deepEqual(uiCalls, []);
  });

  it("gives an interactive child neither unless its agent says spawning: true", () => {
    const denied = toolsWith({
      PSTACK_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_NAME: "Scout",
      PI_DENY_TOOLS: SPAWNING_TOOLS.join(","),
    }).tools;
    for (const tool of [...SPAWNING_TOOLS, "blocking_subagent"]) assert.ok(!denied.includes(tool), tool);

    const spawning = toolsWith({ PSTACK_SUBAGENT_DEPTH: "1", PI_SUBAGENT_NAME: "Planner" }).tools;
    for (const tool of SPAWNING_TOOLS) assert.ok(spawning.includes(tool), tool);
    assert.ok(!spawning.includes("blocking_subagent"));
  });
});
