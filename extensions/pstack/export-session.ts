import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type UsageTotals = Readonly<{
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

export type UsagePoint = Readonly<{
  entryId: string;
  role: string;
  atMs: number;
  tokens: UsageTotals;
}>;

export type UsageBucket = Readonly<{
  key: string;
  label: string;
  atMs: number;
  firstEntryId: string;
  entryIds: readonly string[];
  turnCount: number;
  tokens: UsageTotals;
}>;

/** Roles Pi's HTML export actually mounts with id="entry-...". toolResult/system render as empty. */
export const exportNavigableRoles = new Set(['user', 'assistant', 'bashExecution']);

export function isExportNavigableRole(role: string): boolean {
  return exportNavigableRoles.has(role);
}

export function pickJumpEntryId(entryIds: readonly string[], rolesById: ReadonlyMap<string, string>): string | undefined {
  for (const id of entryIds) {
    const role = rolesById.get(id);
    if (role && isExportNavigableRole(role)) return id;
  }
  return entryIds[0];
}

const emptyTokens: UsageTotals = Object.freeze({
  total: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function asFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function tokensFromUsage(usage: unknown): UsageTotals {
  if (!usage || typeof usage !== 'object') return emptyTokens;
  const u = usage as Record<string, unknown>;
  const input = asFinite(u.input);
  const output = asFinite(u.output);
  const cacheRead = asFinite(u.cacheRead);
  const cacheWrite = asFinite(u.cacheWrite);
  const total = asFinite(u.totalTokens) || input + output + cacheRead + cacheWrite;
  return { total, input, output, cacheRead, cacheWrite };
}

export function entryTimeMs(entry: SessionEntry): number | null {
  if (entry.type === 'message') {
    const messageTime = (entry.message as { timestamp?: unknown }).timestamp;
    if (typeof messageTime === 'number' && Number.isFinite(messageTime)) return messageTime;
  }
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function branchUsagePoints(branch: readonly SessionEntry[]): UsagePoint[] {
  const points: UsagePoint[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const atMs = entryTimeMs(entry);
    if (atMs === null) continue;
    const message = entry.message as { role?: unknown; usage?: unknown };
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const tokens = role === 'assistant' ? tokensFromUsage(message.usage) : emptyTokens;
    points.push({ entryId: entry.id, role, atMs, tokens });
  }
  return points;
}

function addTokens(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function minuteKey(atMs: number, timeZone?: string): { key: string; label: string; bucketMs: number } {
  const date = new Date(atMs);
  const label = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const key = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  const bucketMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00`);
  return { key, label, bucketMs: Number.isFinite(bucketMs) ? bucketMs : atMs };
}

export function bucketUsagePoints(points: readonly UsagePoint[], timeZone?: string): UsageBucket[] {
  type Acc = {
    key: string;
    label: string;
    atMs: number;
    entryIds: string[];
    rolesById: Map<string, string>;
    turnCount: number;
    tokens: UsageTotals;
  };
  const byKey = new Map<string, Acc>();
  for (const point of points) {
    const { key, label, bucketMs } = minuteKey(point.atMs, timeZone);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        label,
        atMs: bucketMs,
        entryIds: [point.entryId],
        rolesById: new Map([[point.entryId, point.role]]),
        turnCount: 1,
        tokens: point.tokens,
      });
      continue;
    }
    existing.entryIds.push(point.entryId);
    existing.rolesById.set(point.entryId, point.role);
    existing.turnCount += 1;
    existing.tokens = addTokens(existing.tokens, point.tokens);
  }
  return [...byKey.values()]
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      atMs: bucket.atMs,
      entryIds: bucket.entryIds,
      firstEntryId: pickJumpEntryId(bucket.entryIds, bucket.rolesById) ?? bucket.entryIds[0] ?? '',
      turnCount: bucket.turnCount,
      tokens: bucket.tokens,
    }))
    .filter((bucket) => bucket.firstEntryId.length > 0)
    .sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

const timelineCss = `
/* Fixed to the viewport: Pi export scrolls the document, not #content, so sticky-inside-content never pins. */
#pstack-timeline{position:fixed;top:0;left:0;right:0;z-index:1000;background:var(--body-bg,var(--exportPageBg,#0f1115));border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);padding:4px 10px 6px;margin:0;box-shadow:0 8px 24px color-mix(in srgb,#000 28%,transparent)}
body.pstack-has-timeline{padding-top:var(--pstack-timeline-h,96px)}
#pstack-timeline .pt-row{display:flex;align-items:center;gap:8px;min-height:22px;font-size:12px;line-height:1.2}
#pstack-timeline .pt-title{font-weight:650;white-space:nowrap}
#pstack-timeline .pt-live{color:color-mix(in srgb,currentColor 70%,transparent);font-variant-numeric:tabular-nums;white-space:nowrap}
#pstack-timeline .pt-live strong{color:inherit;font-weight:650}
#pstack-timeline .pt-modes{margin-left:auto;display:flex;gap:2px}
#pstack-timeline .pt-modes button{border:1px solid transparent;border-radius:4px;background:transparent;color:color-mix(in srgb,currentColor 55%,transparent);padding:1px 7px;font:inherit;cursor:pointer}
#pstack-timeline .pt-modes button[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 18%,transparent);color:inherit;background:color-mix(in srgb,currentColor 8%,transparent)}
#pstack-timeline .pt-chart-wrap{position:relative;height:56px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:6px;background:color-mix(in srgb,currentColor 4%,transparent);overflow:hidden;margin-top:4px}
#pstack-timeline .pt-chart{position:absolute;inset:4px 6px 14px;display:flex;align-items:flex-end;gap:2px}
#pstack-timeline .pt-bucket{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;justify-content:center}
#pstack-timeline .pt-bucket button{width:100%;max-width:12px;height:2px;border:0;border-radius:1px;padding:0;cursor:pointer;background:#5b8def}
#pstack-timeline .pt-bucket[data-metric="output"] button{background:#5fbf90}
#pstack-timeline .pt-bucket[data-metric="cache"] button{background:#8f74e8}
#pstack-timeline .pt-bucket[aria-current="true"] button{background:#ff6b4a;box-shadow:0 0 0 1px color-mix(in srgb,#ff6b4a 50%,white)}
#pstack-timeline .pt-axis{position:absolute;left:6px;right:6px;bottom:1px;display:flex;justify-content:space-between;font-size:10px;opacity:.55;font-variant-numeric:tabular-nums;pointer-events:none}
#pstack-timeline .pt-playhead{position:absolute;top:3px;bottom:13px;width:1px;background:#ff6b4a;pointer-events:none;box-shadow:0 0 0 2px color-mix(in srgb,#ff6b4a 20%,transparent)}
#content [id^="entry-"]{scroll-margin-top:96px}
#content [id^="entry-"].pstack-target{outline:2px solid color-mix(in srgb,#ff6b4a 70%,transparent);outline-offset:2px}
`;

const timelineJs = `
(() => {
  const root = document.getElementById('pstack-timeline');
  const dataNode = document.getElementById('pstack-timeline-data');
  const content = document.getElementById('content');
  if (!root || !dataNode || !content) return;
  let data;
  try { data = JSON.parse(dataNode.textContent || '{}'); } catch { return; }
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  if (buckets.length === 0) { root.remove(); return; }

  const fmt = (n) => n >= 1000 ? ((n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k') : String(n | 0);
  let metric = 'total';
  let currentKey = buckets[0].key;
  let syncing = false;
  const chartH = 38;

  root.innerHTML = '<div class="pt-row"><span class="pt-title">pstack timeline</span><span class="pt-live" id="pt-live"></span><span class="pt-modes"><button type="button" data-metric="total" aria-pressed="true">total</button><button type="button" data-metric="output" aria-pressed="false">out</button><button type="button" data-metric="cache" aria-pressed="false">cache</button></span></div><div class="pt-chart-wrap" id="pt-wrap"><div class="pt-chart" id="pt-chart"></div><div class="pt-playhead" id="pt-playhead"></div><div class="pt-axis" id="pt-axis"></div></div>';
  root.hidden = false;
  document.body.classList.add('pstack-has-timeline');
  function syncTimelineOffset() {
    const h = Math.ceil(root.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--pstack-timeline-h', h + 'px');
  }
  syncTimelineOffset();

  const chart = document.getElementById('pt-chart');
  const axis = document.getElementById('pt-axis');
  const playhead = document.getElementById('pt-playhead');
  const live = document.getElementById('pt-live');
  const wrap = document.getElementById('pt-wrap');

  const valueOf = (b) => metric === 'output' ? (b.tokens.output || 0) : metric === 'cache' ? (b.tokens.cacheRead || 0) : (b.tokens.total || 0);
  const maxValue = () => Math.max(1, ...buckets.map(valueOf));

  function setMetric(next) {
    metric = next;
    root.querySelectorAll('.pt-modes button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.metric === metric)));
    renderChart();
  }
  root.querySelectorAll('.pt-modes button').forEach((btn) => btn.addEventListener('click', () => setMetric(btn.dataset.metric)));

  function renderChart() {
    const max = maxValue();
    chart.replaceChildren();
    for (const b of buckets) {
      const el = document.createElement('div');
      el.className = 'pt-bucket';
      el.dataset.key = b.key;
      el.dataset.metric = metric;
      if (b.key === currentKey) el.setAttribute('aria-current', 'true');
      const button = document.createElement('button');
      button.type = 'button';
      button.style.height = Math.max(2, Math.round((valueOf(b) / max) * chartH)) + 'px';
      button.title = b.label + ' · ' + fmt(valueOf(b)) + ' ' + metric + ' · ' + b.turnCount + ' turns';
      button.addEventListener('click', () => jump(b, true));
      el.appendChild(button);
      chart.appendChild(el);
    }
    axis.replaceChildren();
    const a = document.createElement('span'); a.textContent = buckets[0].label;
    const z = document.createElement('span'); z.textContent = buckets[buckets.length - 1].label;
    axis.append(a, z);
    placePlayhead();
  }

  function updateLive(b) {
    live.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = b.label;
    live.append(strong, document.createTextNode(' · ' + b.turnCount + ' turn' + (b.turnCount === 1 ? '' : 's') + ' · ' + fmt(b.tokens.total || 0) + ' tok'));
  }

  function setCurrent(key) {
    if (key === currentKey) { placePlayhead(); return; }
    currentKey = key;
    chart.querySelectorAll('.pt-bucket').forEach((el) => {
      if (el.dataset.key === key) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    });
    const b = buckets.find((x) => x.key === key);
    if (b) updateLive(b);
    placePlayhead();
  }

  function placePlayhead() {
    const el = chart.querySelector('.pt-bucket[data-key="' + CSS.escape(currentKey) + '"]');
    if (!el) return;
    const wr = wrap.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    playhead.style.left = (box.left - wr.left + box.width / 2) + 'px';
  }

  function entryIdsFor(b) {
    const ids = Array.isArray(b.entryIds) && b.entryIds.length ? b.entryIds.slice() : [];
    if (b.firstEntryId && !ids.includes(b.firstEntryId)) ids.unshift(b.firstEntryId);
    return ids;
  }

  function findTarget(b) {
    for (const id of entryIdsFor(b)) {
      const el = document.getElementById('entry-' + id);
      if (el) return el;
    }
    return null;
  }

  function scrollingRoot() {
    // Pi export lays out #content at full document height; the window scrolls.
    if (content && content.scrollHeight > content.clientHeight + 1) return content;
    return document.scrollingElement || document.documentElement;
  }

  function scrollContentTo(el) {
    const rootScroll = scrollingRoot();
    const pad = root.getBoundingClientRect().height + 12;
    if (rootScroll === content) {
      const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - pad;
      content.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      return;
    }
    const top = el.getBoundingClientRect().top + (window.scrollY || rootScroll.scrollTop) - pad;
    rootScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function jump(b, fromClick) {
    const target = findTarget(b);
    if (!target) return;
    if (fromClick) {
      syncing = true;
      content.querySelectorAll('.pstack-target').forEach((n) => n.classList.remove('pstack-target'));
      target.classList.add('pstack-target');
      scrollContentTo(target);
      setCurrent(b.key);
      setTimeout(() => { syncing = false; }, 500);
    } else setCurrent(b.key);
  }

  function onScroll() {
    if (syncing) return;
    const y = root.getBoundingClientRect().bottom + 8;
    let best = buckets[0];
    for (const b of buckets) {
      const el = findTarget(b);
      if (!el) continue;
      if (el.getBoundingClientRect().top - y <= 0) best = b;
      else break;
    }
    setCurrent(best.key);
  }

  renderChart();
  updateLive(buckets[0]);
  setCurrent(buckets[0].key);
  content.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { syncTimelineOffset(); placePlayhead(); });
  syncTimelineOffset();
})();
`;

export function injectTimeline(html: string, buckets: readonly UsageBucket[]): string {
  if (buckets.length === 0) return html;
  const payload = escapeScriptJson({ buckets });
  let out = html;
  if (!out.includes('id="pstack-timeline-css"')) {
    out = out.replace(/<\/head>/i, `<style id="pstack-timeline-css">${timelineCss}</style>\n</head>`);
  }
  if (!out.includes('id="pstack-timeline"')) {
    // Mount on <body>, not inside #content: the export page scrolls the document.
    out = out.replace(
      /<body([^>]*)>/i,
      `<body$1>\n<div id="pstack-timeline" hidden></div>\n<script type="application/json" id="pstack-timeline-data">${payload}</script>`,
    );
  }
  if (!out.includes('id="pstack-timeline-js"')) {
    out = out.replace(/<\/body>/i, `<script id="pstack-timeline-js">${timelineJs}</script>\n</body>`);
  }
  return out;
}

export function enhanceExportedHtml(html: string, branch: readonly SessionEntry[], timeZone?: string): string {
  return injectTimeline(html, bucketUsagePoints(branchUsagePoints(branch), timeZone));
}

export function defaultExportPath(sessionFile: string, cwd: string): string {
  const sessionBasename = basename(sessionFile, '.jsonl');
  return resolve(cwd, `pi-session-${sessionBasename}.html`);
}

export function runStockHtmlExport(sessionFile: string, outputPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('pi', ['--export', sessionFile, outputPath], {
    encoding: 'utf8',
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `pi --export exited ${result.status}`;
    throw new Error(detail);
  }
  if (!existsSync(outputPath)) {
    throw new Error(`pi --export did not write ${outputPath}`);
  }
  return outputPath;
}

export function registerExport(pi: ExtensionAPI): void {
  pi.registerCommand('pstack-export', {
    description: 'Export session HTML like /export, with a sticky token time series for the active branch',
    async handler(args, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify('Cannot export an in-memory session. Start a saved session first.', 'error');
        return;
      }
      const outputPath = args.trim() || defaultExportPath(sessionFile, ctx.cwd);
      try {
        runStockHtmlExport(sessionFile, outputPath);
        const html = readFileSync(outputPath, 'utf8');
        const enhanced = enhanceExportedHtml(html, ctx.sessionManager.getBranch());
        if (enhanced !== html) writeFileSync(outputPath, enhanced, 'utf8');
        ctx.ui.notify(`Exported: ${outputPath}`, 'info');
      } catch (error) {
        ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
