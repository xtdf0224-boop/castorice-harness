/* 栖枝的两张壁纸。
   · 夜 · 冥河：用户选定的终版 —— GPT 绘制 + Real-ESRGAN 超分的 **AI 辅助同人图**，不是官方图；界面右下角署名。
   · 昼 · 花海：薰衣草底（程序合成）+ 官方立绘的虚影 + 日景图（GPT 绘制的 AI 辅助同人图）下部的花海；官方立绘本身在首页的拱窗里（DayStage）。
   两档宽度 1600 / 2560（avif + webp），在 public/wallpapers/ 里；生成脚本不随包。
   她在夜景图里的位置（脸约 57% / 22%）决定了每个页面把图推到哪里（faceX），见 decor.css 的 .wallpaper__frame。 */
import type { ThemeId, ViewId } from '../../lib/types';

export interface WallpaperDef {
  id: ThemeId;
  mode: ThemeId;
  title: string;
  /** Encoded widths available in public/wallpapers as <id>-<w>.avif / .webp. */
  widths: number[];
  /** object-position for 'cover' layers (the day backdrop). */
  focus: string;
  /** 画面来源署名（界面右下角）. */
  credit: { label: string; /** 壁纸右下角的短署名（夹在主栏与右栏之间的空隙里放得下） */ short: string; url?: string; via?: string };
  /** 缩略图旁的说明. */
  note: string;
}

export const WALLPAPERS: WallpaperDef[] = [
  {
    id: 'night', mode: 'night', title: '冥河岸，蝶落枝头',
    widths: [1600, 2560], focus: '57% 22%',
    credit: { label: '画面：AI 辅助同人图 · 角色版权归米哈游／HoYoverse，非官方同人作品', short: '画面：AI 辅助同人图 · 非官方同人' },
    note: 'GPT 绘制、Real-ESRGAN 超分的 AI 辅助同人图（用户选定终版）',
  },
  {
    id: 'day', mode: 'day', title: '花海与日光',
    widths: [1600, 2560], focus: '50% 100%',
    credit: { label: '立绘：官方 © miHoYo · 背景含 AI 辅助同人图，个人非商用同人项目', short: '立绘：官方 © miHoYo · 背景含 AI 辅助同人图' },
    note: '薰衣草底 + 官方立绘虚影 + AI 辅助同人图里的花海（官方立绘在首页拱窗里）',
  },
];

export const wallpaperFor = (mode: ThemeId) => WALLPAPERS.find((w) => w.mode === mode) ?? WALLPAPERS[0];

/** 夜景里她的脸在图宽的 57% 处；每个页面希望她的脸落在窗宽的这个比例上（首页 .65：首页没有右栏；其余 .73：落在主栏与右栏之间的空隙）。 */
export const NIGHT_FACE_IN_IMAGE = 0.57;
export const faceXFor = (view: ViewId, booting: boolean) => (booting ? 0.57 : view === 'new' || view === 'queue' ? 0.65 : 0.73);

/** 开屏转场用的小补丁（public/boot/night-bfpatch.webp，2560×1440 底图里的这一块）：枯枝上画中原有的那只紫蝶被抹掉之后的样子。
    开屏的底图里这只蝶不在（落点是新蝶的）；首页壁纸里它还在。转场期间补丁盖在壁纸上（玻璃之下），结束后慢慢淡去，见 decor.css 的 .wallpaper__bfpatch。 */
export const NIGHT_BF_PATCH = { x: 530, y: 1060, w: 180, h: 180, imgW: 2560, imgH: 1440 } as const;
