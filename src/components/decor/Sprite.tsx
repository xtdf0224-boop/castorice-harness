/* 栖枝的自绘母题：一次性渲染进 <body> 的 SVG 符号表，其余组件用 <use href="#alt-…"> 引用。
   全部自绘（取自 design/mockups/night/index.html 的符号表），不拷官方图形：
     alt-bf     蓝闪蝶（落蝶、完成时停落）
     alt-bfw    线框蝶（在途 / 运行中）
     alt-bp     胸前粉紫蝶徽
     alt-brand  品牌标「枝上蝶」
     alt-seed   火种五笔（自绘简化，非官方图标）
     alt-flower 安提灵花（幽蓝五瓣）　alt-wf 白花海里的一朵　alt-petal 花瓣
     alt-i-*    线性图标（提灯、印、船、旗、手套……），描边继承 currentColor
   色值是固定的（蝶永远是蓝闪蝶），不随主题变化。 */

import type { ReactElement } from 'react';
import { BRAND_TWIG_MAIN, BRAND_TWIG_SIDE, SEED_BASE_FILL, SEED_BASE_STROKE, SEED_STROKES } from './marks';

const WINGS = (
  <g id="alt-wings">
    <path d="M20 15.2C17.2 7.2 9.6 2 4.6 4.2 2 5.5 2.6 10.8 7.2 15.4c3.5 3 8 2.4 12.8-.2z" />
    <path d="M20 16.6C14.9 16.8 9 19.2 8.8 24c-.1 4.4 4.2 5.8 7.2 3.2 2.6-2.3 3.5-6.6 4-10.6z" />
    <path transform="translate(40 0) scale(-1 1)" d="M20 15.2C17.2 7.2 9.6 2 4.6 4.2 2 5.5 2.6 10.8 7.2 15.4c3.5 3 8 2.4 12.8-.2z" />
    <path transform="translate(40 0) scale(-1 1)" d="M20 16.6C14.9 16.8 9 19.2 8.8 24c-.1 4.4 4.2 5.8 7.2 3.2 2.6-2.3 3.5-6.6 4-10.6z" />
  </g>
);

const VEINS = (
  <g id="alt-veins" fill="none" strokeLinecap="round">
    <path d="M19 15C14.6 11.4 10 8 6.4 6.4M19 15.2C14.4 14.8 10 13.4 7.4 11.2M19.2 16.8C15.6 18.6 12 21.2 10.6 24.6M19.4 17.2C18 20 16.8 23.4 16.4 26.2" />
    <path transform="translate(40 0) scale(-1 1)" d="M19 15C14.6 11.4 10 8 6.4 6.4M19 15.2C14.4 14.8 10 13.4 7.4 11.2M19.2 16.8C15.6 18.6 12 21.2 10.6 24.6M19.4 17.2C18 20 16.8 23.4 16.4 26.2" />
  </g>
);

