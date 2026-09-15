import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePapercutRecord, type PapercutRecord } from './papercut-model.ts';

function safeFilenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return safe || 'session';
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Append-only JSONL journal of papercut records plus immutable aggregation snapshots.
 * Each session and process appends to its own file, so concurrent Pi processes never interleave lines.
 */
export class PapercutJournal {
  private readonly journalDirectory: string;
  private readonly aggregationDirectory: string;
  private readonly processId: number;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, processId = process.pid) {
    this.journalDirectory = join(rootDirectory, 'papercuts');
    this.aggregationDirectory = join(rootDirectory, 'papercut-aggregations');
    this.processId = processId;
  }

  append(record: PapercutRecord): Promise<string> {
    const operation = this.pendingWrite.then(async () => {
      await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
      const file = join(this.journalDirectory, `${safeFilenamePart(record.sessionId)}.${this.processId}.jsonl`);
      await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return file;
    });
    this.pendingWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readAll(): Promise<PapercutRecord[]> {
    let filenames: string[];
    try {
      filenames = await readdir(this.journalDirectory);
    } catch (error) {
      if (isMissingDirectory(error)) return [];
      throw error;
    }
    const files = filenames.filter((filename) => filename.endsWith('.jsonl'));
    const records = (await Promise.all(files.map((filename) => this.readJournalFile(join(this.journalDirectory, filename))))).flat();
    return records.sort((left, right) => left.at.localeCompare(right.at));
  }

  async writeAggregation(input: { filename: string; content: string }): Promise<string> {
    await mkdir(this.aggregationDirectory, { recursive: true, mode: 0o700 });
    const file = join(this.aggregationDirectory, safeFilenamePart(input.filename));
    await writeFile(file, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return file;
  }

  private async readJournalFile(file: string): Promise<PapercutRecord[]> {
    const content = await readFile(file, 'utf8');
    const records: PapercutRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = decodePapercutRecord(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        continue;
      }
    }
    return records;
  }
}
