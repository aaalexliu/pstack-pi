import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE_KEY, FIXTURE_MODEL } from './provider.mjs';
import { runPiSmoke } from './runner.mjs';
import { startRoutingProvider } from './routing-provider.mjs';

const alpha = 'org/alpha:tag';
const beta = 'beta';
/** @param {import('./runner.mjs').PiTestRun['paths']} paths @param {string} baseUrl */
async function configureModels(paths, baseUrl) {
  const provider = { baseUrl, api: 'openai-completions', apiKey: FIXTURE_KEY, compat: { supportsReasoningEffort: true } };
  await writeFile(path.join(paths.profile, 'models.json'), JSON.stringify({ providers: {
    'pi-fixture': { ...provider, models: [{ id: FIXTURE_MODEL, reasoning: true }, { id: alpha, reasoning: true }] },
    'pi-other': { ...provider, models: [{ id: beta, reasoning: true }] },
  } }));
}
/** @param {Record<string, unknown>} payload */
function isParent(payload) {
  assert.ok(Array.isArray(payload.tools));
  assert.ok(payload.tools.some((tool) => tool.function.name === 'subagent'));
  assert.equal(payload.model, FIXTURE_MODEL);
}
/** @param {Record<string, unknown>} payload @param {string} id @param {RegExp} text */
function resultContains(payload, id, text) {
  isParent(payload);
  assert.ok(Array.isArray(payload.messages));
  const result = payload.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(result);
  assert.match(JSON.stringify(result.content), text);
}

test('separate model fixture rejects excessive scripts and reply bytes before listening', async () => {
  await assert.rejects(startRoutingProvider([]));
  await assert.rejects(startRoutingProvider(Array(17).fill({ model: 'a', reply: { kind: 'text', text: 'x' } })));
  await assert.rejects(startRoutingProvider([{ model: 'a', reply: { kind: 'text', text: 'x'.repeat(32769) } }]));
});

test('packed relocated real Pi assigns explicit models, mixed role pools, duplicates, agent defaults, and inheritance exactly', async (t) => {
  const final = 'All seven exact assignments passed.';
  const requests = [
    { model: 'pi-other/beta', role: 'feature' },
    { role: 'feature' },
    { role: 'feature' },
    { role: 'feature' },
    { role: 'feature' },
    { role: 'test' },
    { model: 'inherit-parent', role: 'feature' },
  ];
  const expected = [
    { provider: 'pi-other', id: beta, thinkingLevel: 'off', source: 'explicit' },
    { provider: 'pi-fixture', id: alpha, thinkingLevel: 'off', source: 'role' },
    { provider: 'pi-fixture', id: FIXTURE_MODEL, thinkingLevel: 'high', source: 'role' },
    { provider: 'pi-fixture', id: alpha, thinkingLevel: 'off', source: 'role' },
    { provider: 'pi-other', id: beta, thinkingLevel: 'off', source: 'role' },
    { provider: 'pi-fixture', id: alpha, thinkingLevel: 'off', source: 'agent' },
    { provider: 'pi-fixture', id: FIXTURE_MODEL, thinkingLevel: 'high', source: 'explicit' },
  ];
  /** @type {import('./routing-provider.mjs').RoutingStep[]} */
  const steps = requests.flatMap((request, index) => [
    { model: FIXTURE_MODEL, reply: { kind: 'tool', id: `delegate-${index}`, name: 'subagent', arguments: { agent: 'general-purpose', task: `Report assignment ${index}.`, ...request } }, check(payload) {
      isParent(payload);
      assert.equal(payload.reasoning_effort, 'high');
      if (index) resultContains(payload, `delegate-${index - 1}`, new RegExp(`assigned-${index - 1}`));
    } },
    { model: expected[index].id, reply: { kind: 'text', text: `assigned-${index}` }, check(payload) {
      assert.equal(payload.reasoning_effort, expected[index].thinkingLevel === 'high' ? 'high' : undefined);
      assert.ok(!JSON.stringify(payload.tools ?? []).includes('subagent'));
      assert.ok(!JSON.stringify(payload).includes('UNTRUSTED_ROUTING_CONTEXT'));
      assert.ok(!JSON.stringify(payload).includes('available_skills'));
    } },
  ]);
  steps.push({ model: FIXTURE_MODEL, reply: { kind: 'text', text: final }, check(payload) { resultContains(payload, 'delegate-6', /assigned-6/); } });
  const run = await runPiSmoke({
    startFixture: () => startRoutingProvider(steps), configureModels, thinkingLevel: 'high', expectedText: final,
    expectedRequests: 15, keepArtifacts: true, timeoutMs: 30000,
    setup: async (paths) => {
      await mkdir(path.join(paths.profile, 'pstack-pi'));
      await writeFile(path.join(paths.profile, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles: { feature: [`pi-fixture/${alpha}`, 'inherit-parent', `pi-fixture/${alpha}`, 'pi-other/beta'] } }));
      await mkdir(path.join(paths.profile, 'agents'));
      await writeFile(path.join(paths.profile, 'agents/general-purpose.md'), `---\nname: general-purpose\ndescription: Routing fixture.\ntools: []\nmodel: pi-fixture/${alpha}\n---\nReport the assignment. Do not delegate.`);
      await mkdir(path.join(paths.cwd, '.pi/pstack-pi'), { recursive: true });
      await writeFile(path.join(paths.cwd, '.pi/pstack-pi/models.json'), '{malformed project config');
      await writeFile(path.join(paths.cwd, 'AGENTS.md'), 'UNTRUSTED_ROUTING_CONTEXT');
    },
    verify: async (run) => {
      const events = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.equal(events.length, 7);
      for (const [index, event] of events.entries()) {
        assert.equal(event.isError, false);
        assert.ok(event.result && typeof event.result === 'object' && 'details' in event.result);
        const details = event.result.details;
        assert.ok(details && typeof details === 'object' && 'model' in details && 'usage' in details);
        assert.notEqual(details.usage, null);
        const routing = details.model;
        assert.ok(routing && typeof routing === 'object' && 'resolved' in routing && 'observed' in routing && 'selection' in routing);
        const { source, ...resolved } = expected[index];
        assert.deepEqual(routing.resolved, resolved);
        assert.deepEqual(routing.observed, { provider: resolved.provider, id: resolved.id });
        assert.ok(routing.selection && typeof routing.selection === 'object' && 'source' in routing.selection);
        assert.equal(routing.selection.source, source);
      }
      assert.ok(!run.pack.files.some((file) => file.startsWith('tests/')));
      assert.equal(run.pack.files.length, 48);
      assert.deepEqual(run.diagnostics, []);
    },
  });
  t.diagnostic(JSON.stringify({ artifact: run.paths.root, pi: run.process.version, expected, requests: run.provider?.requests, cleanup: run.cleanup, inventory: run.pack.files }));
});

