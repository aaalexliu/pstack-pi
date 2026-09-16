import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { checkContent, expectedPackFiles } from '../../scripts/check-content.mjs';
import { contentFixture, skillText } from '../content/fixture.mjs';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/sync-upstream.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const productionSkills = [
  'architect', 'arena', 'automate-me', 'blast-radius',
  'bro', 'create-verification-skill', 'figure-it-out', 'how',
  'interrogate', 'maintain-verification-skill', 'make-bot-ui', 'no-comments',
  'poteto-mode', 'principle-attack-the-premise', 'principle-boundary-discipline', 'principle-build-the-lever',
  'principle-encode-lessons-in-structure', 'principle-exhaust-the-design-space', 'principle-experience-first', 'principle-fix-root-causes',
  'principle-foundational-thinking', 'principle-guard-the-context-window', 'principle-laziness-protocol', 'principle-make-operations-idempotent',
  'principle-migrate-callers-then-delete-legacy-apis', 'principle-minimize-reader-load', 'principle-model-the-domain', 'principle-never-block-on-the-human',
  'principle-outcome-oriented-execution', 'principle-prove-it-works', 'principle-redesign-from-first-principles', 'principle-separate-before-serializing-shared-state',
  'principle-sequence-verifiable-units', 'principle-subtract-before-you-add', 'principle-test-behavior-not-implementation', 'principle-type-system-discipline',
  'recall', 'reflect', 'setup-pstack', 'show-me-your-work',
  'swarm', 'tdd', 'teach', 'technical-writing',
  'typescript-best-practices', 'unslop', 'why',
];
const exactExpansionSkills = ['bro', 'poteto-mode', 'principle-model-the-domain'];

async function productionInventory() {
  return checkContent({ root: repository,
    manifest: JSON.parse(await readFile(join(repository, 'sync/manifest.json'), 'utf8')),
    lock: JSON.parse(await readFile(join(repository, 'sync/upstream.lock.json'), 'utf8')),
  });
}

/** @param {import('./runner.mjs').PiTestRun} run */
function assertOnlyDeclaredTools(run) {
  assert.deepEqual(run.diagnostics, []);
  const runtime = run.pack.files.includes('extensions/subagent/index.ts');
  assert.deepEqual(run.resources?.extensions, runtime ? [join(run.paths.package, 'extensions/pstack/index.ts'), join(run.paths.package, 'extensions/subagent/index.ts')] : []);
  const tools = run.provider?.decodedRequests[0]?.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['bash', 'edit', ...(runtime ? ['pstack_config', 'pstack_papercut', 'pstack_sessions', 'pstack_todo'] : []), 'read', ...(runtime ? ['subagent'] : []), 'write']);
  assert.ok(!run.events.some((event) => event.type.startsWith('tool_execution')));
}
import { PiTestError, runPiSmoke } from "./runner.mjs";

/** @param {import("./runner.mjs").PiTestRun} run */
function assertClean(run) {
  assert.equal(run.cleanup.groupAlive, false);
  assert.deepEqual(run.cleanup.remainingPids, []);
  assert.equal(run.cleanup.providerClosed, true);
  assert.equal(run.cleanup.tempRemoved, true);
  assert.equal(existsSync(run.paths.root), false);
  const { pid, pgid } = run.process;
  if (pid !== null) {
    assert.ok(pgid !== null);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
  }
}

test("real Pi loads the packed package and settles with fixture text and usage", async (context) => {
  const run = await runPiSmoke();
  assertClean(run);
  assert.deepEqual(run.cleanup.signals, []);
  assert.deepEqual(run.pack.files, expectedPackFiles(await productionInventory()));
  assert.equal(run.pack.files.length, 107);
  assertOnlyDeclaredTools(run);
  context.diagnostic(JSON.stringify({
    pi: run.process.version, revision: run.process.revision, pid: run.process.pid,
    events: run.events.map((event) => event.type), durationMs: run.durationMs,
    requests: run.provider?.requests, exit: run.exit, cleanup: run.cleanup,
    pack: run.pack.files, shasum: run.pack.shasum,
  }));
});

test("smoke rejects wrong terminal text without a timeout", async () => {
  await assert.rejects(runPiSmoke({ fixture: { text: "controlled wrong response" } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /Wrong terminal assistant text/);
    assert.equal(error.run.timeout.expired, false);
    assert.equal(error.run.provider?.requests, 1);
    assert.ok(error.run.events.some((event) => event.type === "agent_settled"));
    assertClean(error.run);
    return true;
  });
});

test("provider errors retain diagnostics and clean up", async () => {
  await assert.rejects(runPiSmoke({ fixture: { mode: "error" } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /controlled fixture error/);
    assert.equal(error.run.timeout.expired, false);
    assertClean(error.run);
    return true;
  });
});

