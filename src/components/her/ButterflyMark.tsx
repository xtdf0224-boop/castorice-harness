/* 界面里的小蝶标（名牌的蝶、落蝶标记）：单色线条，跟随 currentColor.
   这是界面符号，不是她的形象；官方素材只走 lib/expr.ts 的路径. */
const WING_UP = 'M20 16C21.4 7.4 27.6 1.6 37.2 2.4C38.8 8.6 33.4 15.2 24 17.2Z';
const WING_LOW = 'M20.4 17.6C26.4 17.8 32.2 21.2 32.8 26.6C28.8 30.2 23 27.4 21 21.4Z';

export function ButterflyMark({ size = 16, wire = false, className }: { size?: number; wire?: boolean; className?: string }) {
  const px = Math.max(1, Math.round(size));
  return (
    <svg className={className} width={px} height={Math.round(px * 0.8)} viewBox="0 0 40 32" aria-hidden="true" focusable="false"
      fill={wire ? 'none' : 'currentColor'} stroke={wire ? 'currentColor' : 'none'} strokeWidth="1.8" strokeLinejoin="round">
      <path d={WING_UP} />
      <path d={WING_LOW} />
      <path d={WING_UP} transform="matrix(-1 0 0 1 40 0)" />
      <path d={WING_LOW} transform="matrix(-1 0 0 1 40 0)" />
      <path d="M20 9.5V25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
