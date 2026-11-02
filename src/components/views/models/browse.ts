/* 模型接入页怎么「浏览」几十家服务（MODELS-SPEC §14.2 / §14.3）：分组、计数、已接入置顶排序、搜索（别名、模型名、拼音与首字母）。
   纯函数，没有 React、没有 DOM —— scripts/check-models-ui.ts 直接测它。 */
import type { AcpAgentDef, ServiceGroup } from '../../../lib/services';
import { readiness, type ProviderInfo } from '../../../lib/providers';
import type { AuthMode, ModelState, ProviderConfig } from '../../../lib/types';
import { standaloneRecs } from '../../../state/agents';
import { pinyinOf } from './pinyin';

/* ═══════════════════════════ groups and tabs ═══════════════════════════ */

export type TabId = 'connected' | 'all' | ServiceGroup;
export const TAB_ORDER: TabId[] = ['connected', 'all', 'intl', 'cn', 'hub', 'local', 'cli'];
export const GROUP_ORDER: ServiceGroup[] = ['intl', 'cn', 'hub', 'local', 'cli'];
export const GROUP_LABEL: Record<ServiceGroup, string> = { intl: '国际', cn: '国内', hub: '聚合与云', local: '本地', cli: '命令行' };
export const TAB_LABEL: Record<TabId, string> = { connected: '已接入', all: '全部', ...GROUP_LABEL };

/** The command-line agents that are not bound to a service (the presets and the ones the user added): they live in the 命令行 group (AgentPane). */
export const standaloneAgents = (showUnverified = false): AcpAgentDef[] => standaloneRecs({ hidden: showUnverified });

/* ═══════════════════════════ status: what 「已接入」 means ═══════════════════════════ */

/** default: the engine new tasks start with · ok: the last test passed · ready: set up, not tested · attention: something needs doing (a failed test, a key saved but not usable, a CLI not signed in). */
export type Standing = 'default' | 'ok' | 'ready' | 'attention';
export const STANDING_RANK: Record<Standing, number> = { default: 0, ok: 1, ready: 2, attention: 3 };

export interface ServiceStatus {
  /** 已接入: ready for the chosen way, or a key saved in any slot, or its command-line tool found. */
  connected: boolean;
  standing?: Standing;
  ready: boolean;
  keySaved: boolean;
  cliFound: boolean;
  /** The way shown: a service without any command-line tool is always the API way. */
  auth: AuthMode;
}

const slotsWithKey = (m: ModelState, id: string) => Object.keys(m.keyHints ?? {}).some((k) => k === id || k.startsWith(`${id}:`));

export function statusOf(p: ProviderInfo, models: ModelState, defaultProvider?: string): ServiceStatus {
  const cfg: ProviderConfig | undefined = models.providers[p.id];
  if (!cfg) return { connected: false, ready: false, keySaved: false, cliFound: false, auth: 'api' };
  const auth: AuthMode = cfg.auth === 'cli' && !p.drivers.length ? 'api' : cfg.auth;
  const ready = readiness(p, cfg, auth).ready;
  const keySaved = !!cfg.keyHint || slotsWithKey(models, p.id);
  const cliFound = !!cfg.cli?.found;
  const connected = ready || keySaved || cliFound;
  if (!connected) return { connected: false, ready, keySaved, cliFound, auth };
  const tested = cfg.test && cfg.test.auth === auth && (auth === 'api' || cfg.test.driver === cfg.driver) ? cfg.test : undefined;
  const testing = !!tested && !tested.ok && tested.message === '测试中…';
  const failed = !!tested && !tested.ok && !testing;
  const standing: Standing = ready && defaultProvider === p.id ? 'default' : ready && tested?.ok ? 'ok' : !ready || failed ? 'attention' : 'ready';
  return { connected, standing, ready, keySaved, cliFound, auth };
}

/* ═══════════════════════════ search ═══════════════════════════ */