test("deadline kills the owned Pi process group", async () => {
  await assert.rejects(runPiSmoke({ fixture: { mode: "stall" }, timeoutMs: 5_000 }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.equal(error.run.timeout.expired, true);
    assert.deepEqual(error.run.cleanup.signals, ["SIGKILL"]);
    assert.equal(error.run.exit?.signal, "SIGKILL");
    assertClean(error.run);
    return true;
  });
});

/** @param {import('./runner.mjs').PiTestRun} run @returns {string} */
function requestUserText(run) {
  const request = run.provider?.decodedRequests[0];
  assert.ok(request && Array.isArray(request.messages));
  const users = request.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 1);
  const content = users[0].content;
  assert.ok(Array.isArray(content));
  return content.map((block) => {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
    return block.text;
  }).join('');
}

for (const name of exactExpansionSkills) {
  test(`real packed Pi expands /skill:${name} with exact body, arguments, and relocated paths`, async (t) => {
    const inventory = await productionInventory();
    assert.deepEqual([...inventory.bySkillName.keys()].sort(), productionSkills);
    const skill = inventory.bySkillName.get(name);
    assert.ok(skill);
    const run = await runPiSmoke({ prompt: `/skill:${name} inspect α` });
    assertClean(run);
    assertOnlyDeclaredTools(run);
    const location = join(run.paths.package, skill.destination);
    const user = requestUserText(run);
    assert.equal(user, `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${skill.body}\n</skill>\n\ninspect α`);
    assert.ok(!user.includes(repository));
    const discovered = run.resources?.skills;
    assert.ok(Array.isArray(discovered));
    assert.deepEqual(discovered.map((entry) => entry.name).sort(), productionSkills);
    assert.ok(discovered.every((entry) => entry.disableModelInvocation === true && entry.baseDir.startsWith(run.paths.package + '/')));
    const messages = run.provider?.decodedRequests[0]?.messages;
    assert.ok(Array.isArray(messages));
    const system = JSON.stringify(messages.filter((message) => message.role === 'system'));
    for (const selected of inventory.bySkillName.values()) assert.ok(!system.includes(selected.description), 'Manual skill leaked into model discovery');
    if (name === 'poteto-mode') {
      assert.ok(system.includes('Pstack Poteto Mode is active'));
      assert.ok(system.includes(join(run.paths.package, 'skills/poteto-mode/SKILL.md')));
    }
    const request = run.provider?.decodedRequests[0];
    const tools = request && Array.isArray(request.tools) ? request.tools.map((/** @type {any} */ tool) => tool.function.name).sort() : [];
    t.diagnostic(JSON.stringify({ name, pi: run.process.version, bodySha256: sha256(skill.body), userBytes: Buffer.byteLength(user), location, tools, diagnostics: run.diagnostics, cleanup: run.cleanup }));
  });
}

for (const name of ['copied', 'transformed']) {
  test('packed fixture expands /skill:' + name + ' with arguments after relocation', async (t) => {
    const f = await contentFixture(t);
    const inventory = await checkContent(f);
    const run = await runPiSmoke({ packageFixture: { root: f.root, files: expectedPackFiles(inventory) }, prompt: '/skill:' + name + ' argument α' });
    assertClean(run);
    const skill = inventory.bySkillName.get(name);
    assert.ok(skill);
    const user = requestUserText(run);
    const location = join(run.paths.package, skill.destination);
    assert.equal(user, `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${skill.body}\n</skill>\n\nargument α`);
    assert.ok(!user.includes(f.root));
    assert.deepEqual(run.diagnostics, []);
    t.diagnostic(JSON.stringify({ name, user, relocated: run.paths.package, requests: run.provider?.requests }));
  });
}

test('packed fixture leaves unsupported skill commands unexpanded', async (t) => {
  const f = await contentFixture(t);
  const inventory = await checkContent(f);
  const prompt = '/skill:omitted leave this alone';
  const run = await runPiSmoke({ packageFixture: { root: f.root, files: expectedPackFiles(inventory) }, prompt });
  assertClean(run);
  assert.equal(requestUserText(run), prompt);
});

test('real Pi reports duplicate skill names in fixture packages', async (t) => {
  const f = await contentFixture(t);
  await f.put('skills/transformed/SKILL.md', skillText('copied', 'SHADOW_MARKER'));
  const run = await runPiSmoke({ packageFixture: { root: f.root, files: f.pkg.files }, prompt: '/skill:copied argument', allowDiagnostics: true });
  assertClean(run);
  t.diagnostic(JSON.stringify(run.diagnostics));
  assert.match(run.diagnostics.join('\n'), /collision|duplicate|conflict/i);
  assert.ok(requestUserText(run).includes('COPIED_MARKER'));
  assert.ok(!requestUserText(run).includes('SHADOW_MARKER'));
  await assert.rejects(runPiSmoke({ packageFixture: { root: f.root, files: f.pkg.files } }), (error) => {
    assert.ok(error instanceof PiTestError);
    assert.match(error.message, /Pi emitted diagnostics/);
    assertClean(error.run);
    return true;
  });
});
