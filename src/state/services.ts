/* 模型服务的页面状态: the custom services the desktop side holds, address overrides, pinned models, which region the old single-slot
   keys belong to, and the one-time carry-over of the first release's settings. The authority is the main process (electron/ai/services.cjs);
   this file asks it (desktop.services.*) and keeps a copy in the app state so the UI can render it. Nothing here is a request to a model service. */
import { desktop } from '../lib/desktop';
import { PROVIDERS, PROVIDER_BY_ID, defaultProviderConfig, hasProvider, readiness } from '../lib/providers';
import { customServices, isPresetId, keyHintFor, maybeService, setCustomMirror, setCustomServices, type ModelsListResult, type ProbeFound, type ServiceDef, type SvcResult } from '../lib/services';
import type { ProviderConfig } from '../lib/types';
import { adoptUserAgents, agentServices, onUserAgentsChanged } from './agents';
import { announce, toast } from './engine';
import { store } from './store';

/* ───────────── the last known custom services, for the moment before the desktop side answers ───────────── */

const MIRROR_KEY = 'alight/service-mirror';
const MIGRATED_KEY = 'alight/models-migrated';
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window, blocked storage: just not remembered */ } };

export function loadMirror() {
  const raw = lsGet(MIRROR_KEY);
  if (!raw) return [];
  try { const list = JSON.parse(raw); return Array.isArray(list) ? list : []; } catch { return []; }
}

/* ───────────── carry-over from the first release (MODELS-SPEC §13) ───────────── */

/** What the first release's page state said, kept until the desktop side has taken it over. */
let pendingLegacy: { regions: Record<string, string>; baseUrls: Record<string, string> } | undefined;
export function setPendingLegacy(p: typeof pendingLegacy) { pendingLegacy = p; }
export const getPendingLegacy = () => pendingLegacy;
export const migrationDone = () => lsGet(MIGRATED_KEY) === '1';

/** Providers whose 「服务地址」 edit has not been committed to the desktop side yet (models.ts keeps the debounce timers): their text must not be overwritten by a re-read. */
export const pendingOverrides = new Set<string>();

/** Hand the old settings to the main process (once; it is idempotent anyway). What it took stays on the page as the shown value (the page mirrors the desktop side's override). */
export async function migrateLegacy(): Promise<void> {
  const svc = desktop?.services;
  const legacy = pendingLegacy;
  if (!svc || !legacy) return;
  try {
    const r = await svc.migrate(legacy);
    if (!r.ok) return;
    const dropped = r.value.rejected;
    store.update((d) => {
      // an address the desktop side refused is not kept on the page either
      for (const x of dropped) { const c = d.models.providers[x.id]; if (c) c.baseUrl = ''; }
      for (const x of dropped) toast(d, { tone: 'warning', title: '一个旧的服务地址没有保留', body: `${PROVIDER_BY_ID[x.id].name}：${x.reason}` });
    });
    pendingLegacy = undefined;
    lsSet(MIGRATED_KEY, '1');
  } catch { /* try again at the next start */ }
}

/* ───────────── reading the desktop side ───────────── */

/** A config for every service the app knows (a new custom service gets the defaults); configs of services that are gone are kept (tasks may still name them). */
function ensureConfigs(models: { providers: Record<string, ProviderConfig> }) {
  for (const id of Object.keys(PROVIDER_BY_ID)) {
    if (!models.providers[id]) models.providers[id] = defaultProviderConfig(PROVIDER_BY_ID[id]);
  }
}

/** Put the saved-key hints (per slot) on each provider's config for the region that config uses. */
export function applyKeyHints(d: { models: { providers: Record<string, ProviderConfig>; keyHints?: Record<string, string>; keyBindings?: Record<string, string> } }, hints: Record<string, string>) {
  d.models.keyHints = hints;
  const bindings = d.models.keyBindings ?? {};
  for (const id of Object.keys(PROVIDER_BY_ID)) {
    const c = d.models.providers[id];
    const def = maybeService(id);
    if (c && def) c.keyHint = keyHintFor(def, c.region, hints, bindings);
  }
}

/** Ask for the custom services, address overrides, pinned models and key bindings. */
export async function refreshServices(): Promise<void> {
  const svc = desktop?.services;
  if (!svc) return;
  try {
    const list = await svc.list();
    // the stand-alone command-line agents (the catalog's and the user's) are services as well: task engines, key slots, the engine menu
    adoptUserAgents(list.agents);
    setCustomServices([...list.custom, ...agentServices()]);
    lsSet(MIRROR_KEY, JSON.stringify(list.custom.map((s) => ({ id: s.id, name: s.name, glyph: s.glyph, group: s.group }))));
    store.update((d) => {
      d.models.keyBindings = list.keyBindings;
      d.models.pinned = list.pinned;
      d.models.overrides = list.overrides;
      d.models.customMirror = list.custom.map((s) => ({ id: s.id, name: s.name, glyph: s.glyph, group: s.group }));
      ensureConfigs(d.models);
      for (const id of Object.keys(d.models.providers)) {
        const c = d.models.providers[id];
        const def = maybeService(id);
        // 「服务地址」 shows the desktop side's override for the selected region (unless the user is in the middle of typing, or the old settings have not been handed over yet)
        if (!pendingLegacy && !pendingOverrides.has(id)) { const o = list.overrides[id]; c.baseUrl = o && o.endpoint === c.region ? o.baseUrl : ''; }
        // a region that no longer exists (an edited custom service) falls back to the first one
        if (def && def.endpoints.length && !def.endpoints.some((e) => e.id === c.region)) c.region = def.endpoints[0].id;
        if (def && def.drivers.length && !def.drivers.includes(c.driver)) c.driver = def.drivers[0];
      }
      if (d.models.defaultEngine && !hasProvider(d.models.defaultEngine)) d.models.defaultEngine = '';
      applyKeyHints(d, d.models.keyHints ?? {});
    });
  } catch { /* the bridge is there but not answering: keep what we have */ }
}

