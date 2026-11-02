/* main.tsx 里**最先**执行的模块（import 它放在第一行：ES 模块的依赖先于 main.tsx 的正文求值，其余模块还没开始跑）。
   页面最早能同步做的两件事：
     1. 把 <html data-mode> 设成本机偏好里的主题——昼主题的用户不会先闪一帧夜色（CSP 不许内联脚本，所以只能在这里；index.html 里的内联样式只给两种主题各一个底色）；
     2. 开屏要播的话，立刻开始预加载当前主题的开屏图片并 decode()、加载字体——与后面「读存储、渲染 React」并行，BootSplash 复用同一批 Image
        （原来这些要等 React 挂载、场景建好才开始，窗口露出来时开屏还没画好）。昼开屏想用预渲染视频（boot/bootVideo.ts）时同样提前建 <video> 读文件，BootSplash 取走同一个元素。
   这里读到的只是提示：真正的状态仍由 persist.loadState 载入（main.tsx 里随后会再设一次 data-mode）。读不到（无痕窗口、存储被禁用）就什么都不做. */
import { version as APP_VERSION } from '../../package.json';
import { preloadBoot } from '../components/decor/boot/preload';
import { bootImpl, bootVideoRequested } from '../components/decor/boot/bootImpl';
import { bootVideoEligible, preloadBootVideo } from '../components/decor/boot/bootVideo';
import { shouldPlayBoot } from '../components/decor/bootPolicy';
import { readEarlyPrefs } from '../state/prefsKeys';
import type { ThemeId } from './types';

function run() {
  if (typeof document === 'undefined') return;
  const { mode, bootAnimation, bootVideo } = readEarlyPrefs();
  const theme: ThemeId = mode ?? 'night';
  if (mode) document.documentElement.dataset.mode = mode;
  try {
    if (shouldPlayBoot(APP_VERSION, bootAnimation ?? true)) {
      preloadBoot(theme, import.meta.env.BASE_URL);
      if (wantsVideo(theme, bootVideo)) preloadBootVideo(import.meta.env.BASE_URL);
    }
  } catch { /* 预加载只是提速，失败了开屏自己会加载 */ }
}

/** 昼开屏想用视频、而且此刻的窗口 / 系统偏好允许（能力判定与加载结果留给 BootSplash 的判决点）. DEV 的导出模式（?bootcap=）不用视频. */
function wantsVideo(theme: ThemeId, setting: boolean | undefined): boolean {
  if (theme !== 'day' || !bootVideoRequested(theme, setting)) return false;
  let reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* 当作没开 */ }
  try { if (new URLSearchParams(window.location.search).has('bootcap')) return false; } catch { /* 没有查询串 */ }
  return bootVideoEligible({ theme, impl: bootImpl(), requested: true, w: window.innerWidth, h: window.innerHeight, reduced, hidden: document.hidden, capability: true, loaded: true }).ok;
}
run();
