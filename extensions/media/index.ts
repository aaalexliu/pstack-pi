import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { Container, getCapabilities, hyperlink, Image, Text, TruncatedText } from '@earendil-works/pi-tui';
import { stripControls } from '../shared/model.ts';
import { collectMediaTurn, decodeMediaTurn, maxMediaBytes, mediaEntryType, mediaTurns } from './media.ts';
import { startMediaServer, type Feed } from './server.ts';

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

type Exec = ExtensionAPI['exec'];
type Pane = { kind: 'none' } | { kind: 'remote' } | { kind: 'local'; surface?: string };

function excerpt(branch: SessionEntry[], replyId: string): string {
  const reply = branch.find((entry) => entry.id === replyId);
  if (reply?.type !== 'message' || reply.message.role !== 'assistant') return '';
  const text = reply.message.content.find((block) => block.type === 'text');
  if (text?.type !== 'text') return '';
  const line = text.text.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? '';
  const plain = stripControls(line).replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/\s+/gu, ' ').trim();
  if (plain.length <= 140) return plain;
  const cut = plain.lastIndexOf(' ', 139);
  return `${plain.slice(0, cut > 80 ? cut : 139)}…`;
}

export default function media(pi: ExtensionAPI, rootDirectory = join(getAgentDir(), 'pstack-pi', 'media'), sizeLimit = maxMediaBytes, exec: Exec = pi.exec.bind(pi)): void {
  let feed: Feed = [];
  let server: Awaited<ReturnType<typeof startMediaServer>> | undefined;
  let starting: Promise<Awaited<ReturnType<typeof startMediaServer>>> | undefined;
  let pane: Pane = !process.env.CMUX_SOCKET_PATH ? { kind: 'none' }
    : /^127\.0\.0\.1:\d+$/u.test(process.env.CMUX_SOCKET_PATH) ? { kind: 'remote' } : { kind: 'local' };
  const cli = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
  const rebuild = (branch: SessionEntry[]) => {
    feed = mediaTurns(branch).map((turn) => ({ ...turn, excerpt: excerpt(branch, turn.replyId) }));
  };
  const start = async () => {
    if (!starting) starting = startMediaServer(() => feed, rootDirectory);
    try { server = await starting; return server; }
    catch (error) { starting = undefined; throw error; }
  };
  const open = async () => {
    if (!server || pane.kind !== 'local') return;
    const current = pane.surface;
    if (current) {
      try {
        const result = await exec(cli, ['--json', 'browser', current, 'get-url'], { timeout: 5000 });
        if (result.code === 0) {
          const currentUrl = JSON.parse(result.stdout).url;
          if (typeof currentUrl === 'string' && currentUrl.split(/[?#]/u)[0] === server.url) return;
        }
      } catch { pane = { kind: 'local' }; }
    }
    try {
      const args = ['--json', 'browser', 'open-split', server.url, ...(process.env.CMUX_WORKSPACE_ID ? ['--workspace', process.env.CMUX_WORKSPACE_ID] : []), '--focus', 'false'];
      const result = await exec(cli, args, { timeout: 5000 });
      if (result.stdout.includes('remote_relay_denied') || result.stderr.includes('remote_relay_denied')) { pane = { kind: 'remote' }; return; }
      if (result.code !== 0) { pane = { kind: 'local' }; return; }
      const ref = JSON.parse(result.stdout).surface_ref;
      pane = typeof ref === 'string' && ref ? { kind: 'local', surface: ref } : { kind: 'local' };
    } catch { pane = { kind: 'local' }; }
  };
  pi.on('session_start', async (_event, ctx) => {
    rebuild(ctx.sessionManager.getBranch());
    if (ctx.mode === 'tui' && feed.length) await start();
  });
  pi.on('session_tree', async (_event, ctx) => {
    rebuild(ctx.sessionManager.getBranch());
    if (ctx.mode === 'tui' && feed.length) await start();
  });
  pi.on('session_shutdown', async () => {
    const live = await starting?.catch(() => undefined);
    server = undefined;
    starting = undefined;
    if (live) await live.close();
  });
  pi.registerCommand('media', {
    description: 'Open the live page of cited media',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') return;
      try {
        const live = await start();
        ctx.ui.notify(live.url, 'info');
        await open();
      } catch { ctx.ui.notify('Media page is unavailable', 'warning'); }
    },
  });
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
    if (turn && now.some((entry) => entry.id === reply.id) && !mediaTurns(now).some((existing) => existing.replyId === reply.id)) {
      feed = [...feed, { ...turn, excerpt: excerpt(now, reply.id) }];
      const live = await start().catch(() => undefined);
      pi.appendEntry(mediaEntryType, turn);
      if (live) await open();
    }
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
    const url = server && `${server.url}#turn-${encodeURIComponent(turn.replyId)}`;
    if (url) view.addChild(new Text(`${theme.fg('dim', '↗')} ${getCapabilities().hyperlinks ? hyperlink('Open media page', url) : url}`, 1, 0));
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
