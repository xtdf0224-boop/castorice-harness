/* Agent 页共用的 SVG 定义与小图形（施工图 §4.3，样稿 A 的牌框）。
   · 牌框的涡卷与叶翼是装饰（自绘，不是她的形象）；命途徽记是官方素材，只在 CSS 里用 filter 着成牌面的深紫，不碰她的立绘；
   · 三档符号形状固定、夜昼一致：白 = 亮盘，银 = 金属盘 + 虚线外环，黑 = 暗盘 + 斜杠（不只靠颜色分）。
   id 全带 tarot- 前缀；页面里只放一份（AgentsView 渲染）. */
import type { ToolPermission } from '../../../lib/types';

export function TarotDefs() {
  return (
    <svg className="tarot-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="tarot-corner" viewBox="0 0 100 100">
          <path d="M0 0H100C95 4 90 5 85 8C77 13 75 21 69 27C63 33 54 32 48 37C41 43 44 52 38 58C32 64 23 62 17 68C11 74 14 84 7 91C4 94 2 96 0 98Z" fill="currentColor" />
          <path d="M9 9C30 9 50 7 72 4" fill="none" stroke="#f3eee3" strokeOpacity=".75" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M9 9C9 28 7 48 4 70" fill="none" stroke="#f3eee3" strokeOpacity=".75" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M22 22C34 20 40 28 36 36 33 43 24 42 22 35" fill="none" stroke="#f3eee3" strokeOpacity=".85" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="26" cy="31" r="2.3" fill="#f3eee3" fillOpacity=".9" />
          <path d="M52 16C58 19 60 24 57 29" fill="none" stroke="#f3eee3" strokeOpacity=".6" strokeWidth="1" strokeLinecap="round" />
          <path d="M16 52C19 58 24 60 29 57" fill="none" stroke="#f3eee3" strokeOpacity=".6" strokeWidth="1" strokeLinecap="round" />
        </symbol>
        <symbol id="tarot-leaf" viewBox="0 0 100 90">
          <path d="M2 88C4 52 28 20 74 6C80 40 52 76 2 88Z" fill="currentColor" fillOpacity=".34" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M8 80C26 56 46 34 70 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M30 56C38 56 44 52 48 46M20 68C28 68 36 64 40 58" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </symbol>
        <symbol id="tarot-crescent" viewBox="0 0 24 24">
          <path d="M15.2 3.2a9 9 0 1 0 5.6 15.4 7.4 7.4 0 0 1-5.6-15.4z" fill="currentColor" />
          <path d="M19.2 4.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" fill="currentColor" />
        </symbol>
        <linearGradient id="tarot-silver" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eceaf4" />
          <stop offset="1" stopColor="#9a97b4" />
        </linearGradient>
        {/* 把官方单色白徽记着成牌面用色：只改徽记，不碰角色图 */}
        <filter id="tarot-plum" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0.294 0 0 0 0 0.149 0 0 0 0 0.439 0 0 0 1 0" />
        </filter>
      </defs>
    </svg>
  );
}

/** 三档符号（白 / 银 / 黑）. size 为 CSS px. */
export function TierGlyph({ tier, size = 14 }: { tier: ToolPermission; size?: number }) {
  return (
    <svg className={`tarot-glyph is-${tier}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {tier === 'auto' && <circle cx="8" cy="8" r="5.6" fill="var(--tier-auto)" stroke="#5b4a86" strokeWidth="1.6" />}
      {tier === 'confirm' && (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="var(--tier-confirm)" strokeWidth="1" strokeDasharray="2.4 1.9" />
          <circle cx="8" cy="8" r="4.9" fill="url(#tarot-silver)" stroke="#8a85ad" strokeWidth="1.4" />
        </>
      )}
      {tier === 'off' && (
        <>
          <circle cx="8" cy="8" r="5.6" fill="var(--tier-off)" stroke="#cfc6ea" strokeWidth="1.5" />
          <path d="M4.6 11.4L11.4 4.6" stroke="#cfc6ea" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