/** The user added or removed a command-line agent (模型接入 → 命令行): the stand-alone agents are services too, so the services list follows. */
onUserAgentsChanged(() => {
  setCustomServices([...customServices().filter((s) => s.kind !== 'agent'), ...agentServices()]);
  store.update((d) => {
    ensureConfigs(d.models);
    if (d.models.defaultEngine && !hasProvider(d.models.defaultEngine)) d.models.defaultEngine = '';
  });
});

/** Remember the services of last time (names only) so tasks can name them before the desktop side answers. */
export function adoptMirror(saved: Array<{ id: string; name: string; glyph: string; group: ServiceDef['group'] }> | undefined) {
  const list = saved && saved.length ? saved : loadMirror();
  if (list.length) setCustomMirror(list);
}

/* ───────────── actions ───────────── */

const feedback = (tone: 'success' | 'danger' | 'info' | 'warning', title: string, body?: string) =>
  store.update((d) => { toast(d, { tone, title, body }); announce(d, `${title}${body ? `：${body}` : ''}`); });

/** Create or update a custom service. The desktop side validates everything again and may ask the user (natively) about a new host. */
export async function saveCustomService(def: Partial<ServiceDef> & { id?: string }): Promise<SvcResult<ServiceDef>> {
  const svc = desktop?.services;
  if (!svc) return { ok: false, error: '需要桌面版。' };
  const r = await svc.save(def);
  if (r.ok) { await refreshServices(); feedback('success', '服务已保存', r.value.name); }
  return r;
}

/** How many tasks name this service (the page knows them; the desktop side does not). */
export function tasksUsing(id: string): number {
  return Object.values(store.get().tasks).filter((t) => t.engine?.provider === id).length;
}

/** Delete a custom service with its keys, pinned models and cached lists. Tasks stay readable; they show 「（已删除）」. */
export async function removeCustomService(id: string): Promise<SvcResult<{ clearedSlots: number }>> {
  const svc = desktop?.services;
  if (!svc) return { ok: false, error: '需要桌面版。' };
  const name = PROVIDER_BY_ID[id].name;
  const r = await svc.remove(id);
  if (r.ok) {
    await refreshServices();
    feedback('info', '服务已删除', name);
  } else feedback('danger', '没能删除服务', r.error);
  return r;
}

/** Fetch one service's model list (the presets merged with the service's own list) and keep it in the app state. A failure keeps what was there. */
export async function refreshModelList(id: string, opts: { fresh?: boolean; cacheOnly?: boolean } = {}): Promise<ModelsListResult | undefined> {
  const svc = desktop?.services;
  const c = store.get().models.providers[id];
  if (!svc || !c) return undefined;
  let r: ModelsListResult;
  try { r = await svc.models({ service: id, endpoint: c.region, params: c.params, fresh: opts.fresh, cacheOnly: opts.cacheOnly }); } catch { return undefined; }
  store.update((d) => {
    d.models.liveApi = { ...(d.models.liveApi ?? {}), [id]: r.models };
    d.models.listMeta = { ...(d.models.listMeta ?? {}), [id]: { at: r.at, source: r.source, stale: r.stale, error: r.error, code: r.code } };
  });
  return r;
}

/**
 * When 模型接入 opens: bring the lists of services that are ALREADY set up (a key saved, an address known) up to date in the background — two at a time,
 * failures silent. Services that are not configured are never contacted (MODELS-SPEC I9).
 */
export async function refreshConfiguredLists(opts: { concurrency?: number } = {}): Promise<void> {
  const st = store.get().models;
  const todo = PROVIDERS.filter((p) => p.def.modelsApi && st.providers[p.id] && readiness(p, st.providers[p.id], 'api').ready);
  let next = 0;
  const worker = async () => { for (;;) { const p = todo[next++]; if (!p) return; await refreshModelList(p.id); } };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 2, todo.length) }, worker));
}

/** ★ a model in the picker (kept by the desktop side). */
export async function pinModel(id: string, model: string, on: boolean): Promise<void> {
  const svc = desktop?.services;
  if (!svc) return;
  const r = await svc.pin(id, model, on);
  if (r.ok) store.update((d) => { d.models.pinned = { ...(d.models.pinned ?? {}), [id]: r.value }; });
}

/** Look for model servers on this machine (a click, never automatic). */
export async function probeLocalServers(): Promise<ProbeFound[]> {
  const svc = desktop?.services;
  if (!svc) return [];
  try { return await svc.probeLocal(); } catch { return []; }
}

/** Switch on a preset that a probe found (nothing is saved until the user has chosen a model). Returns the service id when it exists. */
export function adoptProbe(found: ProbeFound): string | undefined {
  if (!isPresetId(found.service) && !maybeService(found.service)) return undefined;
  store.update((d) => {
    const c = d.models.providers[found.service];
    if (!c) return;
    c.auth = 'api';
    c.region = found.endpoint;
    if (!c.model && found.models[0]) c.model = found.models[0];
    c.test = undefined;
  });
  return found.service;
}
