/* 显卡种类（集显 / 独显）→ 调速器的保护档。
   独显持续 3D 负载会触发本机的 ACPI 中断风暴，所以独显上开屏 / 转场的残余 JS 节拍仍保持约 60 次/秒（governor.ts 的 setDiscrete）；集显没有这个风险，满刷新。
   种类的来源（都不在开屏期间收集 GPU 信息——'complete' 要多跑一趟，实测会让 dxdiag 类的进程在开屏 / 转场边上冒出来）：
     ① 设置 › 外观 › 图形处理器问到真实结果时，连同当时的启动偏好记在 localStorage['alight.gpuKind']（'<atLaunch>:<kind>'，rememberGpuKind，AppearanceSection 调）；
     ② 开屏时先按记录设保护档，再问主进程「这次启动用的偏好」（desktop.app.gpu(true)，不收集信息）核对：偏好没变就信记录；
        变了（用户在设置里换了显卡再重启）或没有记录，就按偏好算——'high' = 走独显，'low' / 'auto' 按集显（本机 auto = 集显）. */
import { desktop } from '../../../lib/desktop';
import { bootGovernor } from './governor';

const KEY = 'alight.gpuKind';
type Kind = 'discrete' | 'integrated';

/** 解析记录：'<atLaunch>:<kind>'；旧版只存了 kind（没有偏好），at 为空，按「偏好对不上」处理. */
function parse(v: string | null): { at: string; kind: Kind | null } {
  const m = /^(?:(auto|low|high):)?(discrete|integrated)$/.exec(v ?? '');
  return m ? { at: m[1] ?? '', kind: m[2] as Kind } : { at: '', kind: null };
}

/** 这次启动是不是独显：记录是在同一个启动偏好下问到的就信记录，否则按偏好. */
export function discreteFor(record: string | null, atLaunch: string): boolean {
  const r = parse(record);
  return r.kind && r.at === atLaunch ? r.kind === 'discrete' : atLaunch === 'high';
}

/** 设置页拿到真实的显卡种类时，连同这次启动用的偏好一起记下来（下次开屏核对用）. */
export function rememberGpuKind(kind: string | undefined, atLaunch: string | undefined): void {
  if ((kind !== 'discrete' && kind !== 'integrated') || !atLaunch) return;
  try { localStorage.setItem(KEY, `${atLaunch}:${kind}`); } catch { /* 存不了就算了 */ }
}

/** 开屏一开始：先用记下来的种类设保护档，再按这次启动的偏好核对（轻量、不收集 GPU 信息）. 返回取消函数. */
export function applyGpuKind(): () => void {
  let rec: string | null = null;
  try { rec = localStorage.getItem(KEY); } catch { /* 读不了就当没有记录 */ }
  bootGovernor.setDiscrete(parse(rec).kind === 'discrete');
  let dead = false;
  const q = desktop?.app?.gpu?.(true);
  if (!q) return () => undefined;
  q.then((s) => { if (!dead && s) bootGovernor.setDiscrete(discreteFor(rec, s.atLaunch)); }).catch(() => undefined);
  return () => { dead = true; };
}
