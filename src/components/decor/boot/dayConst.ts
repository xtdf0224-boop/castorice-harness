/* 昼 · 开屏与转场共用的几个常量与纯函数（不碰 DOM）。
   从 dayScene.ts 机械搬出，好让昼的合成器通道（dayComp.ts）也能用而不与 dayScene.ts 成环；dayScene.ts 把它们原样 re-export，check-boot 的 `DAY.xxx` 照旧. */
import { sstep, win } from './bootMath';

/** 绽开中心 C0：白花 / 花束处（避开她脚下的暗紫碎晶）；A：镜头缩放的原点；BIRTH：蝶出生处. */
export const DC = { C0: [1000, 760], A: [1060, 640], R0: 70, BIRTH: [936, 520] } as const;

/** 窗的左侧轮廓（描边 / 白框 / 投影）的不透明度随左缘速度（px/s）：> 1500 时 0.2，< 400 时 1，之间平滑（R5）. */
export const winEdgeAlpha = (v: number) => 0.2 + 0.8 * (1 - sstep(win(v, 400, 1500)));
/** 窗的轮廓 mask-clip: no-clip 的外沿（舞台单位，见 boot.css 的 .boot__archframe）与左缘起算的软边宽度. */
export const WIN_EDGE_PAD = 200;
/** R5：左缘高速移动时窗里的内容（立绘 / 临时薰衣草底）本身的左缘也羽化——clip-path 的硬切边把大块深色的巨瓣整齐地切成一根竖条，光去掉描边还不够。
    羽化宽度（舞台单位）随左缘速度（px/s）：< 600 时 0（窗停稳后是干净的拱窗边）、> 2500 时 WIN_SOFT.max. */
export const WIN_SOFT = { max: 90, v0: 600, v1: 2500 } as const;
export const winSoft = (v: number) => WIN_SOFT.max * sstep(win(v, WIN_SOFT.v0, WIN_SOFT.v1));
export const WIN_EDGE_SOFT = 190;
/** 窗的落影（与 decor.css 里真拱窗的 box-shadow: 0 14px 34px rgb(70 45 110 / 0.2) 同一个）：屏幕 px。 */
export const SHADOW_DY = 14;
export const SHADOW_BLUR = 34;
export const SHADOW_RGBA = 'rgba(70, 45, 110, 0.2)';
/** legacy：画在两张画布上，低分辨率画布是显示画布的 1/SHADOW_LOWRES（阴影是 σ = 17 px 的低频，放大 4 倍看不出来），SHADOW_PAD 是画布在窗的盒子之外多留的舞台单位（≥ 3σ + 偏移）. */
export const SHADOW_LOWRES = 4;
export const SHADOW_PAD = 90;

/** 主栏纸面（.app__main）下面的壁纸颜色的近似（屏幕 x 在纸面的范围里、整个高度的均值：测自昼的首页，竖向只在 ±5 级内变）。
    legacy 里纸面被前缘遮罩（右边透明）、羽化带里纸面渐隐：露出来的是这层壁纸（再被底板盖一部分）；comp 里纸面一直在，要在前缘右边 / 羽化带里把它「擦掉」，就铺一层这个颜色（只在纸面的范围里）. */
export const WALL_RGB = [219, 212, 231] as const;
/** 底板的底色层（.boot__plate 的 #d4c8e4）. */
export const PLATE_FILL_RGB = [212, 200, 228] as const;
