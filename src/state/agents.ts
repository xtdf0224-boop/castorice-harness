/* 命令行代理的页面数据与动作（MODELS-SPEC §10、§14）。
   - 代理的定义：目录里的 19 个预设（lib/services.ts 的 AGENT_DEFS）+ 用户自己添加的（官方注册表 / 自定义命令；经 svc:list 拿到，主进程已去掉可执行文件路径）。
   - 「命令行」分组的伪服务：没有绑定到服务的代理（11 个预设 + 用户添加的）各是一张卡片；`pseudoServiceOf` 与主进程的 electron/ai/acp-agents.cjs: pseudoService
     是同一条规则（check-services 把两份对表）。绑定了服务的代理（Gemini CLI、Kimi…）不是伪服务，它们是那个服务卡片里的一种「命令行」方式。
   - 探测（acp:probe）与注册表（acp:registry / acp:add-registry）、自定义命令（acp:pick-exe / acp:add-custom）、移除（acp:remove）的动作和它们的页面状态。
   这个文件不引用任何组件；AgentPane.tsx 用它，state/services.ts 把它的伪服务并进服务表。 */
import { useSyncExternalStore } from 'react';
import { desktop } from '../lib/desktop';
import type { LiveModel } from '../lib/effort';
import { agentDriverInfo, registerDriver } from '../lib/providers';
import { AGENT_DEFS, type AcpAgentDef, type AcpProbeResult, type RegistryRow, type ServiceDef } from '../lib/services';
import type { CliStatus, DriverId } from '../lib/types';
import { announce, toast } from './engine';
import { store } from './store';

/* ═══════════════════════════ definitions ═══════════════════════════ */

export type AgentSource = 'preset' | 'registry' | 'custom';
/** An agent as the page sees it: the definition plus where it came from; a registry agent also carries its pinned version and the exact command. */
export interface AgentRec extends AcpAgentDef {
  source: AgentSource;
  registry?: { id: string; version: string; dist: 'npx' | 'uvx'; command?: string };
}

export const agentDriverId = (id: string): DriverId => `acp:${id}`;
export const pseudoId = (id: string) => `acp_${id}`;

/** 1–2 characters for a tile, the way the service tiles do it (the same rule as acp-agents.cjs: glyphOf). */
export function glyphOf(label: string): string {
  const first = (label.trim().split(/[\s（(·\-_]+/).filter(Boolean)[0] ?? '?');
  const chars = [...first];
  if (/\p{Script=Han}/u.test(chars[0])) return chars[0];
  return `${chars[0].toUpperCase()}${(chars[1] ?? '').toLowerCase()}`;
}

/** A stand-alone agent as a service card (acp-agents.cjs: pseudoService is the same rule). */
export function pseudoServiceOf(a: AgentRec): ServiceDef {
  const hasKey = a.binding.mode === 'env' && !a.vendor;
  return {
    id: pseudoId(a.id), kind: 'agent', name: a.label.slice(0, 40), vendor: a.source === 'registry' ? '官方注册表' : a.source === 'custom' ? '自定义命令' : '命令行代理',
    glyph: glyphOf(a.label), group: 'cli', aliases: [a.id, ...a.bin].slice(0, 6), protocol: 'none',
    endpoints: [{ id: 'cli', label: '命令行', kind: 'payg' }],
    auth: hasKey ? { scheme: 'bearer', keyOptional: true } : { scheme: 'none' },
    models: [], drivers: [agentDriverId(a.id)], keyHelp: a.auth.loginHint || '', docsUrl: a.docsUrl, verified: a.verified, unverified: (a.unverified ?? []).slice(), hidden: !!a.hidden,
  };
}

/* ═══════════════════════════ the user's own agents ═══════════════════════════ */

let userList: AgentRec[] = [];
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version += 1; listeners.forEach((l) => l()); };
export const agentsVersion = () => version;
export function subscribeAgents(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** Re-render when the list of agents (or a probe, or a detection) changes. */
export const useAgentsVersion = () => useSyncExternalStore(subscribeAgents, agentsVersion, agentsVersion);

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);

