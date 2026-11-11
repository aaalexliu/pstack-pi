import { appendFileSync } from 'node:fs';
import http from 'node:http';

/**
 * Loopback stand-in for the Anthropic Messages API. Each reply names the login that
 * sent the request: "key=client-a" for a key containing CLIENT_A, "key=default" for
 * DEFAULT. A user message containing DELEGATE gets a subagent tool call that runs in
 * /tmp with CHILD_MODEL.
 */
const [port, log] = [Number(process.argv[2]), String(process.argv[3])];

http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const key = String(request.headers['x-api-key'] ?? request.headers.authorization ?? '');
    const label = /CLIENT_A/u.test(key) ? 'client-a' : /DEFAULT/u.test(key) ? 'default' : 'unknown';
    /** @type {{ model?: string, messages?: Array<{ content: unknown }> }} */
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const last = parsed.messages?.at(-1)?.content;
    /** @type {Array<{ type: string, text?: string }>} */
    const blocks = Array.isArray(last) ? last : [{ type: 'text', text: String(last ?? '') }];
    const afterTool = blocks.some((block) => block.type === 'tool_result');
    const delegate = !afterTool && blocks.some((block) => block.type === 'text' && block.text?.includes('DELEGATE'));
    appendFileSync(log, `${JSON.stringify({ label, model: parsed.model, delegate, afterTool })}\n`);
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock' });
    /** @param {string} type @param {Record<string, unknown>} data */
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (delegate) {
      const input = { agent: 'general-purpose', task: 'hi', cwd: '/tmp', model: process.env.CHILD_MODEL };
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_mock', name: 'subagent', input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${afterTool ? 'parent-after-subagent ' : ''}key=${label}` } });
    }
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: delegate ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', {});
    response.end();
  });
}).listen(port, '127.0.0.1');
