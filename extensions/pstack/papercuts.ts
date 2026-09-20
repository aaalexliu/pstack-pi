import { join } from 'node:path';
import { getAgentDir, type AgentToolResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { createAggregationFilename, formatRecentPapercuts, parsePapercutsCommand, renderPapercutAggregation } from './papercut-aggregation.ts';
import { PapercutJournal } from './papercut-journal.ts';
import { normalizePapercutNote, papercutParameters, papercutRecordVersion, type PapercutRecord, type ToolEvidence } from './papercut-model.ts';
import { PapercutObserver } from './papercut-observer.ts';

export const papercutToolName = 'pstack_papercut';

type PapercutToolDetails = Readonly<{ record: PapercutRecord; file: string }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerPapercuts(pi: ExtensionAPI, rootDirectory = join(getAgentDir(), 'pstack-pi')): void {
  const journal = new PapercutJournal(rootDirectory);
  const observer = new PapercutObserver();

  pi.on('tool_execution_start', (event) => {
    if (event.toolName === papercutToolName) return;
    observer.start(event.toolCallId, event.toolName, performance.now());
  });

  pi.on('tool_result', (event) => {
    if (event.toolName === papercutToolName) return;
    const observation = observer.finish({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      isError: event.isError,
      finishedAt: performance.now(),
    });
    if (!observation) return;
    return { content: [...event.content, { type: 'text' as const, text: observation.trailer }] };
  });

  pi.registerTool({
    name: papercutToolName,
    label: 'Pstack Papercut',
    description: 'Record workflow friction such as retries, workarounds, confusing errors, or avoidable delay in the local pstack-pi papercut journal. Successful but onerous commands count too.',
    promptSnippet: 'Record workflow friction: retries, workarounds, repeated discovery, noisy output, and avoidable delay',
    promptGuidelines: [
      'Use pstack_papercut when friction causes retries, workarounds, repeated discovery, confusing errors, excessive output, or avoidable delay, even if you recover or the command succeeds. Include recurring setup and environment problems.',
      'Hints for pstack_papercut: missing dependencies, unclear flags or schemas, stale paths or docs, repeated searches, truncated output that needs extra calls, manual steps that a tool could handle, and failures that need a different tool or command to recover.',
      'Before your final response, briefly check for unrecorded friction and call pstack_papercut for any you missed. Record one note per distinct problem in the task, not every retry. State what happened, the extra work it caused, and a possible improvement if known; no proven fix is required.',
      'For pstack_papercut, skip routine negative results (such as a search with no matches), expected waits with useful progress, and product bugs unless tooling makes diagnosis or recovery harder. Never include secrets or raw tool output. Copy evidence from the affected result trailer when available; omit evidence rather than invent measurements.',
    ],
    parameters: papercutParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<PapercutToolDetails>> {
      const evidence: ToolEvidence | undefined = params.evidence
        ? {
            tool: params.evidence.tool.trim(),
            durationMs: params.evidence.durationMs,
            outputBytes: params.evidence.outputBytes,
            isError: params.evidence.isError ?? false,
          }
        : undefined;
      const record: PapercutRecord = {
        version: papercutRecordVersion,
        source: 'agent',
        at: new Date().toISOString(),
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        kind: params.kind ?? 'other',
        note: normalizePapercutNote(params.note),
        ...(evidence ? { evidence } : {}),
      };
      const file = await journal.append(record);
      return {
        content: [{ type: 'text' as const, text: `Recorded papercut [${record.kind}]` }],
        details: { record, file },
      };
    },
    renderCall(args, theme) {
      const preview = args.note.length > 80 ? `${args.note.slice(0, 80)}...` : args.note;
      return new Text(`${theme.fg('toolTitle', theme.bold('papercut '))}${theme.fg('accent', args.kind ?? 'other')} ${theme.fg('dim', preview)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((content) => content.type === 'text')?.text ?? 'Papercut recorded';
      return new Text(theme.fg('muted', text), 0, 0);
    },
  });

  pi.registerCommand('papercuts', {
    description: 'Show local pstack-pi papercuts, or aggregate them across all projects',
    handler: async (args, ctx) => {
      const command = parsePapercutsCommand(args, ctx.cwd);
      if (command.kind === 'invalid') {
        ctx.ui.notify(command.message, 'error');
        return;
      }
      try {
        const records = await journal.readAll();
        if (command.kind === 'list') {
          ctx.ui.notify(formatRecentPapercuts(records, command.scope), 'info');
          return;
        }
        const generatedAt = new Date();
        const file = await journal.writeAggregation({
          filename: createAggregationFilename(generatedAt),
          content: renderPapercutAggregation(records, generatedAt),
        });
        ctx.ui.notify(`Wrote ${records.length} papercut${records.length === 1 ? '' : 's'} to ${file}`, 'info');
      } catch (error) {
        ctx.ui.notify(`Papercuts failed: ${errorMessage(error)}`, 'error');
      }
    },
  });
}