export interface ServiceHit {
  score: number;
  /** Why it matched, when not by name: 「别名：通义」 · 「模型：Claude Opus 5.5」 · 「拼音」. */
  via?: string;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKC');
/** 3: starts with · 2: a word starts with · 1: contains · 0: no. */
function rank(text: string, q: string): number {
  if (!text) return 0;
  if (text.startsWith(q)) return 3;
  if (text.includes(` ${q}`) || text.includes(`-${q}`) || text.includes(`.${q}`) || text.includes(`/${q}`)) return 2;
  return text.includes(q) ? 1 : 0;
}

interface Haystack {
  name: string; id: string; vendor: string; aliases: string[]; models: Array<{ text: string; label: string }>; endpoints: string[];
  py: Array<{ full: string; initials: string; words: Array<{ full: string; initials: string }> }>;
}
const hayCache = new WeakMap<ProviderInfo, Haystack>();
function haystackOf(p: ProviderInfo): Haystack {
  let h = hayCache.get(p);
  if (h) return h;
  const texts = [p.name, p.vendor, ...p.aliases];
  const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean).map(pinyinOf);
  h = {
    name: norm(p.name), id: norm(p.id), vendor: norm(p.vendor), aliases: p.aliases.map(norm),
    models: p.models.slice(0, 80).map((m) => ({ text: norm(`${m.label ?? ''} ${m.id}`), label: m.label ?? m.id })),
    endpoints: p.regions.map((r) => norm(r.label)),
    py: texts.map((t) => ({ ...pinyinOf(t), words: wordsOf(t) })),
  };
  hayCache.set(p, h);
  return h;
}

/** One word of the query against one service: a score (0 = no match) and what matched. */
function matchWord(p: ProviderInfo, q: string): { score: number; via?: string } {
  const h = haystackOf(p);
  let best = 0;
  let via: string | undefined;
  const take = (score: number, why?: string) => { if (score > best) { best = score; via = why; } };
  const rn = rank(h.name, q); if (rn) take(rn === 3 ? 100 : rn === 2 ? 85 : 70);
  if (h.id === q) take(95); else { const r = rank(h.id, q); if (r) take(r === 3 ? 75 : 40); }
  const rv = rank(h.vendor, q); if (rv) take(rv === 3 ? 60 : rv === 2 ? 55 : 45);
  h.aliases.forEach((a, i) => { const r = rank(a, q); if (r) take(r === 3 ? 65 : r === 2 ? 58 : 50, `别名：${p.aliases[i]}`); });
  for (const m of h.models) { const r = rank(m.text, q); if (r) take(r === 3 ? 45 : 38, `模型：${m.label}`); }
  h.endpoints.forEach((e, i) => { const r = rank(e, q); if (r) take(r === 3 ? 33 : 28, `地区：${p.regions[i]?.label ?? ''}`); });
  // pinyin and initials (only when the query is ASCII letters: Chinese queries are matched above)
  if (/^[a-z]+$/.test(q)) {
    for (const t of h.py) {
      const pieces = [t, ...t.words];
      for (const w of pieces) {
        if (!w.full || w.full === w.initials) continue;       // no Han in it: already matched as plain text
        if (w.full.startsWith(q)) take(62, '拼音');
        else if (w.initials.startsWith(q) && q.length >= 2) take(56, '首字母');
        else if (q.length >= 3 && w.full.includes(q)) take(34, '拼音');
        else if (q.length >= 2 && w.initials.includes(q)) take(30, '首字母');
      }
    }
  }
  return { score: best, via };
}

/** The query's words (case-insensitive, split on spaces). Every word has to match something. */
export const queryWords = (query: string): string[] => norm(query).trim().split(/\s+/).filter(Boolean);

/** Does the service match the query, and how well? null = no match. */
export function matchService(p: ProviderInfo, query: string): ServiceHit | null {
  const words = queryWords(query);
  if (!words.length) return { score: 0 };
  let total = 0;
  let via: string | undefined;
  for (const w of words) {
    const m = matchWord(p, w);
    if (!m.score) return null;
    total += m.score;
    if (!via && m.via) via = m.via;
  }
  return { score: Math.round(total / words.length), via };
}

