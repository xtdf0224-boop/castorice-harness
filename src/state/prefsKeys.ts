/* 偏好在 localStorage 里的键，以及夜 / 昼的取值规则。
   单独成一个没有依赖的小模块：lib/earlyBoot.ts 要在 main.tsx 最先执行的那一刻同步读出主题，不能为此把整个存储模块（immer、store、引擎……）先拉进来. */
import type { ThemeId } from '../lib/types';

export const PREFS_KEY = 'alight/prefs';
/** 萤火的键：从萤火分出来的第一次启动沿用它的数据。 */
export const LEGACY_PREFS_KEY = 'firefly-harness/prefs';

/** 萤火的两种视觉模式 → 栖枝的夜/昼（firefly → night，sam → day）；已经是新值的原样返回。 */
export function themeOf(v: unknown, legacy: boolean): ThemeId | undefined {
  if (v === 'night' || v === 'day') return v;
  if (legacy && v === 'firefly') return 'night';
  if (legacy && v === 'sam') return 'day';
  return undefined;
}

/** 昼开屏默认改回「实时」的那一版设置修订号（persist 的 SETTINGS_REV 5，用户 2026-10-29 定）：更早的存档里 bootVideo 为真是 beta.4 / beta.5 的默认，按假读.
    persist.migrateSettings 与下面的 readEarlyPrefs 共用——升级后第一次启动还没写回新存档时，早预加载与载入的设置也得同样不要视频. */
export const BOOT_LIVE_REV = 5;

export interface EarlyPrefs { mode?: ThemeId; bootAnimation?: boolean; bootVideo?: boolean }

/** 同步读本机偏好里的主题与开屏开关（与 persist.loadState 同一套键：先 alight/prefs，没有再看萤火的）。读不到（无痕窗口、存储被禁用、JSON 坏了）就都是 undefined. */
export function readEarlyPrefs(storage?: Pick<Storage, 'getItem'>): EarlyPrefs {
  let st = storage;
  if (!st) { try { st = localStorage; } catch { st = undefined; } }          // 无痕窗口 / 存储被禁用时访问 localStorage 本身就会抛
  const read = (key: string): { settingsRev?: unknown; settings?: Record<string, unknown> } | undefined => {
    try { const raw = st?.getItem(key); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
  };
  const own = read(PREFS_KEY);
  const old = own ? undefined : read(LEGACY_PREFS_KEY);
  const prefs = own ?? old;
  const settings = prefs?.settings;
  const rev = typeof prefs?.settingsRev === 'number' ? prefs.settingsRev : 1;   // 没存过修订号按 1，与 persist.loadState 的 settingsRev ?? 1 一致
  return {
    mode: themeOf(settings?.mode, !own),
    bootAnimation: typeof settings?.bootAnimation === 'boolean' ? settings.bootAnimation : undefined,
    bootVideo: typeof settings?.bootVideo === 'boolean' ? settings.bootVideo && rev >= BOOT_LIVE_REV : undefined,
  };
}
