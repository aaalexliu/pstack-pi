import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import pstack from '../../extensions/pstack/index.ts';

function registeredTools() {
  const tools = new Map();
  pstack(/** @type {any} */ ({
    on() {},
    registerCommand() {},
    registerTool(/** @type {any} */ tool) { tools.set(tool.name, tool); },
  }));
  return tools;
}

const cases = [
  {
    name: 'pstack_todo',
    valid: [
      { action: 'get' },
      { action: 'set', items: ['step one', 'step two'] },
      { action: 'add', item: 'another' },
      { action: 'complete', item: 'step one' },
    ],
    invalid: [
      {}, [], { action: 'replace', items: ['step one'] },
      { action: 'set' }, { action: 'add' }, { action: 'complete' },
      { action: 'set', items: [{ id: '1', content: 'step one', status: 'pending' }] },
      { action: 'get', item: 'extra' }, { action: 'add', item: ' ' },
      { merge: true, todos: [{ content: 'step one', status: 'pending' }] },
    ],
  },
  {
    name: 'pstack_config',
    valid: [{ action: 'get' }, { action: 'list-models' }],
    invalid: [{}, [], { action: 'set' }, { action: 'get', extra: true }],
  },
];

for (const { name, valid, invalid } of cases) {
  test(`${name} publishes an object-root union without weakening action validation`, () => {
    const schema = JSON.parse(JSON.stringify(registeredTools().get(name).parameters));
    assert.equal(schema.type, 'object', 'MCP bridges require an explicit object root');
    assert.deepEqual(schema.anyOf.map((/** @type {any} */ branch) => branch.properties.action.const), valid.map((input) => input.action));
    for (const input of valid) assert.equal(Check(schema, input), true, JSON.stringify(input));
    for (const input of invalid) assert.equal(Check(schema, input), false, JSON.stringify(input));
  });
}
