import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, getCapabilities, Image, Text, TruncatedText } from '@earendil-works/pi-tui';
import { stripControls } from '../shared/model.ts';
import { collectMediaTurn, decodeMediaTurn, maxMediaBytes, mediaEntryType, mediaTurns } from './media.ts';

const guideline = 'To show the user an image, video, or PDF, cite it in your final reply as a Markdown image with an absolute path, for example `![before](/tmp/before.png)`. Pi shows cited media under your reply.';
const maxThumbnailBytes = 16 * 1024 * 1024;
const collapsedThumbnails = 4;
const thumbnails = new Map<string, string>();

function thumbnail(file: string): string | undefined {
  const cached = thumbnails.get(file);
  if (cached) return cached;
  const info = lstatSync(file);
  if (!info.isFile() || info.size > maxThumbnailBytes) return undefined;
  const data = readFileSync(file).toString('base64');
  if (thumbnails.size >= 32) thumbnails.delete(thumbnails.keys().next().value!);
  thumbnails.set(file, data);
  return data;
}

export default function media(pi: ExtensionAPI, rootDirectory = join(getAgentDir(), 'pstack-pi', 'media'), sizeLimit = maxMediaBytes): void {
  pi.on('before_agent_start', (event) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (Array.isArray(rules) && !rules.includes(guideline)) rules.push(guideline);
  });

  pi.on('agent_settled', async (event, ctx) => {
    if ((event as typeof event & { aborted?: boolean }).aborted || ctx.mode !== 'tui') return;
    const branch = ctx.sessionManager.getBranch();
    const reply = branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    if (!reply || reply.type !== 'message' || reply.message.role !== 'assistant' || mediaTurns(branch).some((turn) => turn.replyId === reply.id)) return;
    const text = reply.message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
    const turn = await collectMediaTurn(reply.id, text, ctx.cwd, rootDirectory, sizeLimit);
    const now = ctx.sessionManager.getBranch();
    if (turn && now.some((entry) => entry.id === reply.id) && !mediaTurns(now).some((existing) => existing.replyId === reply.id)) pi.appendEntry(mediaEntryType, turn);
  });

  if (typeof pi.registerEntryRenderer !== 'function') return;
  pi.registerEntryRenderer(mediaEntryType, (entry, options, theme) => {
    const turn = decodeMediaTurn(entry.data);
    if (!turn) return undefined;
    const statuses = turn.items.map((item) => {
      try { return lstatSync(join(rootDirectory, item.object)).isFile() ? stripControls(item.caption) : `${stripControls(item.caption)} (missing)`; }
      catch { return `${stripControls(item.caption)} (missing)`; }
    });
    const skipped = (turn.skipped ?? []).map(stripControls).join(', ');
    const header = !turn.items.length ? ` skipped: ${skipped}`
      : ` ${turn.items.length} file${turn.items.length === 1 ? '' : 's'}: ${statuses.join(', ')}${skipped ? `; skipped: ${skipped}` : ''}`;
    const view = new Container();
    const line = `${theme.fg('dim', '▣')}${theme.fg('muted', header)}`;
    view.addChild(options.expanded ? new Text(line, 1, 0) : new TruncatedText(line, 1, 0));
    if (!getCapabilities().images) return view;

    const images = turn.items.filter((item) => item.kind === 'image');
    const shown = options.expanded ? images : images.slice(0, collapsedThumbnails);
    for (const item of shown) {
      const caption = stripControls(item.caption);
      let data: string | undefined;
      try { data = thumbnail(join(rootDirectory, item.object)); }
      catch { continue; }
      if (!data) {
        view.addChild(new Text(theme.fg('muted', `${caption}: too large to preview`), 1, 0));
        continue;
      }
      view.addChild(new Text(theme.fg('muted', caption), 1, 0));
      view.addChild(new Image(data, item.mime, { fallbackColor: (value) => theme.fg('muted', value) }, { maxWidthCells: 60, maxHeightCells: 14 }));
    }
    const hidden = images.length - shown.length;
    const hint = (options as { keyHint?: (binding: string, description: string) => string }).keyHint?.('app.tools.expand', 'to show all');
    if (hidden > 0) view.addChild(new Text(`${theme.fg('muted', `+${hidden} more`)}${hint ? ` ${hint}` : ''}`, 1, 0));
    return view;
  });
}
