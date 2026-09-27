import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import pstack from '../../extensions/pstack/index.ts';

function registeredTools() {
  /** @type {unknown[]} */
  const appended = [];
  const tools = new Map();
  pstack(/** @type {any} */ ({
    on() {},
    appendEntry(/** @type {string} */ type, /** @type {unknown} */ data) { appended.push({ type, data }); },
    registerCommand() {},
    registerTool(/** @type {any} */ tool) { tools.set(tool.name, tool); },
  }));
  return { tools, appended };
}

/** Pi's Anthropic provider keeps only these fields for a non-strict tool.
 * @param {unknown} schema
 */
function anthropicProjection(schema) {
  const json = JSON.parse(JSON.stringify(schema));
  return {
    type: 'object',
    properties: json.properties ?? {},
    required: json.required ?? [],
  };
}

/** @param {any} action */
function actionLiterals(action) {
  if (Array.isArray(action?.anyOf)) return action.anyOf.map((/** @type {any} */ branch) => branch.const);
  if (Array.isArray(action?.enum)) return action.enum;
  return [];
}

test('pstack_todo stays visible to Anthropic and rejects a bad call', async () => {
  const { tools } = registeredTools();
  const tool = tools.get('pstack_todo');
  const projection = anthropicProjection(tool.parameters);
  assert.deepEqual(actionLiterals(projection.properties.action), ['get', 'set', 'add', 'complete']);
  assert.notEqual(projection.properties.items, undefined);
  assert.notEqual(projection.properties.item, undefined);
  assert.deepEqual(projection.required, ['action']);
  const parameters = JSON.parse(JSON.stringify(tool.parameters));
  assert.equal(parameters.properties.items.items.pattern, undefined);
  assert.equal(parameters.properties.item.pattern, undefined);
  assert.equal(parameters.properties.items.items.minLength, 1);
  assert.equal(parameters.properties.items.items.maxLength, 4096);
  assert.equal(parameters.properties.item.minLength, 1);
  assert.equal(parameters.properties.item.maxLength, 4096);

  const session = registeredTools();
  const live = session.tools.get('pstack_todo');
  const calls = [
    { input: { action: 'get' }, text: 'No pstack todo items.', items: [] },
    { input: { action: 'set', items: ['step one', 'step two'] }, text: '1. step one\n2. step two', items: ['step one', 'step two'] },
    { input: { action: 'add', item: 'another' }, text: '1. step one\n2. step two\n3. another', items: ['step one', 'step two', 'another'] },
    {
      input: { action: 'complete', item: 'step one' },
      text: '1. [done] step one\n2. step two\n3. another',
      items: ['[done] step one', 'step two', 'another'],
    },
  ];
  for (const call of calls) {
    assert.equal(Check(live.parameters, call.input), true, JSON.stringify(call.input));
    const result = await live.execute('call', call.input);
    assert.equal(result.content[0].text, call.text);
    assert.deepEqual(result.details, { version: 1, items: call.items });
  }

  const schemaInvalid = [
    {},
    [],
    { action: 'replace', items: ['step one'] },
    { action: 'get', extra: true },
    { action: 'set', items: [{ id: '1', content: 'step one', status: 'pending' }] },
    { merge: true, todos: [{ content: 'step one', status: 'pending' }] },
  ];
  for (const input of schemaInvalid) {
    assert.equal(Check(tool.parameters, input), false, JSON.stringify(input));
  }

  const crossField = [
    { input: { action: 'set' }, field: 'items' },
    { input: { action: 'get', items: ['x'] }, field: 'items' },
    { input: { action: 'get', item: 'x' }, field: 'item' },
    { input: { action: 'set', items: ['a'], item: 'x' }, field: 'item' },
    { input: { action: 'add' }, field: 'item' },
    { input: { action: 'add', item: ' ' }, field: 'item' },
    { input: { action: 'set', items: ['ok', '  '] }, field: 'items' },
    { input: { action: 'complete', items: [] }, field: 'items' },
  ];
  for (const { input, field } of crossField) {
    const fresh = registeredTools();
    const next = fresh.tools.get('pstack_todo');
    assert.equal(Check(next.parameters, input), true, JSON.stringify(input));
    await assert.rejects(() => next.execute('bad', input), new RegExp(`pstack_todo ${field}\\b`));
    assert.equal(fresh.appended.length, 0);
  }
});

test('pstack_config stays visible to Anthropic and rejects a bad call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-config-schema-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const tool = registeredTools().tools.get('pstack_config');
  const projection = anthropicProjection(tool.parameters);
  assert.deepEqual(actionLiterals(projection.properties.action), ['get', 'list-models']);
  assert.deepEqual(projection.required, ['action']);

  const registry = {
    getAvailable: () => [
      { provider: 'fixture', id: 'second' },
      { provider: 'fixture', id: 'first' },
      { provider: 'fixture', id: 'second' },
    ],
  };
  assert.equal(Check(tool.parameters, { action: 'get' }), true);
  const configured = await tool.execute('get', { action: 'get' });
  assert.equal(configured.content[0].text, 'No pstack model roles configured.');
  assert.deepEqual(configured.details, { version: 1, roles: {} });
  assert.equal(Check(tool.parameters, { action: 'list-models' }), true);
  const models = await tool.execute('models', { action: 'list-models' }, undefined, undefined, { modelRegistry: registry });
  assert.equal(models.content[0].text, 'fixture/first\nfixture/second\ninherit-parent');
  assert.deepEqual(models.details, { models: ['fixture/first', 'fixture/second', 'inherit-parent'] });

  for (const input of [{}, [], { action: 'set' }, { action: 'get', extra: true }]) {
    assert.equal(Check(tool.parameters, input), false, JSON.stringify(input));
  }
});
