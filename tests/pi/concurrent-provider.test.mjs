import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FIXTURE_KEY } from './provider.mjs';
import { startConcurrentProvider } from './concurrent-provider.mjs';

const step = { model: 'model', reply: { kind: /** @type {const} */ ('text'), text: 'ok' } };
/** @param {string} marker */
const body = (marker) => ({ model: 'model', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: [{ type: 'text', text: marker }] }] });
/** @param {Awaited<ReturnType<typeof startConcurrentProvider>>} fixture @param {unknown} payload */
const post = (fixture, payload) => fetch(`${fixture.baseUrl}/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${FIXTURE_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(7000),
});

test('concurrent fixture rejects unbounded scripts, duplicate markers, and excess reply bytes before listening', async () => {
  for (const routes of [[], Array(18).fill({ marker: 'same', steps: [step] }), [{ marker: 'same', steps: [step] }, { marker: 'same', steps: [step] }],
    [{ marker: '', steps: [step] }], [{ marker: 'x', steps: [] }], [{ marker: 'x', steps: Array(33).fill(step) }],
    [{ marker: 'x', steps: [{ ...step, reply: { kind: 'text', text: 'x'.repeat(32769) } }] }],
  ]) await assert.rejects(startConcurrentProvider(/** @type {import('./concurrent-provider.mjs').ConcurrentRoute[]} */ (routes)));
});

test('concurrent fixture keys each script by the exact final user marker, never global arrival order', async (t) => {
  let second = false;
  const fixture = await startConcurrentProvider([
    { marker: 'first', steps: [{ ...step, reply: { kind: 'text', text: 'first-result' }, check: async () => {
      const deadline = Date.now() + 2000;
      while (!second && Date.now() < deadline) await delay(5);
      assert.ok(second);
      await delay(50);
    } }] },
    { marker: 'second', steps: [{ ...step, reply: { kind: 'text', text: 'second-result' }, check: () => { second = true; } }] },
  ]);
  t.after(() => fixture.close());
  const first = post(fixture, body('first')).then((response) => response.text());
  await delay(20);
  assert.match(await (await post(fixture, body('second'))).text(), /second-result/);
  assert.match(await first, /first-result/);
  assert.deepEqual(fixture.state.completions, ['second', 'first']);
  assert.equal(fixture.state.peakActive, 2);
  assert.deepEqual(fixture.state.errors, []);
  await fixture.close();
  await fixture.close();
  assert.equal(fixture.state.closed, true);
});

test('concurrent fixture rejects fuzzy markers, exhausted routes, wrong models, and excess request bytes', async (t) => {
  const fixture = await startConcurrentProvider([{ marker: 'exact', steps: [step] }]);
  t.after(() => fixture.close());
  assert.equal((await post(fixture, body('exact-extra'))).status, 400);
  assert.equal((await post(fixture, { ...body('exact'), model: 'wrong' })).status, 400);
  assert.equal((await post(fixture, body('exact'))).status, 400);
  assert.equal((await post(fixture, { ...body('exact'), extra: 'x'.repeat(256 * 1024) })).status, 400);
  assert.equal(fixture.state.requests, 0);
  assert.equal(fixture.state.errors.length, 4);
  assert.equal(fixture.state.retainedBytes, 0);
});
