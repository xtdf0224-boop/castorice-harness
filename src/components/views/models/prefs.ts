/* 模型接入页自己的界面偏好（MODELS-SPEC §3.4 / §14.2）：当前页签、折叠的分组、「显示未核实的预设」、打开页面时是否自动刷新列表，
   以及任务菜单要用的「最近用过的引擎与模型」（§14.7）。
   存 localStorage['alight/models-ui']；每次读写都包 try/catch —— 无痕窗口、清过站点数据、探针里存储可能不可用，缺了照常渲染。
   不放任何密钥，也不放服务地址。 */
import { useSyncExternalStore } from 'react';
import { TAB_ORDER, type TabId } from './browse';

export const PREFS_KEY = 'alight/models-ui';
const MAX_RECENT_ENGINES = 8;
const MAX_RECENT_MODELS = 8;
const MAX_ENGINES_WITH_MODELS = 24;

export interface ModelsUiPrefs {
  /** undefined = the default (已接入 when something is connected, else 全部). */
  tab?: TabId;
  /** Group ids the user folded (`intl`, `cn`, `hub`, `local`, `cli`, `connected`). */
  collapsed: Record<string, boolean>;
  showUnverified: boolean;
  /** Opening 模型接入 refreshes the model lists of services that are already set up (never of others). */
  autoRefresh: boolean;
  /** Engine keys (`claude:api`), most recent first. */
  recentEngines: string[];
  /** Per engine key: model ids, most recent first. */
  recentModels: Record<string, string[]>;
}

const DEFAULTS: ModelsUiPrefs = { collapsed: {}, showUnverified: false, autoRefresh: true, recentEngines: [], recentModels: {} };

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200).slice(0, max) : []);

/** Whatever was stored → a valid prefs object (unknown keys dropped, wrong types replaced by the defaults). */
export function sanitizePrefs(raw: unknown): ModelsUiPrefs {
  const out: ModelsUiPrefs = { ...DEFAULTS, collapsed: {}, recentEngines: [], recentModels: {} };
  if (!isRec(raw)) return out;
  if (typeof raw.tab === 'string' && (TAB_ORDER as string[]).includes(raw.tab)) out.tab = raw.tab as TabId;
  if (isRec(raw.collapsed)) for (const k of Object.keys(raw.collapsed).slice(0, 12)) if (raw.collapsed[k] === true && /^[a-z]{2,12}$/.test(k)) out.collapsed[k] = true;
  if (typeof raw.showUnverified === 'boolean') out.showUnverified = raw.showUnverified;
  if (typeof raw.autoRefresh === 'boolean') out.autoRefresh = raw.autoRefresh;
  out.recentEngines = strList(raw.recentEngines, MAX_RECENT_ENGINES);
  if (isRec(raw.recentModels)) for (const k of Object.keys(raw.recentModels).slice(0, MAX_ENGINES_WITH_MODELS)) { if (k.length < 100) out.recentModels[k] = strList(raw.recentModels[k], MAX_RECENT_MODELS); }
  return out;
}

let current: ModelsUiPrefs | undefined;
const listeners = new Set<() => void>();

function read(): ModelsUiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : undefined);
  } catch { return sanitizePrefs(undefined); }
}
function write(p: ModelsUiPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not remembered: fine */ }
}

export function getPrefs(): ModelsUiPrefs {
  if (!current) current = read();
  return current;
}
export function setPrefs(patch: Partial<ModelsUiPrefs>) {
  current = { ...getPrefs(), ...patch };
  write(current);
  listeners.forEach((l) => l());
}
/** Tests: forget the in-memory copy (the next read goes to storage again). */
export function __resetPrefs() { current = undefined; listeners.forEach((l) => l()); }
export const subscribePrefs = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function usePrefs(): ModelsUiPrefs { return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs); }

/** The user chose this model on this engine (the task menu's recents). The first model-less pick (a CLI's own default) only moves the engine. */
export function noteRecent(engineKey: string, model: string) {
  if (!engineKey) return;
  const p = getPrefs();
  const engines = [engineKey, ...p.recentEngines.filter((k) => k !== engineKey)].slice(0, MAX_RECENT_ENGINES);
  const recentModels = { ...p.recentModels };
  if (model) recentModels[engineKey] = [model, ...(recentModels[engineKey] ?? []).filter((m) => m !== model)].slice(0, MAX_RECENT_MODELS);
  // keep the stored object small: only engines still in play
  for (const k of Object.keys(recentModels)) if (!engines.includes(k) && Object.keys(recentModels).length > MAX_ENGINES_WITH_MODELS) delete recentModels[k];
  setPrefs({ recentEngines: engines, recentModels });
}