/** 线性图标：24×24 网格，描边由使用处的 CSS（.alt-ic）给出。 */
const ICONS: Record<string, ReactElement> = {
  /* 提灯：顶环 + 灯帽 + 鼓腹灯罩 + 灯脚 + 一点火苗 */
  lantern: (<><circle cx="12" cy="3.6" r="1.4" /><path d="M12 5v2M8.4 7.6h7.2M8.6 7.6C4.4 10.2 4.4 16.2 8.8 18.8h6.4c4.4-2.6 4.4-8.6-.2-11.2M9.6 18.8v2h4.8v-2" /><path d="M12 10.2c1.6 1.7 2 2.7 2 3.6a2 2 0 0 1-4 0c0-.9.4-1.9 2-3.6z" fill="currentColor" stroke="none" /></>),
  return: (<path d="M3.5 12h11M10.5 7l5 5-5 5M20 5v14" />),
  help: (<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7" /><circle cx="12" cy="16.7" r=".9" fill="currentColor" stroke="none" /></>),
  alert: (<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.2" /><circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none" /></>),
  boat: (<path d="M3.5 14.8h17l-2.6 4.4H6.1zM12 4.5v10.2M12 6c3 1.4 5 4.4 5.4 8.4H12" />),
  flag: (<path d="M6.5 21V4M6.5 4.8h11l-2.3 3.7 2.3 3.8h-11" />),
  seal: (<path d="M12 3a3 3 0 0 1 1.5 5.6V11h4.5a2 2 0 0 1 2 2v2H4v-2a2 2 0 0 1 2-2h4.5V8.6A3 3 0 0 1 12 3zM5 19h14" />),
  branch: (<><circle cx="6" cy="5.5" r="2" /><circle cx="6" cy="18.5" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7.5v9M18 10c0 4.5-5 5-10.6 7.3" /></>),
  'branch-h': (<><circle cx="6" cy="5.5" r="2" strokeDasharray="2 2" /><circle cx="6" cy="18.5" r="2" strokeDasharray="2 2" /><circle cx="18" cy="8" r="2" strokeDasharray="2 2" /><path d="M6 7.5v9M18 10c0 4.5-5 5-10.6 7.3" strokeDasharray="3 3" /></>),
  glove: (<path d="M8.2 21v-5l-2.6-3.4a1.6 1.6 0 0 1 2.5-2l1.4 1.6V6.2a1.5 1.5 0 0 1 3 0V10V5a1.5 1.5 0 0 1 3 0v5.5V7.2a1.5 1.5 0 0 1 3 0v8c0 3.2-1.6 5.8-5 5.8z" />),
  box: (<path d="M3.5 8L12 4l8.5 4v8.5L12 20.5l-8.5-4zM3.5 8l8.5 4 8.5-4M12 12v8.5" />),
  book: (<path d="M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10" />),
  history: (<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.5 4.5v4h4M12 7.8V12l3 2" />),
  gear: (<><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.7.73l-.2.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.2.38a2 2 0 0 0 2.7.73l.15-.08a2 2 0 0 1 2 0l.4.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.73l.4-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.7-.73l.2-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.2-.38a2 2 0 0 0-2.7-.73l-.15.08a2 2 0 0 1-2 0l-.4-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>),
  drop: (<><rect x="4" y="4" width="16" height="16" rx="3" strokeDasharray="3 2.6" /><path d="M12 8v7M9 12.5l3 3 3-3" /></>),
  gauge: (<><path d="M4.5 17a8.5 8.5 0 1 1 15 0M12 17l3.6-5" /><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" /></>),
  info: (<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.9" r=".9" fill="currentColor" stroke="none" /></>),
  eye: (<><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>),
  moon: (<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" /></>),
};

export const ALT_ICON_NAMES = Object.keys(ICONS);

export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="alt-g-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#62cdf0" /><stop offset=".55" stopColor="#6f9aee" /><stop offset="1" stopColor="#7a63e0" />
        </linearGradient>
        <linearGradient id="alt-g-pink" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e383e7" /><stop offset=".6" stopColor="#b86ad0" /><stop offset="1" stopColor="#9e55b3" />
        </linearGradient>
        <linearGradient id="alt-g-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f2fb" /><stop offset=".55" stopColor="#ad90b7" /><stop offset="1" stopColor="#865c98" />
        </linearGradient>
        {WINGS}
        {VEINS}
        {/* 蓝闪蝶：青蓝→蓝紫，深色翅脉 */}
        <symbol id="alt-bf" viewBox="0 0 40 32">
          <g stroke="#1b1e52" strokeWidth="2.1" strokeLinejoin="round" fill="url(#alt-g-blue)"><use href="#alt-wings" /></g>
          <g stroke="#1b1e52" strokeWidth=".9" opacity=".9"><use href="#alt-veins" /></g>
          <path d="M20 9.6v17.4" stroke="#1b1e52" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M20 10c-.7-2.6-2.2-4.2-4.2-5M20 10c.7-2.6 2.2-4.2 4.2-5" stroke="#1b1e52" strokeWidth="1" fill="none" strokeLinecap="round" />
        </symbol>
        {/* 线框蝶：在途 */}
        <symbol id="alt-bfw" viewBox="0 0 40 32">
          <g stroke="#7cc8f7" strokeWidth="1.5" strokeLinejoin="round" fill="rgba(124,200,247,.12)"><use href="#alt-wings" /></g>
          <g stroke="#7cc8f7" strokeWidth=".8" opacity=".75"><use href="#alt-veins" /></g>
          <path d="M20 9.6v17.4" stroke="#7cc8f7" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M20 10c-.7-2.6-2.2-4.2-4.2-5M20 10c.7-2.6 2.2-4.2 4.2-5" stroke="#7cc8f7" strokeWidth=".9" fill="none" strokeLinecap="round" />
        </symbol>
        {/* 昼景上的线框蝶：深蓝描边 */}
        <symbol id="alt-bfw-d" viewBox="0 0 40 32">
          <g stroke="#2a5ea8" strokeWidth="1.6" strokeLinejoin="round" fill="rgba(79,143,216,.16)"><use href="#alt-wings" /></g>
          <g stroke="#2a5ea8" strokeWidth=".8" opacity=".75"><use href="#alt-veins" /></g>
          <path d="M20 9.6v17.4" stroke="#2a5ea8" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        {/* 胸前粉紫蝴蝶徽章 */}
        <symbol id="alt-bp" viewBox="0 0 40 32">
          <g stroke="#402a51" strokeWidth="2.1" strokeLinejoin="round" fill="url(#alt-g-pink)"><use href="#alt-wings" /></g>
          <g stroke="#402a51" strokeWidth=".8" opacity=".8"><use href="#alt-veins" /></g>
          <path d="M20 9.6v17.4" stroke="#402a51" strokeWidth="2.2" strokeLinecap="round" />
        </symbol>
        {/* 枝上蝶：品牌标——一根细枝，一只收翅的蝶 */}
        <symbol id="alt-brand" viewBox="0 0 40 40">
          <path d={BRAND_TWIG_MAIN} fill="none" stroke="#d6d0ee" strokeWidth="1.6" strokeLinecap="round" />
          <path d={BRAND_TWIG_SIDE} fill="none" stroke="#d6d0ee" strokeWidth="1.15" strokeLinecap="round" />
          <g transform="translate(15.4 9.4) rotate(-14 12.4 16.7) scale(.62)">
            <g stroke="#1b1e52" strokeWidth="2.4" strokeLinejoin="round" fill="url(#alt-g-blue)"><use href="#alt-wings" /></g>
            <g stroke="#1b1e52" strokeWidth="1" opacity=".9"><use href="#alt-veins" /></g>
            <path d="M20 9.6v17.4" stroke="#1b1e52" strokeWidth="2.6" strokeLinecap="round" />
          </g>
        </symbol>
        {/* 昼：枝换成深紫，才压得住浅底 */}
        <symbol id="alt-brand-d" viewBox="0 0 40 40">
          <path d={BRAND_TWIG_MAIN} fill="none" stroke="#4a2d68" strokeWidth="1.7" strokeLinecap="round" />
          <path d={BRAND_TWIG_SIDE} fill="none" stroke="#4a2d68" strokeWidth="1.2" strokeLinecap="round" />
          <g transform="translate(15.4 9.4) rotate(-14 12.4 16.7) scale(.62)">
            <g stroke="#1b1e52" strokeWidth="2.4" strokeLinejoin="round" fill="url(#alt-g-blue)"><use href="#alt-wings" /></g>
            <g stroke="#1b1e52" strokeWidth="1" opacity=".9"><use href="#alt-veins" /></g>
            <path d="M20 9.6v17.4" stroke="#1b1e52" strokeWidth="2.6" strokeLinecap="round" />
          </g>
        </symbol>
        {/* 死亡火种：五条渐细的骨刺自弧形底座升起（自绘简化，非官方图标）；第 4、5 笔可单独淡出（加载五笔） */}
        <symbol id="alt-seed" viewBox="0 0 48 48">
          <g fill="currentColor">
            {SEED_STROKES.map((d, i) => <path key={i} d={d} />)}
            <path d={SEED_BASE_FILL} />
          </g>
          <path d={SEED_BASE_STROKE} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        {/* 安提灵花：幽蓝五瓣 */}
        <symbol id="alt-flower" viewBox="0 0 24 24">
          <g fill="#7f97f6" stroke="#1d2150" strokeWidth=".8" strokeOpacity=".55">
            {[0, 72, 144, 216, 288].map((r) => <ellipse key={r} cx="12" cy="6" rx="3.5" ry="5.2" transform={r ? `rotate(${r} 12 12)` : undefined} />)}
          </g>
          <circle cx="12" cy="12" r="2.4" fill="#e9f0ff" />
        </symbol>
        {/* 白花海里的一朵 */}
        <symbol id="alt-wf" viewBox="0 0 24 24">
          <g fill="#f2eff8" stroke="#a79fc6" strokeWidth=".7" strokeOpacity=".7">
            {[0, 72, 144, 216, 288].map((r) => <ellipse key={r} cx="12" cy="6.4" rx="3.6" ry="5" transform={r ? `rotate(${r} 12 12)` : undefined} />)}
          </g>
          <circle cx="12" cy="12" r="2.2" fill="#e6c88a" />
        </symbol>
        {/* 花瓣：完成时才落一次 */}
        <symbol id="alt-petal" viewBox="0 0 12 16">
          <path d="M6 .6C10.6 4.2 10.8 10.6 6 15.4 1.2 10.6 1.4 4.2 6 .6Z" fill="#f3e9f4" stroke="#c9b3d6" strokeWidth=".6" />
          <path d="M6 2.4V13" stroke="#e1c3d6" strokeWidth=".6" fill="none" />
        </symbol>
        {/* 枝上的细刺（荆棘） */}
        <symbol id="alt-twig" viewBox="0 0 60 16">
          <path d="M1 9C12 7 22 11 34 8.4 44 6.4 52 8 59 5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M14 8.6Q15 5.8 18 4.4M27 9.8Q27.4 12.6 30 14M42 7.4Q43 4.6 46 3.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </symbol>
        {Object.entries(ICONS).map(([name, body]) => (
          <symbol key={name} id={`alt-i-${name}`} viewBox="0 0 24 24">{body}</symbol>
        ))}
      </defs>
    </svg>
  );
}
