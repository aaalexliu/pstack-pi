import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, getCapabilities, Image, Text, TruncatedText } from '@earendil-works/pi-tui';
import { stripControls } from '../shared/model.ts';
import { collectMediaTurn, decodeMediaTurn, maxMediaBytes, mediaEntryType, mediaTurns } from './media.ts';

const guideline = 'To show the user an image, video, or PDF, cite it in your final reply as a Markdown image with an absolute path, for example `![before](/tmp/before.png)`. Pi shows cited media under your reply.';
const maxThumbnailBytes = 16 * 1024 * 1024;

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
    if (turn && !mediaTurns(ctx.sessionManager.getBranch()).some((existing) => existing.replyId === reply.id)) pi.appendEntry(mediaEntryType, turn);
  });

  if (typeof pi.registerEntryRenderer !== 'function') return;
  pi.registerEntryRenderer(mediaEntryType, (entry, _options, theme) => {
    const turn = decodeMediaTurn(entry.data);
    if (!turn) return undefined;
    const statuses = turn.items.map((item) => {
      try { return lstatSync(join(rootDirectory, item.object)).isFile() ? stripControls(item.caption) : `${stripControls(item.caption)} (missing)`; }
      catch { return `${stripControls(item.caption)} (missing)`; }
    });
    const skipped = turn.skipped?.length ? `; skipped: ${turn.skipped.map(stripControls).join(', ')}` : '';
    const header = ` ${turn.items.length} file${turn.items.length === 1 ? '' : 's'}: ${statuses.join(', ')}${skipped}`;
    const view = new Container();
    view.addChild(new TruncatedText(`${theme.fg('dim', '▣')}${theme.fg('muted', header)}`, 1, 0));
    if (!getCapabilities().images) return view;

    const images = turn.items.filter((item) => item.kind === 'image');
    for (const item of images.slice(0, 4)) {
      try {
        const file = join(rootDirectory, item.object);
        const info = lstatSync(file);
        if (!info.isFile() || info.size > maxThumbnailBytes) continue;
        const data = readFileSync(file).toString('base64');
        view.addChild(new Text(theme.fg('muted', stripControls(item.caption)), 1, 0));
        view.addChild(new Image(data, item.mime, { fallbackColor: (value) => theme.fg('muted', value) }, { maxWidthCells: 60, maxHeightCells: 14 }));
      } catch {}
    }
    if (images.length > 4) view.addChild(new Text(theme.fg('muted', `+${images.length - 4} more`), 1, 0));
    return view;
  });
}
