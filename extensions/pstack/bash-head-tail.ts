import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, isBashToolResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { open } from 'node:fs/promises';

const newline = 0x0a;

type Content = { type: string; text?: string };

export type HeadTail = {
  text: string;
  outputLines: number;
  outputBytes: number;
};

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

// Move a cut back so it does not split a UTF-8 character.
function charBoundaryAtOrBefore(buffer: Buffer, end: number): number {
  let cut = end;
  while (cut > 0 && cut < buffer.length && isContinuationByte(buffer[cut])) cut--;
  return cut;
}

function charBoundaryAtOrAfter(buffer: Buffer, start: number): number {
  let cut = start;
  while (cut < buffer.length && isContinuationByte(buffer[cut])) cut++;
  return cut;
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function lineCount(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let count = buffer[buffer.length - 1] === newline ? 0 : 1;
  for (let index = buffer.indexOf(newline); index !== -1; index = buffer.indexOf(newline, index + 1)) count++;
  return count;
}

/**
 * Keep the first and last half of the output in the file at `path`, each within half of
 * `maxBytes` and half of `maxLines`. A cut lands on a line break unless whole lines would fill
 * less than half of its byte budget; then it splits a long line on a character boundary. The
 * marker between the halves names the file and the omitted lines and bytes.
 */
export async function headAndTail(path: string, totalLines: number, maxLines: number, maxBytes: number): Promise<HeadTail | undefined> {
  const file = await open(path, 'r');
  let size: number;
  try {
    size = (await file.stat()).size;
  } finally {
    await file.close();
  }
  const headMaxBytes = Math.floor(maxBytes / 2);
  const tailMaxBytes = maxBytes - headMaxBytes;
  const headMaxLines = Math.floor(maxLines / 2);
  const tailMaxLines = maxLines - headMaxLines;
  if (headMaxBytes < 1 || headMaxLines < 1) return undefined;

  // Read one byte past the head so a cut can see whether it splits a character.
  const headBuffer = await readRange(path, 0, Math.min(size, headMaxBytes + 1));
  const headLimit = Math.min(headBuffer.length, headMaxBytes);
  let headEnd = 0;
  let headLines = 0;
  for (let index = headBuffer.indexOf(newline); index !== -1 && index < headLimit && headLines < headMaxLines; index = headBuffer.indexOf(newline, index + 1)) {
    headEnd = index + 1;
    headLines++;
  }
  const headPartial = headLines < headMaxLines && headEnd * 2 < headLimit;
  if (headPartial) headEnd = charBoundaryAtOrBefore(headBuffer, headLimit);
  if (headEnd === 0) return undefined;

  // Read one byte before the tail window so a line break there marks a line start.
  const windowStart = Math.max(headEnd, size - tailMaxBytes);
  const bufferStart = windowStart - 1;
  const tailBuffer = await readRange(path, bufferStart, size - bufferStart);
  const lastIndex = tailBuffer.length - 1;
  const searchFrom = tailBuffer[lastIndex] === newline ? lastIndex - 1 : lastIndex;
  let tailOffset = tailBuffer.length;
  let tailLines = 0;
  for (let index = tailBuffer.lastIndexOf(newline, searchFrom); index !== -1 && tailLines < tailMaxLines; index = index === 0 ? -1 : tailBuffer.lastIndexOf(newline, index - 1)) {
    tailOffset = index + 1;
    tailLines++;
  }
  const tailPartial = tailLines < tailMaxLines && (tailBuffer.length - tailOffset) * 2 < tailBuffer.length - 1;
  if (tailPartial) tailOffset = charBoundaryAtOrAfter(tailBuffer, 1);
  const tailStart = bufferStart + tailOffset;
  if (tailStart <= headEnd || tailStart >= size) return undefined;

  const head = headBuffer.subarray(0, headEnd);
  const tail = tailBuffer.subarray(tailOffset);
  const firstOmittedLine = headLines + 1;
  const lastOmittedLine = totalLines - tailLines;
  const bytes = `bytes ${headEnd + 1}-${tailStart} of ${size}`;
  const omitted = headPartial || tailPartial || lastOmittedLine < firstOmittedLine
    ? `${tailStart - headEnd} bytes omitted (${bytes})`
    : `${lastOmittedLine - firstOmittedLine + 1} lines omitted (lines ${firstOmittedLine}-${lastOmittedLine}, ${bytes})`;
  const headText = head.toString('utf8');
  const tailText = tail.toString('utf8').replace(/\n$/u, '');
  const marker = `[... ${omitted}. Full output: ${path}]`;
  return {
    text: `${headText}${headText.endsWith('\n') ? '' : '\n'}\n${marker}\n\n${tailText}`,
    outputLines: lineCount(head) + lineCount(tail),
    outputBytes: head.length + tail.length,
  };
}

export function registerBashHeadTail(pi: ExtensionAPI): void {
  pi.on('tool_result', async (event, ctx) => {
    if (!isBashToolResult(event) || ctx.signal?.aborted) return;
    const truncation = event.details?.truncation;
    const path = event.details?.fullOutputPath;
    if (!truncation?.truncated || !path) return;
    const index = event.content.findIndex((item: Content) => item.type === 'text' && typeof item.text === 'string');
    if (index === -1) return;
    const text = (event.content[index] as Content).text ?? '';
    // Pi ends its own notice with the path, then may add the exit status.
    const notice = `Full output: ${path}]`;
    const noticeEnd = text.lastIndexOf(notice);
    if (noticeEnd === -1) return;
    const status = text.slice(noticeEnd + notice.length);
    try {
      const kept = await headAndTail(
        path,
        truncation.totalLines,
        truncation.maxLines ?? DEFAULT_MAX_LINES,
        truncation.maxBytes ?? DEFAULT_MAX_BYTES,
      );
      if (!kept) return;
      const content = event.content.map((item, position) => position === index ? { type: 'text' as const, text: `${kept.text}${status}` } : item);
      return {
        content,
        details: { ...event.details, truncation: { ...truncation, outputLines: kept.outputLines, outputBytes: kept.outputBytes } },
        structuredContent: event.structuredContent,
      };
    } catch {
      return;
    }
  });
}
