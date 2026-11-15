// Stands in for `pi -p` in headless subagent tests. The task file's last line picks the behavior:
// HANG <file> writes its pid and never exits, SLOW <ms> <log> logs start and end, FAIL exits 3.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const sessionFile = flag("--session");
const taskArg = args.at(-1) ?? "";
const task = taskArg.startsWith("@") ? readFileSync(taskArg.slice(1), "utf8") : taskArg;
const [verb, ...rest] = task.trim().split("\n").filter((line) => line.trim() && !line.startsWith("Your FINAL")).at(-1).trim().split(" ");

if (verb === "HANG") {
  writeFileSync(rest[0], String(process.pid));
  setInterval(() => {}, 1000);
} else if (verb === "FAIL") {
  process.stderr.write("child exploded\n");
  process.exit(3);
} else {
  if (verb === "SLOW") {
    appendFileSync(rest[1], `start ${Date.now()}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(rest[0])));
    appendFileSync(rest[1], `end ${Date.now()}\n`);
  }
  const model = (flag("--model") ?? "fixture/model").replace(/:[a-z]+$/, "");
  const capture = JSON.stringify({ args, cwd: process.cwd(), denied: process.env.PI_DENY_TOOLS, autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, pid: process.pid });
  const lines = [
    { type: "session", version: 3, id: "child-session-id", cwd: process.cwd() },
    { type: "message", id: "m1", message: { role: "assistant", provider: model.split("/")[0], model: model.split("/")[1], content: [{ type: "text", text: `done ${capture}` }] } },
  ];
  writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}