test('real Pi rejects unknown roles, fuzzy names, and unavailable pool entries without consuming a slot', async (t) => {
  const final = 'Rejected preparation did not advance the role.';
  const invalid = [
    { role: 'typo', model: 'pi-other/beta' },
    { model: 'pi-other/be' },
    { role: 'review' },
    { role: 'review' },
    { model: 'pi-other/beta', configPath: '/tmp/untrusted.json' },
  ];
  /** @type {import('./routing-provider.mjs').RoutingStep[]} */
  const steps = invalid.map((request, index) => ({ model: FIXTURE_MODEL, reply: { kind: 'tool', id: `reject-${index}`, name: 'subagent', arguments: { agent: 'general-purpose', task: 'Do not run.', ...request } }, check(payload) {
    isParent(payload);
    if (index) resultContains(payload, `reject-${index - 1}`, /Invalid|unavailable|validation|role/);
  } }));
  steps.push({ model: FIXTURE_MODEL, reply: { kind: 'text', text: final }, check(payload) { resultContains(payload, 'reject-4', /Invalid|validation|configPath/); } });
  const run = await runPiSmoke({ startFixture: () => startRoutingProvider(steps), configureModels, expectedText: final, expectedRequests: steps.length,
    setup: async (paths) => {
      await mkdir(path.join(paths.profile, 'pstack-pi'));
      await writeFile(path.join(paths.profile, 'pstack-pi/models.json'), JSON.stringify({ version: 1, roles: { review: ['pi-other/missing', 'pi-other/beta'] } }));
    },
    verify: async (run) => {
      const results = run.events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent');
      assert.equal(results.length, invalid.length);
      assert.ok(results.every((result) => result.isError === true));
    },
  });
  t.diagnostic(JSON.stringify({ requests: run.provider?.requests, cleanup: run.cleanup }));
});

for (const kind of ['duplicate routing keys', 'unused credential command']) {
  test(`packed real Pi rejects ${kind} before any child request`, async (t) => {
    const final = `Rejected ${kind}.`;
    let marker = '';
    const run = await runPiSmoke({ expectedText: final, expectedRequests: 2,
      configureModels: async (paths, baseUrl) => {
        if (kind === 'duplicate routing keys') {
          await mkdir(path.join(paths.profile, 'pstack-pi'));
          await writeFile(path.join(paths.profile, 'pstack-pi/models.json'), '{"version":1,"roles":{"feature":"inherit-parent","feature":"pi-other/beta"}}');
        } else {
          marker = path.join(paths.root, 'credential-command-ran');
          await writeFile(path.join(paths.profile, 'models.json'), JSON.stringify({ providers: {
            'pi-fixture': { baseUrl, api: 'openai-completions', apiKey: FIXTURE_KEY, models: [{ id: FIXTURE_MODEL }] },
            unused: { baseUrl, api: 'openai-completions', apiKey: `!touch ${marker}`, models: [{ id: 'unused' }] },
          } }));
        }
      },
      fixture: { script: [
        { reply: { kind: 'tool', id: 'reject', name: 'subagent', arguments: { agent: 'general-purpose', task: 'Do not run.', role: 'feature' } } },
        { reply: { kind: 'text', text: final }, check(payload) { resultContains(payload, 'reject', kind === 'duplicate routing keys' ? /Duplicate JSON key/ : /Command-backed/); } },
      ] },
      verify: async () => { if (marker) await assert.rejects(readFile(marker), { code: 'ENOENT' }); },
    });
    t.diagnostic(JSON.stringify({ kind, requests: run.provider?.requests, cleanup: run.cleanup }));
  });
}
