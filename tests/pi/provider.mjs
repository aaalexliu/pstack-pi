import assert from "node:assert/strict";
import { createServer } from "node:http";

export const FIXTURE_TEXT = "Pi package smoke ✓\u2028LF framing\u2029verified.";
export const FIXTURE_MODEL = "pi-smoke-model";
export const FIXTURE_KEY = "pi-smoke-literal-key";
export const FIXTURE_USAGE = { input: 11, output: 7, totalTokens: 18 };

/** @typedef {{ text?: string, mode?: "text" | "error" | "stall" }} FixtureOptions */
/** @typedef {{ requests: number, errors: string[], closed: boolean }} FixtureState */

/** @param {FixtureOptions} options */
export async function startProvider({ text = FIXTURE_TEXT, mode = "text" } = {}) {
  /** @type {FixtureState} */
  const state = { requests: 0, errors: [], closed: false };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${FIXTURE_KEY}`);
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          assert.ok(Buffer.byteLength(body) <= 256 * 1024, "Fixture request exceeded 256 KiB");
        }
        const payload = JSON.parse(body);
        assert.equal(payload.model, FIXTURE_MODEL);
        assert.equal(payload.stream, true);
        assert.equal(payload.stream_options?.include_usage, true);
        assert.ok(Array.isArray(payload.messages));
        assert.ok(payload.messages.some(
          /** @param {{ role?: string }} message */
          (message) => message.role === "user",
        ));
        state.requests++;
        if (mode === "stall") return;
        if (mode === "error") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "controlled fixture error", type: "invalid_request_error" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const envelope = { id: "pi-fixture-1", object: "chat.completion.chunk", created: 1, model: FIXTURE_MODEL };
        const deltas = [{ role: "assistant", content: "" }, { content: text.slice(0, 5) }, { content: text.slice(5) }];
        for (const delta of deltas) {
          response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        }
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [],
          usage: { prompt_tokens: FIXTURE_USAGE.input, completion_tokens: FIXTURE_USAGE.output, total_tokens: FIXTURE_USAGE.totalTokens },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        if (state.errors.length < 16) state.errors.push(String(error));
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
