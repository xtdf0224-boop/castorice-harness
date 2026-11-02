// 命令的公共上下文：解析目标应用、临时目录、日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { TARGETS, detectTarget, readPackage } from './targets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** scripts/probe/lib → 应用根目录（含 package.json） */
export const REPO_APP_DIR = path.resolve(here, '..', '..', '..');

export function makeContext(values, name) {
  const appDir = path.resolve(values['app-dir'] ?? REPO_APP_DIR);
  if (!fs.existsSync(path.join(appDir, 'package.json'))) throw new Error(`${appDir} 里没有 package.json`);
  const target = values.target ? TARGETS[values.target] : detectTarget(appDir);
  if (!target) throw new Error(`未知的 --target：${values.target}（可选 ff / alight）`);
  if (values.tmp) process.env.ALIGHT_PROBE_TMP = path.resolve(values.tmp);
  const t0 = Date.now();
  const log = (s = '') => process.stderr.write(`${s}\n`);
  const step = (s) => log(`[${name} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  return { appDir, repoAppDir: REPO_APP_DIR, target, values, log, step, pkg: readPackage(appDir), outDir: values.out ? path.resolve(values.out) : undefined };
}

/** 机器与应用环境，写进基线报告。 */
export function describeEnvironment(appDir) {
  const cpus = os.cpus();
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.SystemInformation]::PowerStatus; $g=(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ' | '; \"$($p.PowerLineStatus)|$g\""], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const [power, gpus] = (ps.stdout || '').trim().split('|');
  let electron = '';
  try { electron = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version; } catch { /* */ }
  return {
    cpu: cpus[0]?.model?.trim(), logicalCpus: cpus.length, ramGB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`, node: process.version, electron,
    power: power || 'unknown', gpus: gpus || 'unknown',
    capturedAt: new Date().toISOString(),
  };
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
