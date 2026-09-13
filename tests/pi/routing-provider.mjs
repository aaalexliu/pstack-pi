import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FIXTURE_KEY, FIXTURE_USAGE } from './provider.mjs';

/** @typedef {import('./provider.mjs').ScriptStep & {model: string}} RoutingStep */
/** @param {RoutingStep[]} steps */
export async function startRoutingProvider(steps) {
  assert.ok(steps.length > 0 && steps.length <= 16);
  for (const step of steps) {
    assert.ok(step.model.length > 0 && step.model.length <= 256);
    assert.ok(Buffer.byteLength(JSON.stringify(step.reply)) <= 32768);
  }
  /** @type {import('./provider.mjs').FixtureState} */
  const state = { requests: 0, decodedRequests: [], retainedBytes: 0, errors: [], closed: false };
  let active = 0;
  const server = createServer((request, response) => {
    active++;
    response.once('close', () => { active--; });
    void (async () => {
      try {
        assert.equal(active, 1, 'Routing fixture received overlapping requests');
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
        const step = steps[state.requests];
        assert.ok(step, 'Unexpected routing request');
        assert.equal(payload.model, step.model, 'Wrong exact model reached provider');
        assert.equal(payload.stream, true);
        assert.equal(payload.stream_options?.include_usage, true);
        assert.ok(Array.isArray(payload.messages));
        assert.ok(state.retainedBytes + bytes <= 1024 * 1024);
        state.requests++;
        state.retainedBytes += bytes;
        state.decodedRequests.push(payload);
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => step.check?.(payload)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Routing check timeout')), 1000); }),
          ]);
        } finally { clearTimeout(timer); }
        const reply = step.reply;
        if (reply.kind === 'stall') return;
        const calls = reply.kind === 'tools' ? reply.calls : reply.kind === 'tool' ? [reply] : [];
        assert.ok(reply.kind === 'text' || calls.length > 0 && calls.length <= 4);
        const delta = reply.kind === 'text' ? { role: 'assistant', content: reply.text }
          : { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
        const envelope = { id: `routing-${state.requests}`, object: 'chat.completion.chunk', created: 1, model: step.model };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [], usage: { prompt_tokens: FIXTURE_USAGE.input, completion_tokens: FIXTURE_USAGE.output, total_tokens: FIXTURE_USAGE.totalTokens } })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        if (state.errors.length < 16) state.errors.push(String(error).slice(0, 4096));
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Routing fixture rejected request' } }));
      }
    })();
  });
  server.requestTimeout = 5000;
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