/** What svc:list says about an agent the user added → a record (the main process wrote it from a validated definition; this is only a guard). */
function toRec(raw: unknown): AgentRec | undefined {
  if (!isRec(raw) || typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{1,24}$/.test(raw.id)) return undefined;
  const source: AgentSource = raw.source === 'registry' ? 'registry' : raw.source === 'custom' ? 'custom' : 'preset';
  if (source === 'preset') return undefined;
  const auth = isRec(raw.auth) ? raw.auth : {};
  const binding = isRec(raw.binding) && raw.binding.mode === 'env' && typeof raw.binding.keyEnv === 'string'
    ? { mode: 'env' as const, keyEnv: raw.binding.keyEnv, env: {}, optional: true } : { mode: 'none' as const };
  const install = isRec(raw.install) ? raw.install : {};
  const reg = isRec(raw.registry) && (raw.registry.dist === 'npx' || raw.registry.dist === 'uvx')
    ? { id: text(raw.registry.id, 80), version: text(raw.registry.version, 40), dist: raw.registry.dist as 'npx' | 'uvx', command: text(raw.registry.command, 300) || undefined } : undefined;
  return {
    id: raw.id, label: text(raw.label, 60, raw.id), bin: Array.isArray(raw.bin) ? raw.bin.filter((b): b is string => typeof b === 'string').slice(0, 4) : [raw.id], args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string').slice(0, 8) : [],
    auth: { mode: auth.mode === 'env-key' ? 'env-key' : auth.mode === 'none' ? 'none' : 'own-login', loginHint: text(auth.loginHint, 400) },
    binding, install: { npm: text(install.npm, 200) || undefined, script: text(install.script, 400) || undefined, note: text(install.note, 400) || undefined },
    perm: { level: 'unverified' }, verified: text(raw.verified, 10, '1970-01-01'), docsUrl: text(raw.docsUrl, 300, 'https://agentclientprotocol.com/'), source, registry: reg,
  };
}

/** Take what svc:list said about the agents the user added; register their drivers so the rest of the page can name them. (No notification: the caller applies the services.) */
export function adoptUserAgents(raw: unknown): void {
  userList = (Array.isArray(raw) ? raw : []).map(toRec).filter((a): a is AgentRec => !!a).slice(0, 32);
  for (const a of userList) registerDriver(agentDriverInfo(a));
  bump();
}

/** state/services.ts sets this: the stand-alone agents are services too (engine list, task engines), so they are re-applied when the user's agents change. */
let agentsChanged: (() => void) | undefined;
export function onUserAgentsChanged(fn: () => void) { agentsChanged = fn; }

/** Ask the desktop side for the agents the user added (after an add / remove). */
export async function refreshUserAgents(): Promise<void> {
  if (!desktop?.services) return;
  try {
    const r = await desktop.services.list();
    adoptUserAgents(r.agents);
    agentsChanged?.();
  } catch { /* the desktop side is not answering: keep what is shown */ }
}
export const userAgents = (): AgentRec[] => userList.slice();

const presetRecs: AgentRec[] = AGENT_DEFS.map((a) => ({ ...a, source: 'preset' as const }));
/** Every agent the page knows: the catalog's, then the user's. */
export const allAgentRecs = (): AgentRec[] => [...presetRecs, ...userList];
/** The agents that are not bound to a service: they live in the 「命令行」 group. */
export const standaloneRecs = (opts: { hidden?: boolean } = {}): AgentRec[] => allAgentRecs().filter((a) => !a.vendor && (opts.hidden || !a.hidden));
/** The 「命令行」 group as service cards — what services.ts / the engine list need to treat a stand-alone agent like any other service. */
export const agentServices = (): ServiceDef[] => standaloneRecs().map(pseudoServiceOf);
export const agentRecOf = (id: string): AgentRec | undefined => allAgentRecs().find((a) => a.id === id);

/* ═══════════════════════════ feedback ═══════════════════════════ */

