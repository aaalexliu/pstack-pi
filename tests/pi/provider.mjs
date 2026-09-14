import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export const FIXTURE_TEXT = "Pi package smoke ✓\u2028LF framing\u2029verified.";
export const FIXTURE_MODEL = "pi-smoke-model";
export const FIXTURE_KEY = "pi-smoke-literal-key";
export const FIXTURE_USAGE = { input: 11, output: 7, totalTokens: 18 };

/** @typedef {{id: string, name: string, arguments: Record<string, unknown>}} FixtureTool */
/** @typedef {{kind: 'stall'} | {kind: 'text', text: string} | ({kind: 'tool'} & FixtureTool) | {kind: 'tools', calls: FixtureTool[]}} FixtureReply */
/** @typedef {{reply: FixtureReply, check?: (payload: Record<string, unknown>) => void | Promise<void>}} ScriptStep */
/** @typedef {{ text?: string, mode?: "text" | "error" | "stall", script?: ScriptStep[] }} FixtureOptions */
/** @typedef {{ requests: number, decodedRequests: Record<string, unknown>[], retainedBytes: number, errors: string[], closed: boolean }} FixtureState */

/** @param {FixtureOptions} options */
export async function startProvider({ text = FIXTURE_TEXT, mode = "text", script } = {}) {
  assert.ok(!script || (script.length > 0 && script.length <= 16), 'Fixture script must contain 1-16 steps');
  for (const step of script ?? []) assert.ok(Buffer.byteLength(JSON.stringify(step.reply)) <= 32 * 1024, 'Fixture reply exceeds 32 KiB');
  /** @type {FixtureState} */
  const state = { requests: 0, decodedRequests: [], retainedBytes: 0, errors: [], closed: false };
  let activeRequests = 0;
  const server = createServer((request, response) => {
    activeRequests++;
    response.once('close', () => { activeRequests--; });
    void (async () => {
      try {
        // A killed client's socket closes a few ticks after its process exits; give it a moment before calling overlap a bug.
        for (let waited = 0; activeRequests > 1 && waited < 500; waited += 10) await delay(10);
        assert.equal(activeRequests, 1, 'Overlapping fixture requests');
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${FIXTURE_KEY}`);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          assert.ok(bytes <= 256 * 1024, "Fixture request exceeded 256 KiB");
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
        assert.equal(payload.model, FIXTURE_MODEL);
        assert.equal(payload.stream, true);
        assert.equal(payload.stream_options?.include_usage, true);
        assert.ok(Array.isArray(payload.messages));
        assert.ok(payload.messages.some(
          /** @param {{ role?: string }} message */
          (message) => message.role === "user",
        ));
        assert.ok(state.decodedRequests.length < 16 && state.retainedBytes + bytes <= 1024 * 1024, 'Fixture capture limit exceeded');
        state.requests++;
        state.decodedRequests.push(payload);
        state.retainedBytes += bytes;
        if (mode === "stall") return;
        if (mode === "error") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "controlled fixture error", type: "invalid_request_error" } }));
          return;
        }
        const envelope = { id: "pi-fixture-1", object: "chat.completion.chunk", created: 1, model: FIXTURE_MODEL };
        const step = script?.[state.requests - 1];
        if (script) assert.ok(step, 'Unexpected scripted provider request');
        let checkTimer;
        try {
          const deadline = new Promise((_, reject) => { checkTimer = setTimeout(() => reject(new Error('Fixture check exceeded 1000 ms')), 1_000); });
          await Promise.race([Promise.resolve().then(() => step?.check?.(payload)), deadline]);
        } finally { clearTimeout(checkTimer); }
        const reply = step?.reply ?? { kind: 'text', text };
        if (reply.kind === 'stall') return;
        const calls = reply.kind === 'tools' ? reply.calls : reply.kind === 'tool' ? [reply] : [];
        assert.ok(reply.kind === 'text' || (calls.length > 0 && calls.length <= 4));
        const deltas = reply.kind === 'text'
          ? [{ role: 'assistant', content: '' }, { content: reply.text.slice(0, 5) }, { content: reply.text.slice(5) }]
          : [{ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } })) },
            ...calls.map((call, index) => ({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments) } }] }))];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const delta of deltas) {
          response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        }
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [],
          usage: { prompt_tokens: FIXTURE_USAGE.input, completion_tokens: FIXTURE_USAGE.output, total_tokens: FIXTURE_USAGE.totalTokens },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        if (state.errors.length < 16) state.errors.push(String(error).slice(0, 4096));
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Fixture rejected the request" } }));
      }
    })();
  });
  server.requestTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    state,
    async close() {
      if (state.closed) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve(undefined));
        server.closeAllConnections();
      });
      state.closed = true;
    },
  };
}
