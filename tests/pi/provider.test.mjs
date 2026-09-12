import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FIXTURE_KEY, FIXTURE_MODEL, startProvider } from './provider.mjs';

for (const kind of ['text', 'stall']) {
  test(`provider awaits a rejected check before a ${kind} reply`, async () => {
    const provider = await startProvider({ script: [{
      reply: kind === 'text' ? { kind, text: 'Must not be sent.' } : { kind: 'stall' },
      check: async () => { await delay(10); throw new Error('awaited check failed'); },
    }] });
    try {
      const response = await fetch(provider.baseUrl + '/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(2_000),
        headers: { authorization: `Bearer ${FIXTURE_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: FIXTURE_MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Check fixture.' }] }),
      });
      assert.equal(response.status, 400);
      await response.text();
      assert.deepEqual(provider.state.errors, ['Error: awaited check failed']);
    } finally { await provider.close(); }
    assert.equal(provider.state.closed, true);
  });
}