type Tone = 'success' | 'danger' | 'info' | 'warning';
const feedback = (tone: Tone, title: string, body?: string) => store.update((d) => { toast(d, { tone, title, body }); announce(d, `${title}${body ? `：${body}` : ''}`); });
const unwrap = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*':\s*/, '') : String(e));

/* ═══════════════════════════ probe (acp:probe) ═══════════════════════════ */

/** acp:probe's answer (lib/services.ts: AcpProbeResult carries the fields the main process adds). */
export type AcpProbe = AcpProbeResult;
export type ProbeState = { state: 'busy'; deep: boolean } | { state: 'done'; deep: boolean; result: AcpProbe } | { state: 'error'; deep: boolean; error: string };

const probes = new Map<string, ProbeState>();
export const probeOf = (id: string): ProbeState | undefined => probes.get(id);

/** Run acp:probe. `deep`: also open one session to read the models and modes (the card's 「读取模型与模式」). Never throws. */
export async function runProbe(id: string, deep: boolean): Promise<void> {
  if (!desktop?.acp) return;
  probes.set(id, { state: 'busy', deep });
  bump();
  try {
    const result = await desktop.acp.probe({ agent: id, deep, fresh: true });
    probes.set(id, { state: 'done', deep, result });
    if (deep) publishLiveModels(id, result);
  } catch (e) {
    probes.set(id, { state: 'error', deep, error: unwrap(e) });
  }
  bump();
}

/**
 * What 「读取模型与模式」 found becomes the agent's own model list in the page state (the same place Codex's account models live: `ModelState.live`), so the
 * model menus show what the agent really offers; its thought_level options become the 推理强度 levels (only the ones the workbench's ladder knows).
 */
function publishLiveModels(id: string, result: AcpProbe) {
  const s = result.summary;
  if (!result.ok || !s || !s.models.length) return;
  const levels = s.efforts.map((e) => e.level).filter((l): l is string => !!l);
  const current = s.efforts.find((e) => e.id === s.currentEffort);
  const list: LiveModel[] = s.models.map((m) => ({ id: m.id, label: m.label, note: m.note ? m.note.slice(0, 80) : undefined, efforts: levels, defaultEffort: current?.level ?? undefined, isDefault: m.id === s.currentModel }));
  const keys: DriverId[] = [agentDriverId(id)];
  const legacy = agentRecOf(id)?.legacyDriver;
  if (legacy) keys.push(legacy);
  store.update((d) => {
    const live = { ...(d.models.live ?? {}) };
    for (const k of keys) live[k] = list;
    d.models.live = live;
  });
}

/** The last probe's answer from the main process's cache, without starting anything (what the card asks when it opens). */
export async function loadCachedProbe(id: string): Promise<void> {
  if (!desktop?.acp || probes.has(id)) return;
  try {
    const result = await desktop.acp.probe({ agent: id, cacheOnly: true });
    if (result && result.ok && !probes.has(id)) { probes.set(id, { state: 'done', deep: !!result.deep, result }); bump(); }
  } catch { /* nothing cached */ }
}

/* ═══════════════════════════ detection of agents that are not (yet) a service card ═══════════════════════════ */

interface LocalCli { cli?: CliStatus; path: string; busy: boolean }
const locals = new Map<string, LocalCli>();
export const localCliOf = (id: string): LocalCli => locals.get(id) ?? { path: '', busy: false };
const setLocal = (id: string, patch: Partial<LocalCli>) => { locals.set(id, { ...localCliOf(id), ...patch }); bump(); };

/** The fallback detection (when the stand-alone agent has no ProviderConfig yet): the same call the cards make. */
export async function detectLocal(id: string): Promise<void> {
  if (!desktop) return;
  const path = localCliOf(id).path;
  setLocal(id, { busy: true });
  try {
    const r = await desktop.detect({ driver: agentDriverId(id), path: path || undefined });
    setLocal(id, { cli: { ...r, at: Date.now() }, busy: false });
  } catch (e) {
    setLocal(id, { cli: { found: false, login: 'unknown', detail: unwrap(e), at: Date.now() }, busy: false });
  }
}
export function setLocalPath(id: string, path: string) { setLocal(id, { path, cli: undefined }); }
export async function loginLocal(id: string): Promise<void> {
  if (!desktop) return;
  const r = await desktop.openLogin({ driver: agentDriverId(id), path: localCliOf(id).path || undefined });
  if (r.ok) feedback('info', '已打开登录窗口', `在新窗口里完成登录（${r.command}），然后回来点「检测」。`);
  else feedback('warning', '没能打开登录窗口', r.error);
}

