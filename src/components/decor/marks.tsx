/* 栖枝的小件：品牌标「枝上蝶」、火种五笔（加载与关于页）、蝶、线性图标。
   符号本体在 Sprite.tsx；这里只是带尺寸、可访问名称与主题选择的薄封装。 */
import { useApp } from '../../state/store';

/** 本地的 cx：这里不 import ../ui，免得 ui ↔ decor 成环（ui 的 Button 在 busy 时用 SeedLoader）。 */
const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** 品牌标：一根细枝，一只收翅的蝶。昼景上枝换成深紫。 */
export function BrandMark({ size = 32, glow = false, title, className, bootTarget }: { size?: number; glow?: boolean; title?: string; className?: string; /** 开屏转场的定位钩子（data-boot-target） */ bootTarget?: string }) {
  const mode = useApp((s) => s.settings.mode);
  return (
    <svg
      className={cx('brand-mark', glow && 'brand-mark--glow', className)}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-boot-target={bootTarget}
    >
      <use href={mode === 'day' ? '#alt-brand-d' : '#alt-brand'} />
    </svg>
  );
}

/** 蝶。solid = 蓝闪蝶（落蝶、完成）；wire = 线框蝶（在途 / 运行中）。 */
export function Butterfly({ size = 20, variant = 'solid', rotate = 0, className, title }: {
  size?: number; variant?: 'solid' | 'wire'; rotate?: number; className?: string; title?: string;
}) {
  const mode = useApp((s) => s.settings.mode);
  const href = variant === 'solid' ? '#alt-bf' : mode === 'day' ? '#alt-bfw-d' : '#alt-bfw';
  return (
    <svg
      className={cx('butterfly', `butterfly--${variant}`, className)}
      width={size}
      height={Math.round(size * 0.8)}
      viewBox="0 0 40 32"
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <use href={href} />
    </svg>
  );
}

/** 火种：五条渐细的骨刺自弧形底座升起。静态；加载时用 <SeedLoader/>。 */
export function Seed({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg className={cx('seed', className)} width={size} height={size} viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <use href="#alt-seed" />
    </svg>
  );
}

/** 火种的五笔（自绘简化，非官方图标）。Sprite 里的符号与这里的内联版共用同一份路径。 */
export const SEED_STROKES = [
  'M8 31C6 24 3.4 18 2.4 9.6 6.4 16 9.6 24 12.4 31Z',
  'M15 34C14 24 12.4 14 12.6 4.6 16 13 18.4 24 19.6 34Z',
  'M21.4 36C22 24 23 12 24 .8 25 12 26 24 26.6 36Z',
  'M33 34C34 24 35.6 14 35.4 5.6 32 14 29.6 24 28.4 34Z',
  'M40 31C42.4 25 44.4 20 45.6 13.6 41.4 18.4 38.2 24 35.6 31Z',
];
/** 品牌标「枝上蝶」的细枝（viewBox 40×40）：主枝与三根小杈。Sprite.tsx 的 alt-brand / alt-brand-d 与开屏转场里「枝伸向来蝶」的分身共用这一份。 */
export const BRAND_TWIG_MAIN = 'M2.5 34C9 32 15.5 34 22.5 31.2 27 29.4 30.5 26.6 36 21.8';
export const BRAND_TWIG_SIDE = 'M22.5 31.2c.4-2.3 2-3.9 4.2-4.6M12.6 33c-.2-1.8-1.1-3-2.6-3.7M30.4 25.6c1.6-.1 2.8.5 3.6 1.6';
export const SEED_BASE_FILL = 'M24 39.4C22 42.4 22 44.6 24 46.4 26 44.6 26 42.4 24 39.4Z';
export const SEED_BASE_STROKE = 'M5 31.4Q24 46 43 31.4';

/** 加载：五笔依次点亮，一个周期 ≥ 1.6 s；减少动态时五笔全亮。内联 SVG（<use> 里的路径够不着外部 CSS 动画）。 */
export function SeedLoader({ size = 28, label = '加载中', className, decorative }: { size?: number; label?: string; className?: string; decorative?: boolean }) {
  return (
    <span className={cx('seed-loader', className)} role={decorative ? undefined : 'status'}>
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <g fill="currentColor">
          {SEED_STROKES.map((d, i) => <path key={i} className="seed-s" d={d} />)}
          <path d={SEED_BASE_FILL} />
        </g>
        <path d={SEED_BASE_STROKE} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {!decorative && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** 线性图标（提灯、印、船、旗、手套……）。描边取 currentColor。 */
export function AltIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={cx('alt-ic', className)} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={`#alt-i-${name}`} />
    </svg>
  );
}
