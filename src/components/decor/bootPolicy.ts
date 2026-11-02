/* 开屏「蝶落枝头」什么时候播。
   · 设置 bootAnimation = 关 → 永不自动播（外观设置里仍可预览）。
   · 设置 bootAnimation = 开 → 默认「首次与升级后」：记下上次播过的版本号，版本变了才播；
     用户可改成「每次启动」（本机偏好 alight.boot.always，只是每台电脑一个开关，放 localStorage 即可）。
   读写都包 try/catch：无痕窗口、清过站点数据、探针里 localStorage 可能不可用，此时按「当作第一次」处理。 */

const SEEN_KEY = 'alight.boot.seenVersion';
const ALWAYS_KEY = 'alight.boot.always';

export type BootPolicy = 'always' | 'upgrade' | 'never';

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* 存不下就算了：下次启动再播一次而已 */ }
}

export function getBootPolicy(bootAnimation: boolean): BootPolicy {
  if (!bootAnimation) return 'never';
  return read(ALWAYS_KEY) === '1' ? 'always' : 'upgrade';
}

/** 把「每次启动 / 首次与升级后」存到本机；关闭走设置里的 bootAnimation。 */
export function setBootAlways(always: boolean) {
  write(ALWAYS_KEY, always ? '1' : null);
}

export function shouldPlayBoot(version: string, bootAnimation: boolean): boolean {
  // 仅开发：?boot=0 不播（截图评审用）；生产构建里这句整个被摘掉。
  if (import.meta.env.DEV && /[?&]boot=0(&|$)/.test(window.location.search)) return false;
  const policy = getBootPolicy(bootAnimation);
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return read(SEEN_KEY) !== version;
}

export function markBootSeen(version: string) {
  write(SEEN_KEY, version);
}
