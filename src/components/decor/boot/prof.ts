/* 开屏 / 转场的轻量打点：测量台（perf-work/harness）在页面里放一个 globalThis.__bootProf = [] 就会收到 [标签, performance.now()]；没放就什么都不做（一次属性读取）。 */
export function tp(label: string): void {
  const p = (globalThis as unknown as { __bootProf?: Array<[string, number]> }).__bootProf;
  if (p) p.push([label, performance.now()]);
}
