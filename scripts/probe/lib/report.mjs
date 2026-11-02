// 把 baseline 的结果 JSON 渲染成 Markdown 表格（贴进 docs/BASELINE.md，或对比栖枝与基线）。
const n1 = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : '—');
const n0 = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');

function s1Table(s1, title) {
  const rows = [];
  const add = (name, v) => v && rows.push(`| ${name} | ${n0(v.first)} | ${n0(v.all.median)} | ${n0(v.all.p75)} | ${n0(v.all.p95)} | ${n0(v.all.max)} | ${n0(v.electronStartMs.median)} | ${n0(v.pageMs.median)} |`);
  add('空 Electron（底噪）', s1.floor);
  add(s1.refName ?? '基线', s1.ref);
  add(s1.selfName ?? '被测', { ...s1, first: s1.first });
  return [`**${title}**（毫秒；${s1.all.n} 轮）`, '', '| 应用 | 第 1 次 | 中位 | P75 | P95 | 最大 | Electron 起步（中位） | 页面（中位） |', '|---|---:|---:|---:|---:|---:|---:|---:|', ...rows].join('\n');
}

/** @param {any} r baseline 结果  @param {any} [base] 对照的基线结果 */
export function renderMarkdown(r) {
  const out = [];
  const e = r.env;
  out.push(`- 应用：${r.targetName} ${r.version}（\`${r.appDir}\`）`);
  out.push(`- 机器：${e.cpu}，${e.logicalCpus} 逻辑核，${e.ramGB} GB；${e.os}；电源：${e.power === 'Online' ? '接电' : e.power}；Electron ${e.electron}；Node ${e.node}`);
  out.push(`- 采样时间：${e.capturedAt}；参数：${JSON.stringify(r.params)}`);
  out.push('');
  if (r.s1) {
    const s1 = { ...r.s1, selfName: r.targetName, refName: r.vs ? r.vs.target : undefined };
    out.push(s1Table(s1, 'S1 冷启动到可输入（关开屏）'));
    if (r.s1.mainProcessInitMs !== undefined) out.push('', `主进程初始化耗时（应用的 Electron 起步 − 空 Electron 的 Electron 起步，中位）：${r.s1.mainProcessInitMs} ms。`);
    if (r.s1.paired) out.push('', `同场交错的逐轮差（被测 − 基线）：总时长中位 ${n0(r.s1.paired.deltaTotalMs.median)} ms，页面部分中位 ${n0(r.s1.paired.deltaPageMs.median)} ms。`);
    if (r.s1BootOn) out.push('', `开屏开着（\`bootEnter: auto\`）时主输入框可输入：中位 **${n0(r.s1BootOn.all.median)} ms**（${r.s1BootOn.all.n} 次；范围 ${n0(r.s1BootOn.all.min)}–${n0(r.s1BootOn.all.max)}）。`);
    out.push('');
  }
  if (r.idle) {
    const i = r.idle;
    out.push(`**S2 空闲内存 / S5 后台 CPU**（首页静置 → 打开 1 个 200 条消息的会话 → 静置 ${i.durationSec} s，每 ${i.sampleSec} s 采样）`);
    out.push('', '| 指标 | 数值 |', '|---|---:|');
    out.push(`| 进程树 privateBytes 合计（含 GPU 进程；末 3 个样本均值） | ${n1(i.final.totalMB)} MB |`);
    out.push(`| 其中：不含 GPU 进程 | ${n1(i.final.totalExGpuMB)} MB |`);
    out.push(`| 其中：渲染进程 | ${n1(i.final.rendererMB)} MB |`);
    out.push(`| 按进程类型（最后一个样本） | ${Object.entries(i.final.byKindMB).map(([k, v]) => `${k} ${n1(v)}`).join('，')} MB |`);
    out.push(`| 进程树私有工作集合计（RAM 里真正驻留、不共享的部分） | ${n1(i.final.privateWorkingSetMB)} MB |`);
    out.push(`| 进程树工作集合计（含共享页，仅作量级参照） | ${n1(i.final.workingSetMB)} MB |`);
    out.push(`| 后台 CPU 合计（单核%；${i.cpu.samples} 个样本，去掉前 60 s） | 单核口径均值 ${i.cpu.meanPct}%，最大 ${i.cpu.maxPct}%；折算占整机 ${Math.round((i.cpu.meanPct / r.env.logicalCpus) * 10000) / 10000}%（＝Electron percentCPUUsage 口径） |`);
    if (i.appMetrics) out.push(`| app.getAppMetrics()（${i.appMetrics.samples} 个样本） | percentCPUUsage 合计均值 ${i.appMetrics.cpuMeanPct}%，idleWakeupsPerSecond 合计均值 ${i.appMetrics.wakeupsMean} |`);
    out.push(`| 首页静置（对照） | privateBytes ${n1(i.home.memory.totalMB)} MB，CPU ${i.home.cpu.totalPct}% |`);
    out.push(`| 测量期间整机 CPU 忙碌均值 | ${i.sysBusyMeanPct ?? '—'}%（越高越可能被别的进程干扰） |`);
    out.push('');
  }
  if (r.floor) {
    const f = r.floor.memory;
    out.push(`**空 Electron 底噪**（同样窗口参数、一个空页面，静置后）：privateBytes ${n1(f.totalMB)} MB（GPU ${n1(f.byKindMB.gpu ?? 0)}、渲染 ${n1(f.rendererMB)}、主进程 ${n1(f.byKindMB.browser ?? 0)}、网络 ${n1(f.byKindMB['utility:NetworkService'] ?? 0)}），私有工作集 ${n1(f.privateWorkingSetMB)} MB，CPU ${r.floor.cpu.totalPct}%。`, '');
  }
  if (r.s3) {
    const s = r.s3;
    out.push(`**S3 长会话**（${s.messages} 条消息的会话 + 一个 200 条的会话，旧存储格式 ${Math.round(s.stateChars / 1024)} KB；${s.runs.length} 次）`);
    out.push('', '| 指标 | 数值 |', '|---|---:|');
    out.push(`| 启动到主输入框可输入（带这份历史） | 中位 ${n0(s.startupMs.median)} ms |`);
    out.push(`| 打开长会话到主线程安静 | 中位 ${n0(s.openToSettledMs.median)} ms（最大 ${n0(s.openToSettledMs.max)}） |`);
    out.push(`| 打开时连续忙碌（用户看到的卡死） | ${s.runs.map((x) => (x.openBlockedMs !== undefined ? n0(x.openBlockedMs) : '—')).join(' / ')} ms |`);
    out.push(`| 打开后渲染进程 privateBytes | 中位 ${n1(s.rendererMB_afterOpen.median)} MB（最大 ${n1(s.rendererMB_afterOpen.max)}）；私有工作集 ${n1(s.rendererPrivateWSMB_afterOpen.median)} MB |`);
    out.push(`| 打开后进程树 privateBytes | 中位 ${n1(s.totalMB_afterOpen.median)} MB |`);
    out.push(`| DOM 节点数 | ${s.domNodes ?? '—'} |`);
    out.push(`| 在长会话输入框打字：单键 CDP 往返 P95 | 中位 ${n0(s.typingP95Ms.median)} ms（最大 ${n0(s.typingP95Ms.max)}） |`);
    out.push(`| 「无响应」风险（连续忙碌或单键往返 ≥5 s） | ${s.unresponsiveRisk ? '**有**' : '无'} |`);
    out.push('');
  }
  if (r.verdict?.length) {
    out.push('**判定**（门槛＝绝对线与基线×1.1 取较严者；没有基线时只用绝对线）', '', '| 编号 | 指标 | 实测 | 绝对线 | 基线 | 门槛 | 规则 | 判定 |', '|---|---|---:|---:|---:|---:|---|---|');
    for (const v of r.verdict) out.push(`| ${v.id} | ${v.name} | ${v.value ?? '—'} ${v.unit} | ${Number.isFinite(v.abs) ? v.abs : '—'} | ${v.baseline ?? '—'} | ${Number.isFinite(v.gate) ? v.gate : '—'} | ${v.rule} | ${v.pass === null ? '—' : v.pass ? '通过' : v.informational ? '偏高（参考）' : '**未过**'} |`);
    out.push('');
  }
  return out.join('\n');
}
