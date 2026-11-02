/* 白花海：栏底六七朵五瓣白花（11–14 px），夹一两朵安提灵幽蓝，高低错落，短茎两片叶，脚下一抹雪。
   种子固定，所以每次长得一样；纯装饰、静止、aria-hidden。 */
import { useId, useMemo } from 'react';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function FlowerSea({ w = 216, h = 56, seed = 7, n = 7, className }: { w?: number; h?: number; seed?: number; n?: number; className?: string }) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const flowers = useMemo(() => {
    const r = mulberry32(seed);
    const blue = new Set<number>([n > 3 ? 2 : 1]);
    if (n > 5) blue.add(n - 2);
    return Array.from({ length: n }, (_, k) => {
      const cx = (k + 0.5) * (w / n) + (r() - 0.5) * (w / n) * 0.4;
      const sz = 11 + r() * 3.2;
      const top = h - 15 - r() * (h - 30);
      const lean = (r() - 0.5) * 6;
      const base = h - 6;
      const ly = base - (base - top) * 0.42;
      return { cx, sz, top, lean, base, ly, rot: Math.round(r() * 72), blue: blue.has(k) };
    });
  }, [w, h, seed, n]);
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${gid}-snow`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e9e3f6" stopOpacity=".34" />
          <stop offset="1" stopColor="#e9e3f6" stopOpacity=".06" />
        </linearGradient>
      </defs>
      <path d={`M0 ${h}V${h - 9}Q${w * 0.14} ${h - 17} ${w * 0.3} ${h - 10}T${w * 0.58} ${h - 11}T${w * 0.84} ${h - 8}T${w} ${h - 12}V${h}Z`} fill={`url(#${gid}-snow)`} />
      {flowers.map((f, i) => (
        <g key={i}>
          <path
            d={`M${(f.cx - f.lean * 0.3).toFixed(1)} ${f.base}Q${(f.cx + f.lean * 0.8).toFixed(1)} ${((f.base + f.top) / 2).toFixed(1)} ${f.cx.toFixed(1)} ${(f.top + f.sz * 0.35).toFixed(1)}`}
            fill="none" stroke="#a79bc4" strokeWidth="1.1" strokeOpacity=".7" strokeLinecap="round"
          />
          <path
            d={`M${f.cx.toFixed(1)} ${f.ly.toFixed(1)}q-5 -1 -6.5 -5.5 4.4 .4 6.5 5.5zM${f.cx.toFixed(1)} ${(f.ly + 3).toFixed(1)}q5 -1 6.5 -5.5 -4.4 .4 -6.5 5.5z`}
            fill="#8f86b4" fillOpacity=".6"
          />
          <use
            href={f.blue ? '#alt-flower' : '#alt-wf'}
            x={(f.cx - f.sz / 2).toFixed(1)} y={(f.top - f.sz / 2).toFixed(1)} width={f.sz.toFixed(1)} height={f.sz.toFixed(1)}
            transform={`rotate(${f.rot} ${f.cx.toFixed(1)} ${f.top.toFixed(1)})`}
            style={{ filter: 'drop-shadow(0 0 4px rgba(240,236,255,.4))' }}
          />
        </g>
      ))}
    </svg>
  );
}
