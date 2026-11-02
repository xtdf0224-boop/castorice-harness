/* 开屏素材的提前加载。
   原来的顺序是：读存储 → 渲染 React → 开屏组件挂载 → 场景建好 → 这时才开始加载 / 解码底图和字体（主线程还被占住 330–380 ms），
   所以窗口露出来的时候开屏还没画好。现在 main.tsx 最先执行的模块（lib/earlyBoot.ts）一开始就调 preloadBoot()：
   图片的网络 / 文件读取、解码，字体的加载，都与「读存储、渲染 React」并行；场景里的 loadImg() 直接复用这里同一批已经 decode() 过的 Image。
   缓存按 URL 字符串认，所以这里的写法要与两个场景里的完全一致（scripts/check-boot.ts 会核对）. */
import type { BootTheme } from './bootTypes';

/** 要提前加载的图（相对资源前缀）。夜：nightScene.ts 里 P('…') 的三张底图；
    昼：官方立绘（splash）、花海条（P('day-strip.webp')）、人物抠图（figUrl）、窗里的花海条（flowersUrl）——后两张转场开始时才会用到，一并 decode 好，转场的第一帧不卡. */
export const NIGHT_IMAGES = ['boot/night-base.jpg', 'boot/night-island.webp', 'boot/night-water.png'] as const;
export const DAY_IMAGES = ['art/splash-official.webp', 'boot/day-strip.webp', 'art/figure-official.webp', 'art/day-flowers.webp'] as const;

export const bootImageUrls = (theme: BootTheme, base: string): string[] => (theme === 'day' ? DAY_IMAGES : NIGHT_IMAGES).map((n) => `${base}${n}`);

/** 场景里 document.fonts.load 的那几条（字体文件也提前开始加载）. */
export function bootFonts(theme: BootTheme): Array<[string, string]> {
  const f: Array<[string, string]> = [['500 20px "Cinzel"', 'ALIGHT'], ['600 40px "Noto Serif SC"', '栖枝遐蝶的']];
  if (theme === 'day') f.push(['700 40px "Noto Serif SC"', '栖枝']);
  return f;
}

const warm = new Map<string, Promise<HTMLImageElement>>();

/** 已经（正在）提前加载的那张图；没有 = undefined. */
export function preloadedImg(url: string): Promise<HTMLImageElement> | undefined {
  return warm.get(url);
}

function warmImg(url: string): Promise<HTMLImageElement> {
  const have = warm.get(url);
  if (have) return have;
  const p = new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.decoding = 'async';
    i.onerror = () => { warm.delete(url); rej(new Error(`boot: cannot load ${url}`)); };
    // 先等加载完，再 decode()：解码在合成器的解码线程上做，首次绘制时不再卡主线程
    i.onload = () => { i.decode().catch(() => undefined).then(() => res(i)); };
    i.src = url;
  });
  p.catch(() => undefined);          // 没人等它时失败也不要冒成未处理的拒绝；真正用到时 loadImg 会拿到同一个拒绝
  warm.set(url, p);
  return p;
}

/** 开始提前加载 theme 主题的开屏素材（图片 + 字体）。重复调用无害. */
export function preloadBoot(theme: BootTheme, base: string): void {
  for (const url of bootImageUrls(theme, base)) warmImg(url);
  try { for (const [font, text] of bootFonts(theme)) void document.fonts.load(font, text).catch(() => undefined); } catch { /* 没有 FontFaceSet：场景自己会等 */ }
}

/** 开屏结束后放掉缓存（解码后的底图要几十 MB）. 预览重播时会重新加载. */
export function releaseBootPreload(): void {
  warm.clear();
}
