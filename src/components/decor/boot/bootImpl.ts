/* 开屏 / 转场的实现开关：'comp'（默认）= 合成器优先（WAAPI 采样 + 调速器），'legacy' = 旧路径（JS 逐拍写样式、60 fps 封顶，pacer.ts 的 TARGET_MS）。
   旧路径留着做对拍与回退：地址里带 ?bootimpl=legacy（开发与生产都认），或 setBootImpl('legacy')（测试）。
   旧路径在夜 / 昼的转场与开屏验收通过后整体删除。 */
export type BootImpl = 'legacy' | 'comp';
/** 地址里 ?bootimpl= 能写的取值：'video' 只是「昼开屏用预渲染视频」的别名，**解析成 'comp'**——BootImpl 不加第三个取值，
    dayScene / transition / BootSplash / governedFor 里一大堆 `bootImpl() === 'comp'` 的判断，加一个值它们会静默变成 legacy（docs/BOOT-VIDEO.md §0、§4.1）. */
export type BootImplRequest = BootImpl | 'video';

let forced: BootImpl | undefined;

function implParam(): BootImplRequest | undefined {
  try {
    const v = new URLSearchParams(window.location.search).get('bootimpl');
    if (v === 'legacy' || v === 'comp' || v === 'video') return v;
  } catch { /* 没有 window（node 里跑纯函数检查） */ }
  return undefined;
}

export function bootImpl(): BootImpl {
  if (forced) return forced;
  return implParam() === 'legacy' ? 'legacy' : 'comp';       // 'comp' / 'video' / 没写 → comp
}

let forcedVideo: boolean | undefined;
/** 仅测试：固定「昼开屏用视频」的取值（最高优先级）；传 undefined 恢复. */
export function setBootVideo(v: boolean | undefined): void { forcedVideo = v; }

/** 昼开屏这一次**想不想**用预渲染视频（只是意愿；能不能用还要过 bootVideoEligible 与加载）。夜恒为假。优先级自上而下：
    ① setBootVideo()（测试固定值）② 地址 ?bootimpl=：legacy → 假（旧路径没有调速器，视频无意义）、comp → 假（即「实时版」，A/B 的对照）、video → 真
    ③ 地址 ?bootvideo=1|0 ④ globalThis.__alightBootVideo（测量台的 init 脚本注入：打包后的应用用 loadFile 没有查询串）⑤ 设置 settings.bootVideo ⑥ 默认假（2026-10-29 用户改回实时；beta.4 / beta.5 曾默认视频）. */
export function bootVideoRequested(theme: string, setting?: boolean): boolean {
  if (theme !== 'day') return false;
  if (forcedVideo !== undefined) return forcedVideo;
  const v = implParam();
  if (v === 'legacy' || v === 'comp') return false;
  if (v === 'video') return true;
  try {
    const q = new URLSearchParams(window.location.search).get('bootvideo');
    if (q === '1') return true;
    if (q === '0') return false;
  } catch { /* 没有 window */ }
  const g = (globalThis as unknown as { __alightBootVideo?: unknown }).__alightBootVideo;
  if (typeof g === 'boolean') return g;
  if (typeof setting === 'boolean') return setting;
  return false;
}

/** 仅测试 / 调试：固定实现；传 undefined 恢复读地址. */
export function setBootImpl(v: BootImpl | undefined): void { forced = v; }

/** 哪些主题的开屏用调速器（解封 60 fps 封顶）。夜已接入合成器路径；昼的开屏（0.1.4 起）也用：绽开段每拍重光栅的东西（径向蒙版并集、花海条 / 光晕 / 光束）已拆成画布 / 位图 / 合成器层（dayScene.ts 的 fastMode），
    调速器再把节拍锁在约 120 次/秒（LOCK_HZ）。位图没备好的那几拍仍走旧的 DOM 路径（画面一致），调速器 + relaxOnce 兜底. */
const GOVERNED = new Set<string>(['night', 'day']);
export const governedFor = (theme: string): boolean => bootImpl() === 'comp' && GOVERNED.has(theme);
/** 开屏锁定的节拍（次/秒；调速器按刷新率取整数分频，见 governor.ts 的 setLock）。昼 = 120（用户的 240 Hz 屏上 = 每两个刷新出一张新画面）。
    夜保持原样（不锁）：夜的开屏本来就解封在满刷新，只有最后 1.8 s 的混合节拍，锁 120 是否更均匀要真窗口的数据说话（docs/BOOT-COMPOSITOR.md 的「昼开屏锁 120」一节）；
    测量台 / 实验可以用 globalThis.__alightLockHz = { night: 120 }（或地址里 ?lockhz=night:120,day:60）临时改. */
export const LOCK_HZ: Record<string, number> = { day: 120 };
export function lockHzFor(theme: string): number | undefined {
  try {
    const g = (globalThis as unknown as { __alightLockHz?: Record<string, number> | number }).__alightLockHz;
    if (typeof g === 'number') return g > 0 ? g : undefined;
    if (g && typeof g === 'object' && theme in g) return g[theme] > 0 ? g[theme] : undefined;
    const q = new URLSearchParams(window.location.search).get('lockhz');
    if (q) { for (const part of q.split(',')) { const [k, v] = part.split(':'); if (k === theme) { const n = Number(v); return n > 0 ? n : undefined; } } }
  } catch { /* 没有 window（node 里跑纯函数检查） */ }
  return LOCK_HZ[theme];
}
/** 转场的时钟用哪些主题的调速器：昼的转场已经全在合成器上（窗 / 立绘 / 底板 / 轮廓 / 蝶），残余 JS 只剩标题 / 枝 / 光尘小块，可以每个刷新都推进；
    昼的开屏也已接入（GOVERNED），见上. */
const GOVERNED_TR = new Set<string>(['night', 'day']);
export const governedForTransition = (theme: string): boolean => bootImpl() === 'comp' && GOVERNED_TR.has(theme);
