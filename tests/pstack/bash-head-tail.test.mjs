import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { registerBashHeadTail } from '../../extensions/pstack/bash-head-tail.ts';

function handler() {
  /** @type {Map<string, (event: any, ctx: any) => Promise<any>>} */
  const handlers = new Map();
  registerBashHeadTail(/** @type {any} */ ({
    on(/** @type {string} */ name, /** @type {any} */ fn) { handlers.set(name, fn); },
  }));
  const fn = handlers.get('tool_result');
  assert.ok(fn);
  return fn;
}

const onResult = handler();

/**
 * Run a command through Pi's real bash tool and pass its result through the hook.
 * @param {string} command
 */
async function run(command) {
  const cwd = await mkdtemp(join(tmpdir(), 'bash-head-tail-'));
  try {
    const tool = createBashTool(cwd);
    /** @type {any} */
    let result;
    let isError = false;
    try {
      result = await tool.execute('call', { command });
    } catch (error) {
      return { before: undefined, after: undefined, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.isError) isError = true;
    const event = {
      type: 'tool_result',
      toolName: 'bash',
      toolCallId: 'call',
      input: { command },
      content: result.content,
      details: result.details,
      structuredContent: result.structuredContent,
      isError,
    };
    const after = await onResult(event, { cwd });
    return { before: result, after, error: undefined };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** @param {any} result */
function text(result) {
  return result.content[0].text;
}

test('a long diff keeps its first and last lines around a marker', async () => {
  const { before, after } = await run('for i in $(seq 1 5000); do echo "line $i"; done');
  assert.ok(before.details.truncation.truncated);
  assert.doesNotMatch(text(before), /^line 1\n/u);
  const path = before.details.fullOutputPath;
  const shown = text(after);
  assert.match(shown, /^line 1\nline 2\n/u);
  assert.match(shown, new RegExp(`\\n\\n\\[\\.\\.\\. 3000 lines omitted \\(lines 1001-4000, bytes 8894-38893 of 48893\\)\\. Full output: ${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\n\\nline 4001\\n`, 'u'));
  assert.match(shown, /\nline 1000\n\n\[/u);
  assert.match(shown, /\nline 5000$/u);
  assert.equal(after.details.truncation.outputLines, 2000);
  assert.equal(after.details.fullOutputPath, path);
  assert.deepEqual(after.structuredContent, before.structuredContent);
});

test('the byte cap splits evenly and the result stays inside it', async () => {
  const { before, after } = await run('for i in $(seq 1 1500); do printf "%04d %0194d\\n" $i 0; done');
  assert.equal(before.details.truncation.truncatedBy, 'bytes');
  const shown = text(after);
  const [head, tail] = shown.split(/\n\n\[\.\.\. .*\]\n\n/u);
  assert.ok(Buffer.byteLength(head) <= 25 * 1024, `head ${Buffer.byteLength(head)}`);
  assert.ok(Buffer.byteLength(tail) <= 25 * 1024, `tail ${Buffer.byteLength(tail)}`);
  assert.ok(Buffer.byteLength(shown) <= 50 * 1024 + 200, `shown ${Buffer.byteLength(shown)}`);
  assert.match(head, /^0001 0+$/mu);
  assert.match(head, /^0128 /mu);
  assert.doesNotMatch(head, /^0129 /mu);
  assert.match(tail, /^1373 /u);
  assert.match(tail, /\n1500 0+$/u);
  assert.match(shown, /\[\.\.\. 1244 lines omitted \(lines 129-1372, bytes 25601-274400 of 300000\)\./u);
});

test('the exit status stays after the tail', async () => {
  const { before, after } = await run('seq 1 3000; exit 3');
  assert.equal(before.isError, true);
  assert.match(text(before), /Command exited with code 3$/u);
  assert.match(text(after), /\n3000\n\nCommand exited with code 3$/u);
  assert.match(text(after), /^1\n2\n/u);
});

test('one long line is cut on character boundaries', async () => {
  const { after } = await run(`node -e 'process.stdout.write("x" + "é".repeat(40000) + "x")'`);
  const shown = text(after);
  assert.doesNotMatch(shown, /\uFFFD/u);
  assert.match(shown, /^xé+\n\n\[\.\.\. 28804 bytes omitted \(bytes 25600-54403 of 80002\)\. Full output: .*\]\n\né+x$/u);
  assert.equal(after.details.truncation.outputLines, 2);
});

test('a short line next to a long line does not empty a half', async () => {
  const { after } = await run(`node -e 'process.stdout.write("BEGIN!\\n" + "é".repeat(20000) + "\\n" + "ü".repeat(20000) + "\\nEND\\n")'`);
  const shown = text(after);
  assert.doesNotMatch(shown, /\uFFFD/u);
  assert.match(shown, /^BEGIN!\né{12796}\n\n\[\.\.\. 28815 bytes omitted \(bytes 25600-54414 of 80013\)\. Full output: .*\]\n\nü{12797}\nEND$/u);
  assert.equal(after.details.truncation.outputLines, 4);
});

test('short output passes through unchanged', async () => {
  const { after } = await run('echo hi');
  assert.equal(after, undefined);
});

test('other tools pass through unchanged', async () => {
  const result = await onResult({
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'call',
    input: { path: 'x' },
    content: [{ type: 'text', text: 'x' }],
    details: { truncation: { truncated: true }, fullOutputPath: '/nope' },
    isError: false,
  }, { cwd: tmpdir() });
  assert.equal(result, undefined);
});

test('a missing full output file leaves the result alone', async () => {
  const { before } = await run('seq 1 3000');
  await rm(before.details.fullOutputPath);
  const event = {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call',
    input: { command: 'seq 1 3000' },
    content: before.content,
    details: before.details,
    isError: false,
  };
  assert.equal(await onResult(event, { cwd: tmpdir() }), undefined);
});