/* ═══════════════════════════ the official registry, custom commands, removal ═══════════════════════════ */

export type { RegistryRow };
export interface RegistryListing { rows: RegistryRow[]; at?: number; stale?: boolean; error?: string }

const asRows = (v: unknown): RegistryRow[] => (Array.isArray(v) ? v.filter((r): r is RegistryRow => isRec(r) && typeof r.id === 'string' && typeof r.name === 'string') : []);

export async function loadRegistry(fresh: boolean): Promise<{ ok: true; listing: RegistryListing } | { ok: false; error: string }> {
  if (!desktop?.acp) return { ok: false, error: '需要桌面版。' };
  try {
    const r = await desktop.acp.registry({ fresh });
    if (!r.ok) return { ok: false, error: r.error ?? '没能读取官方注册表。' };
    return { ok: true, listing: { rows: asRows(r.value), at: r.at, stale: r.stale, error: r.error } };
  } catch (e) { return { ok: false, error: unwrap(e) }; }
}

/** After a native yes on the desktop side the agent is stored there. Returns the command that will run, or an error (including 「已取消」). */
export async function addFromRegistry(id: string): Promise<{ ok: true; id: string; command: string } | { ok: false; error: string }> {
  if (!desktop?.acp) return { ok: false, error: '需要桌面版。' };
  try {
    const r = await desktop.acp.addFromRegistry({ id });
    if (!r.ok) return { ok: false, error: r.error };
    await refreshUserAgents();
    feedback('success', '已添加命令行代理', r.value.install);
    return { ok: true, id: r.value.id, command: r.value.install };
  } catch (e) { return { ok: false, error: unwrap(e) }; }
}

/** Opens the native file dialog on the desktop side. The page gets a one-time token and the file's NAME — never its path. */
export async function pickExe(): Promise<{ ok: true; token: string; name: string } | { ok: false; error: string; canceled?: boolean }> {
  if (!desktop?.acp) return { ok: false, error: '需要桌面版。' };
  try {
    const r = await desktop.acp.pickExe() as unknown as { ok: boolean; value?: { token: string; name: string }; error?: string; canceled?: boolean };
    return r.ok && r.value ? { ok: true, ...r.value } : { ok: false, error: r.error ?? '没能选择文件。', canceled: r.canceled };
  } catch (e) { return { ok: false, error: unwrap(e) }; }
}

export async function addCustom(req: { token: string; label: string; args: string[]; envNames: string[] }): Promise<{ ok: true; id: string } | { ok: false; error: string; field?: string }> {
  if (!desktop?.acp) return { ok: false, error: '需要桌面版。' };
  try {
    const r = await desktop.acp.addCustom(req);
    if (!r.ok) return { ok: false, error: r.error, field: (r as { field?: string }).field };
    await refreshUserAgents();
    feedback('success', '已登记命令行代理', req.label);
    return { ok: true, id: r.value.id };
  } catch (e) { return { ok: false, error: unwrap(e) }; }
}

/** Remove an agent the user added (presets cannot be removed). Tasks that used it stay readable. */
export async function removeAgent(id: string): Promise<boolean> {
  if (!desktop?.acp) return false;
  try {
    const r = await desktop.acp.remove(id);
    if (!r.ok) { feedback('warning', '没能移除', r.error); return false; }
    probes.delete(id);
    locals.delete(id);
    await refreshUserAgents();
    feedback('info', '已移除命令行代理');
    return true;
  } catch (e) { feedback('warning', '没能移除', unwrap(e)); return false; }
}

/** The words people see for how far an agent's permission modes are known. */
export const PERM_WORDS = { verified: '已验证', unverified: '未验证' } as const;
