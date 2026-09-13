import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FIXTURE_KEY, FIXTURE_USAGE } from './provider.mjs';

/** @typedef {Omit<import('./routing-provider.mjs').RoutingStep, 'reply'> & {reply: import('./provider.mjs').ScriptStep['reply'] | {kind: 'failure'}}} ConcurrentStep */
/** @typedef {{marker: string, steps: ConcurrentStep[]}} ConcurrentRoute */
/** @param {ConcurrentRoute[]} routes */
export async function startConcurrentProvider(routes) {
  assert.ok(routes.length > 0 && routes.length <= 17);
  assert.equal(new Set(routes.map((route) => route.marker)).size, routes.length);
  assert.ok(routes.reduce((sum, route) => sum + route.steps.length, 0) <= 64);
  for (const route of routes) {
    assert.ok(route.marker.length > 0 && Buffer.byteLength(route.marker) <= 4096);
    assert.ok(route.steps.length > 0 && route.steps.length <= 32);
    for (const step of route.steps) {
      assert.ok(step.model.length > 0 && step.model.length <= 256);
      assert.ok(Buffer.byteLength(JSON.stringify(step.reply)) <= 32768);
    }
  }
  const scripts = new Map(routes.map((route) => [route.marker, { steps: route.steps, next: 0 }]));
  const state = {
    requests: 0, retainedBytes: 0, closed: false,
    /** @type {Record<string, unknown>[]} */ decodedRequests: [],
    /** @type {string[]} */ errors: [],
    /** @type {string[]} */ arrivals: [],
    /** @type {string[]} */ completions: [],
    peakActive: 0,
  };
  let active = 0;
  const server = createServer((request, response) => {
    active++;
    state.peakActive = Math.max(state.peakActive, active);
    const controller = new AbortController();
    response.once('close', () => { active--; controller.abort(); });
    void (async () => {
      try {
        assert.ok(active <= 5, 'Concurrent fixture exceeds parent plus four children');
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, `Bearer ${FIXTURE_KEY}`);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          assert.ok(bytes <= 256 * 1024);
          chunks.push(chunk);
        }
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
        assert.ok(Array.isArray(payload.messages));
        const user = payload.messages.findLast((/** @type {{role: string}} */ message) => message.role === 'user');
        assert.ok(user, 'Missing final user marker');
        const content = user.content;
        const marker = typeof content === 'string' ? content
          : Array.isArray(content) && content.length === 1 && content[0].type === 'text' ? content[0].text : undefined;
        assert.equal(typeof marker, 'string', 'Expected exact final user marker');
        const script = scripts.get(marker);
        assert.ok(script, 'Unknown exact final user marker');
        const step = script.steps[script.next++];
        assert.ok(step, 'Route exhausted');
        assert.equal(payload.model, step.model, 'Wrong exact model reached provider');
        assert.equal(payload.stream, true);
        assert.equal(payload.stream_options?.include_usage, true);
        assert.ok(state.retainedBytes + bytes <= 4 * 1024 * 1024);
        state.requests++;
        state.retainedBytes += bytes;
        state.decodedRequests.push(payload);
        state.arrivals.push(marker);
        let timer;
        const aborted = () => rejectAbort?.(new Error('Concurrent request closed'));
        /** @type {((reason: Error) => void) | undefined} */
        let rejectAbort;
        controller.signal.addEventListener('abort', aborted, { once: true });
        try {
          await Promise.race([
            Promise.resolve().then(() => step.check?.(payload)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent check timeout')), 12000); }),
            new Promise((_, reject) => { rejectAbort = reject; if (controller.signal.aborted) aborted(); }),
          ]);
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', aborted);
        }
        const reply = step.reply;
        if (reply.kind === 'stall') return;
        if (reply.kind === 'failure') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Fixture task failed' } }));
          state.completions.push(marker);
          return;
        }
        const calls = reply.kind === 'tools' ? reply.calls : reply.kind === 'tool' ? [reply] : [];
        assert.ok(reply.kind === 'text' || calls.length > 0 && calls.length <= 4);
        const delta = reply.kind === 'text' ? { role: 'assistant', content: reply.text }
          : { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
        const envelope = { id: `parallel-${state.requests}`, object: 'chat.completion.chunk', created: 1, model: step.model };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [], usage: { prompt_tokens: FIXTURE_USAGE.input, completion_tokens: FIXTURE_USAGE.output, total_tokens: FIXTURE_USAGE.totalTokens } })}\n\n`);
        response.end('data: [DONE]\n\n');
        state.completions.push(marker);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (state.errors.length < 64) state.errors.push(String(error).slice(0, 4096));
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Concurrent fixture rejected request' } }));
      }
    })();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(undefined); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, state, async close() {
    if (state.closed) return;
    await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve(undefined)); server.closeAllConnections(); });
    state.closed = true;
  } };
}
