import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getAgentDir, type AgentToolResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { formatRecentPapercuts, parsePapercutsCommand } from './papercut-list.ts';
import { PapercutJournal } from './papercut-journal.ts';
import { normalizePapercutNote, papercutKey, papercutLabel, papercutParameters, papercutRecordVersion, type CurrentPapercutRecord } from './papercut-model.ts';
import { PapercutObserver } from './papercut-observer.ts';

export const papercutToolName = 'pstack_papercut';

export const maxPapercutsPerTurn = 5;

type PapercutToolDetails = Readonly<
  | { status: 'recorded'; record: CurrentPapercutRecord; file: string }
  | { status: 'duplicate' | 'turn-limit' }
>;

const refusals = {
  duplicate: 'Not recorded: this session already recorded the same papercut. Do not record it again.',
  'turn-limit': `Not recorded: reached the limit of ${maxPapercutsPerTurn} papercuts per turn. Record only distinct problems.`,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

async function git(directory: string, args: readonly string[]): Promise<string[] | undefined> {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], { timeout: 5000 });
    return stdout.trim().split('\n');
  } catch {
    return undefined;
  }
}

/** The installed pstack-pi: its commit when it is a git checkout, else its package version. */
export async function readPstackBuild(root = packageRoot): Promise<string> {
  if (existsSync(join(root, '.git'))) {
    const [head] = (await git(root, ['rev-parse', '--short=7', 'HEAD'])) ?? [];
    if (head) return `pstack-pi@${head}`;
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  return `pstack-pi@${version}`;
}

/** The git root and head commit of `cwd`, or undefined outside a repository. */
async function readRepo(cwd: string): Promise<CurrentPapercutRecord['repo']> {
  const [root, head] = (await git(cwd, ['rev-parse', '--show-toplevel', '--short=7', 'HEAD'])) ?? [];
  return root && head ? { root, head } : undefined;
}

export function registerPapercuts(pi: ExtensionAPI, rootDirectory = join(getAgentDir(), 'pstack-pi')): void {
  const journal = new PapercutJournal(rootDirectory);
  const observer = new PapercutObserver();
  const host = hostname().replace(/\.local$/u, '');
  let build: Promise<string> | undefined;
  const recordedKeys = new Set<string>();
  let recordedThisTurn = 0;

  pi.on('turn_start', () => {
    recordedThisTurn = 0;
  });

  // Calls nested in another tool, such as a codemode script, never reach the model, so they get no trailer.
  pi.on('tool_execution_start', (event) => {
    if (event.toolName === papercutToolName || event.parentToolCallId) return;
    observer.start(event.toolCallId, performance.now());
  });

  pi.on('tool_result', (event) => {
    if (event.toolName === papercutToolName || event.parentToolCallId) return;
    const trailer = observer.finish(event.toolCallId, performance.now());
    if (!trailer) return;
    return { content: [...event.content, { type: 'text' as const, text: trailer }] };
  });

  pi.registerTool({
    name: papercutToolName,
    label: 'Pstack Papercut',
    description: 'Record workflow friction that cost extra steps, blocked you, or gave a wrong result, in the local pstack-pi papercut journal.',
    promptSnippet: 'Record friction that cost extra steps, blocked you, or gave a wrong result',
    promptGuidelines: [
      'Call pstack_papercut when friction costs extra steps, blocks you, or gives a wrong result, even if you recover: retries, workarounds, confusing errors, stale docs, slow calls. Set culprit to the one thing whose change would have prevented it, or self for your own slip.',
      'Before your final response, record friction you missed, one note per distinct problem. Skip routine negative results, expected waits and product bugs. Never include secrets or raw tool output.',
    ],
    parameters: papercutParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<PapercutToolDetails>> {
      const sessionId = ctx.sessionManager.getSessionId();
      const culprit = params.culprit.name ? { ...params.culprit, name: params.culprit.name.trim() } : params.culprit;
      const note = normalizePapercutNote(params.note);
      const fix = params.fix ? normalizePapercutNote(params.fix) : undefined;
      // Pi runs one turn's tool calls concurrently, so the claim must happen before the first await.
      const key = papercutKey({ sessionId, culprit, note });
      const refusal = recordedKeys.has(key) ? 'duplicate' : recordedThisTurn >= maxPapercutsPerTurn ? 'turn-limit' : null;
      if (refusal) return { content: [{ type: 'text' as const, text: refusals[refusal] }], details: { status: refusal } };
      recordedKeys.add(key);
      recordedThisTurn += 1;

      const at = new Date().toISOString();
      let record: CurrentPapercutRecord;
      let file: string;
      try {
        build ??= readPstackBuild();
        const [installed, repo] = await Promise.all([build, readRepo(ctx.cwd)]);
        record = {
          version: papercutRecordVersion,
          source: 'agent',
          at,
          sessionId,
          callId: toolCallId,
          cwd: ctx.cwd,
          ...(repo ? { repo } : {}),
          ...(host ? { host } : {}),
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
          build: installed,
          note,
          culprit,
          impact: params.impact,
          ...(fix ? { fix } : {}),
        };
        file = await journal.append(record);
      } catch (error) {
        recordedKeys.delete(key);
        throw error;
      }
      return {
        content: [{ type: 'text' as const, text: `Recorded papercut [${papercutLabel(record)}]` }],
        details: { status: 'recorded', record, file },
      };
    },
    renderCall(args, theme) {
      const preview = args.note.length > 80 ? `${args.note.slice(0, 80)}...` : args.note;
      const culprit = args.culprit?.name ? `${args.culprit.type}:${args.culprit.name}` : (args.culprit?.type ?? 'unknown');
      return new Text(`${theme.fg('toolTitle', theme.bold('papercut '))}${theme.fg('accent', culprit)} ${theme.fg('dim', preview)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((content) => content.type === 'text')?.text ?? 'Papercut recorded';
      return new Text(theme.fg('muted', text), 0, 0);
    },
  });

  pi.registerCommand('papercuts', {
    description: 'Show recent pstack-pi papercuts for this project, or across all projects',
    handler: async (args, ctx) => {
      const command = parsePapercutsCommand(args, ctx.cwd);
      if (command.kind === 'invalid') {
        ctx.ui.notify(command.message, 'error');
        return;
      }
      try {
        ctx.ui.notify(formatRecentPapercuts(await journal.readAll(), command.scope), 'info');
      } catch (error) {
        ctx.ui.notify(`Papercuts failed: ${errorMessage(error)}`, 'error');
      }
    },
  });
}