/** Does a command-line agent match (for the 命令行 group's count while searching)? */
export function matchAgent(a: AcpAgentDef, query: string): boolean {
  const words = queryWords(query);
  const hay = norm(`${a.label} ${a.id} ${a.registryId ?? ''} ${a.bin.join(' ')}`);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

/* ═══════════════════════════ the page's sections ═══════════════════════════ */

export interface Row { p: ProviderInfo; status: ServiceStatus; hit?: ServiceHit }
export interface GroupSection {
  group: ServiceGroup;
  label: string;
  /** Not yet connected (shown as compact rows). */
  rows: Row[];
  /** Connected ones of this group (shown on a group tab, above the rows). */
  connectedHere: Row[];
  /** Everything in the group, as the tab counts it. */
  total: number;
  /** The 命令行 group's stand-alone agents that match (AgentPane draws them). */
  agents?: number;
}
export interface Browse {
  counts: Record<TabId, number>;
  /** 已接入, sorted (default engine → tested → configured → needs attention). */
  connected: Row[];
  groups: GroupSection[];
  /** With a query: how many services (and agents) matched. */
  matches: number;
  /** Unchecked presets that match the query but are not shown. */
  hiddenMatches: number;
  /** The tab actually used: a query looks at everything. */
  tab: TabId;
}

export interface BrowseInput {
  /** Every service including the hidden presets (providers.ts allProviders()). */
  providers: ProviderInfo[];
  models: ModelState;
  defaultProvider?: string;
  tab: TabId;
  query: string;
  showUnverified: boolean;
  /** A service the user has open stays where it was, even if it became connected meanwhile (so the page does not jump under their hands). */
  keepInPlace?: { id: string; wasConnected: boolean };
}

export function buildBrowse(input: BrowseInput): Browse {
  const { models, defaultProvider, showUnverified } = input;
  const q = input.query.trim();
  const tab: TabId = q ? 'all' : input.tab;
  // a stand-alone command-line agent is a service for the engine list, but this page draws it in the 命令行 group (AgentPane), not as a service row
  const listed = input.providers.filter((p) => p.kind !== 'agent');
  const visible = listed.filter((p) => showUnverified || !p.hidden);
  const rows: Row[] = [];
  let hiddenMatches = 0;
  for (const p of listed) {
    const hit = q ? matchService(p, q) : { score: 0 };
    if (!hit) continue;
    if (p.hidden && !showUnverified) { hiddenMatches += 1; continue; }
    const status = statusOf(p, models, defaultProvider);
    const keep = input.keepInPlace && input.keepInPlace.id === p.id ? input.keepInPlace : undefined;
    // an open service that was not connected when opened stays in its group row; one that was connected stays in 已接入
    if (keep) status.connected = keep.wasConnected;
    rows.push({ p, status, hit });
  }
  // counts are of what the page lists, whatever the query
  const counts = Object.fromEntries(TAB_ORDER.map((t) => [t, 0])) as Record<TabId, number>;
  for (const p of visible) {
    const s = statusOf(p, models, defaultProvider);
    if (s.connected) counts.connected += 1;
    counts[p.group] += 1;
  }
  counts.cli = standaloneAgents(showUnverified).length;
  counts.all = visible.length + counts.cli;

  const byStanding = (a: Row, b: Row) => STANDING_RANK[a.status.standing ?? 'ready'] - STANDING_RANK[b.status.standing ?? 'ready'];
  const connected = rows.filter((r) => r.status.connected).sort(byStanding);
  const bySearch = (a: Row, b: Row) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0);
  const groups: GroupSection[] = GROUP_ORDER.map((group) => {
    const mine = rows.filter((r) => r.p.group === group);
    const rest = mine.filter((r) => !r.status.connected);
    const here = mine.filter((r) => r.status.connected).sort(byStanding);
    return {
      group, label: GROUP_LABEL[group], rows: q ? [...rest].sort(bySearch) : rest, connectedHere: here, total: counts[group],
      ...(group === 'cli' ? { agents: q ? standaloneAgents(showUnverified).filter((a) => matchAgent(a, q)).length : counts.cli } : {}),
    };
  });
  const agentMatches = groups.find((g) => g.group === 'cli')?.agents ?? 0;
  const matches = q ? rows.length + agentMatches : counts.all;
  return { counts, connected, groups, matches, hiddenMatches, tab };
}

/** The default tab: 已接入 when there is anything connected, else 全部. */
export const defaultTab = (b: Pick<Browse, 'counts'>): TabId => (b.counts.connected > 0 ? 'connected' : 'all');

/* ═══════════════════════════ small text helpers ═══════════════════════════ */

/** Split a text around the (case-insensitive) occurrences of the query's words, for highlighting. Plain strings only: nothing here is HTML. */
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const words = queryWords(query).filter((w) => w.length > 0);
  if (!words.length || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const w of words) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(w, from);
      if (i < 0) break;
      marks.push([i, i + w.length]);
      from = i + w.length;
    }
  }
  if (!marks.length) return [{ text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) { const last = merged[merged.length - 1]; if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([m[0], m[1]]); }
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) parts.push({ text: text.slice(at, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** 「Gemini 4 Argon、3.8 Flash…」: the first two preset models of a service as one line. */
export function modelSummary(p: ProviderInfo): string {
  const names = p.models.slice(0, 2).map((m) => m.label ?? m.id);
  if (!names.length) return p.group === 'local' ? '用你本机加载的模型' : '先拉取模型列表，或输入模型 ID';
  return `${names.join('、')}${p.models.length > 2 ? '…' : ''}`;
}
