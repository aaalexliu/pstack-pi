import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";

/** @typedef {Record<string, unknown> & { type: string }} PiEvent */
const MAX_OUTPUT = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_EVENTS = 256;

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {(event: PiEvent) => void} onEvent */
export function jsonlParser(onEvent) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let count = 0;
  return {
    /** @param {Buffer} chunk */
    write(chunk) {
      bytes += chunk.length;
      assert.ok(bytes <= MAX_OUTPUT, "Pi stdout exceeded 1 MiB");
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        assert.ok(Buffer.byteLength(line) <= MAX_LINE, "Pi JSONL record exceeded 64 KiB");
        const event = record(JSON.parse(line));
        assert.equal(typeof event.type, "string", "Pi event must have a type");
        assert.ok(++count <= MAX_EVENTS, "Pi event count exceeded 256");
        onEvent(/** @type {PiEvent} */ (event));
      }
      assert.ok(Buffer.byteLength(pending) <= MAX_LINE, "Pi JSONL record exceeded 64 KiB");
    },
    end() {
      pending += decoder.end();
      assert.equal(pending, "", "Pi stdout ended without LF");
    },
  };
}
