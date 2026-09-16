#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

export const PI_UNIT_TESTS = [
  "tests/pi/concurrent-provider.test.mjs",
  "tests/pi/provider.test.mjs",
  "tests/pi/unit.test.mjs",
];

const packedIsolation = [
  "--experimental-test-isolation=none",
  "--test-concurrency=1",
];

const nodeTest = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  "--test",
];

/** @param {string} file */
function isPackedPiTest(file) {
  return file.startsWith("tests/pi/") && !PI_UNIT_TESTS.includes(file);
}

/** @param {string[]} files */
export function classifyTestFiles(files) {
  return {
    packed: files.filter(isPackedPiTest).sort(),
    nonpacked: files.filter((file) => !isPackedPiTest(file)).sort(),
  };
}

/** @param {string} root */
export async function listTestFiles(root = repository) {
  const found = /** @type {string[]} */ ([]);
  /** @param {string} directory */
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "vendor") continue;
        await walk(path);
        continue;
      }
      if (entry.name.endsWith(".test.mjs")) found.push(relative(root, path));
    }
  }
  await walk(join(root, "tests"));
  return found.sort();
}

/** @param {string[]} args @param {string[]} files */
function runNodeTest(args, files) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeTest[0], [...nodeTest.slice(1), ...args, ...files], {
      cwd: repository,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`node --test exited with ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

const mode = process.argv[2];
const invokedAsCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  const files = await listTestFiles();
  const { packed, nonpacked } = classifyTestFiles(files);
  /** @type {number} */
  let code = 0;
  if (mode === "fast") code = await runNodeTest([], nonpacked);
  else if (mode === "full") {
    code = await runNodeTest([], nonpacked);
    if (code === 0) code = await runNodeTest(packedIsolation, packed);
  } else if (mode === "pi") {
    code = await runNodeTest([], PI_UNIT_TESTS);
    if (code === 0) code = await runNodeTest(packedIsolation, packed);
  } else if (mode === "pi:unit") code = await runNodeTest([], PI_UNIT_TESTS);
  else {
    console.error("Usage: node scripts/run-tests.mjs fast|full|pi|pi:unit");
    code = 2;
  }
  process.exit(code);
}
