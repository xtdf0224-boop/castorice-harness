// 小统计：分位数（线性插值）、摘要。样本很少（5–10 次）时 P95 基本就是最大值，报告里要写明。
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  if (v.length === 1) return v[0];
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

export const median = (v) => percentile(v, 50);
export const mean = (v) => { const x = v.filter(Number.isFinite); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN; };

export function summarize(values, digits = 0) {
  const v = values.filter(Number.isFinite);
  const r = (n) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);
  return {
    n: v.length,
    min: r(Math.min(...v)), median: r(percentile(v, 50)), mean: r(mean(v)),
    p75: r(percentile(v, 75)), p95: r(percentile(v, 95)), max: r(Math.max(...v)),
  };
}

/** 门槛 ＝ 绝对线与「基线 ×1.1」中较严（较小）者；没有基线时只用绝对线。 */
export function gate(absolute, baseline) {
  if (!Number.isFinite(baseline)) return { value: absolute, rule: '绝对线' };
  const scaled = baseline * 1.1;
  return scaled < absolute ? { value: scaled, rule: '基线×1.1' } : { value: absolute, rule: '绝对线' };
}

export const fmtMs = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : 'n/a');
export const fmtS = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(2)} s` : 'n/a');
