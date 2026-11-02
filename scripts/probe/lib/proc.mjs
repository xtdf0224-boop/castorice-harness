// Windows 进程树快照：私有字节（privateBytes，与 Electron app.getAppMetrics() 的 memory.privateBytes 同一计数器，
// 即 PROCESS_MEMORY_COUNTERS_EX.PrivateUsage）、工作集、累计 CPU 秒。用一次性的 PowerShell 取，避免常驻采样器自己干扰测量。
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const PS_TREE = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$rootPid = [int]$args[0]
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
$byParent = @{}
$cmd = @{}
foreach ($p in $all) {
  $pp = [int]$p.ParentProcessId
  if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
  [void]$byParent[$pp].Add([int]$p.ProcessId)
  $cmd[[int]$p.ProcessId] = $p.CommandLine
}
$ids = New-Object System.Collections.ArrayList
$queue = New-Object System.Collections.Queue
$queue.Enqueue($rootPid)
while ($queue.Count -gt 0) {
  $id = $queue.Dequeue()
  [void]$ids.Add($id)
  if ($byParent.ContainsKey($id)) { foreach ($c in $byParent[$id]) { $queue.Enqueue($c) } }
}
$pws = @{}
foreach ($pp in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess, WorkingSetPrivate)) { $pws[[int]$pp.IDProcess] = [int64]$pp.WorkingSetPrivate }
$at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$procs = Get-Process -Id $ids.ToArray()
$out = @()
foreach ($p in $procs) {
  $out += [pscustomobject]@{
    pid = $p.Id
    name = $p.ProcessName
    privateBytes = [int64]$p.PrivateMemorySize64
    workingSet = [int64]$p.WorkingSet64
    privateWS = [int64]$pws[$p.Id]
    cpuSec = [double]$p.TotalProcessorTime.TotalSeconds
    handles = $p.HandleCount
    threads = $p.Threads.Count
    cmd = $cmd[$p.Id]
  }
}
@{ at = $at; procs = @($out) } | ConvertTo-Json -Depth 4 -Compress
`;

function classify(cmd, name) {
  const t = /--type=([\w-]+)/.exec(cmd ?? '');
  if (!t) return /crashpad/i.test(name) ? 'crashpad' : 'browser';
  const kind = t[1] === 'gpu-process' ? 'gpu' : t[1] === 'crashpad-handler' ? 'crashpad' : t[1];
  if (kind === 'utility') {
    const sub = /--utility-sub-type=([\w.]+)/.exec(cmd ?? '');
    return sub ? `utility:${sub[1].split('.').pop()}` : 'utility';
  }
  return kind;
}

/** 取 pid 为根的整棵进程树一次快照。 */
export function treeSnapshot(rootPid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${PS_TREE} } ${rootPid}`], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000,
  });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`进程树快照失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
  const j = JSON.parse(r.stdout.trim());
  const list = Array.isArray(j.procs) ? j.procs : j.procs ? [j.procs] : [];
  return {
    at: j.at,
    procs: list.map((p) => ({
      pid: p.pid, name: p.name, kind: classify(p.cmd, p.name),
      privateBytes: p.privateBytes, workingSet: p.workingSet, privateWS: p.privateWS ?? 0, cpuSec: p.cpuSec, handles: p.handles, threads: p.threads,
    })),
  };
}

export const MB = 1024 * 1024;

/** 汇总：进程树 privateBytes 合计、渲染进程合计（按类别）。 */
export function summarizeMemory(snap) {
  const by = {};
  const wsBy = {};
  let total = 0;
  let ws = 0;
  let pws = 0;
  for (const p of snap.procs) {
    by[p.kind] = (by[p.kind] ?? 0) + p.privateBytes;
    wsBy[p.kind] = (wsBy[p.kind] ?? 0) + (p.privateWS ?? 0);
    total += p.privateBytes;
    ws += p.workingSet;
    pws += p.privateWS ?? 0;
  }
  const mb = (n) => Math.round((n / MB) * 10) / 10;
  const gpu = by.gpu ?? 0;
  return {
    /** 进程树 privateBytes（提交量）合计，含 GPU 进程——O9 S2 的口径（与 app.getAppMetrics().memory.privateBytes 同一计数器）。 */
    totalMB: mb(total),
    /** 同上，去掉 GPU 进程（GPU 进程的提交量取决于驱动与是否有合成，和应用代码关系小）。 */
    totalExGpuMB: mb(total - gpu),
    /** 进程树「私有工作集」合计：真正驻留在内存里、不与其他进程共享的部分（任务管理器的「内存(活动专用工作集)」）。 */
    privateWorkingSetMB: mb(pws),
    workingSetMB: mb(ws),
    rendererMB: mb(by.renderer ?? 0),
    rendererPrivateWSMB: mb(wsBy.renderer ?? 0),
    byKindMB: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, mb(v)])),
    byKindPrivateWSMB: Object.fromEntries(Object.entries(wsBy).map(([k, v]) => [k, mb(v)])),
    processCount: snap.procs.length,
  };
}

/** 两次快照之间的 CPU：以「单核百分比」计（100 ＝ 吃满一个逻辑核；与 Electron percentCPUUsage 同口径），只算两次都在的进程。 */
export function cpuBetween(a, b) {
  const wall = (b.at - a.at) / 1000;
  if (wall <= 0) return { totalPct: 0, byKindPct: {}, wallSec: 0 };
  const prev = new Map(a.procs.map((p) => [p.pid, p]));
  const byKind = {};
  let total = 0;
  for (const p of b.procs) {
    const q = prev.get(p.pid);
    if (!q) continue;
    const pct = Math.max(0, ((p.cpuSec - q.cpuSec) / wall) * 100);
    byKind[p.kind] = (byKind[p.kind] ?? 0) + pct;
    total += pct;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { totalPct: r2(total), byKindPct: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, r2(v)])), wallSec: Math.round(wall * 10) / 10 };
}

export const LOGICAL_CPUS = os.cpus().length;

/** 结束整棵进程树；返回是否还有残留。 */
export function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 找出命令行里带某个 user-data-dir 的所有进程（收尾时确认没有残留）。 */
export function findByUserDataDir(dir) {
  const needle = dir.replace(/\//g, '\\').toLowerCase();
  const script = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $needle = $args[0]; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${script} } '${needle.replace(/'/g, "''")}'`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return r.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean);
}

export { spawn };

/* ───────────── 整机负载（判断测量有没有被别的进程干扰）───────────── */

export function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
  return { idle, total };
}

/** 两次 cpuTimes 之间整机 CPU 忙碌百分比（0–100，所有逻辑核平均）。 */
export function sysBusyPct(a, b) {
  const dt = b.total - a.total;
  return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10 : 0;
}

/** 等整机安静（连续 windowMs 内平均忙碌 ≤ maxPct）；超时就带着当前读数继续，并标记 noisy。 */
export async function waitQuiet({ maxPct = 12, windowMs = 1200, timeoutMs = 25000 } = {}) {
  const t0 = performance.now();
  for (;;) {
    const a = cpuTimes();
    await new Promise((r) => setTimeout(r, windowMs));
    const pct = sysBusyPct(a, cpuTimes());
    if (pct <= maxPct) return { pct, waitedMs: Math.round(performance.now() - t0), noisy: false };
    if (performance.now() - t0 > timeoutMs) return { pct, waitedMs: Math.round(performance.now() - t0), noisy: true };
  }
}
