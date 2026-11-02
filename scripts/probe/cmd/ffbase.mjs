// ffbase：建 / 拆「萤火 v2.0.0」基线应用（git worktree，8c4000c），供 baseline --app-dir / --vs 使用。
//   node scripts/probe/run.mjs ffbase            建好并打印目录（已存在就复用）
//   node scripts/probe/run.mjs ffbase --remove   拆掉
// 做的事：git worktree add → node_modules 目录联接（指向本仓库的，复用 Electron 45）→ 给 worktree 里的 electron/main.cjs 加两行「探针模式隐藏窗口」补丁
// （不改本仓库）→ 在 worktree 里 vite build（输出到 worktree 自己的 dist）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpRoot } from '../lib/launch.mjs';

export const FF_COMMIT = '8c4000c';

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });

export async function runFfbase(ctx) {
  const dir = path.join(tmpRoot(), 'ff-baseline');
  const repo = ctx.appDir;
  const junction = path.join(dir, 'node_modules');
  if (ctx.values.remove) {
    if (fs.existsSync(junction)) {
      // 先拆目录联接（rmdir 只删链接本身）；绝不能让 git 或 rm -r 顺着联接把本仓库的 node_modules 删掉
      const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'rmdir', junction.replace(/\//g, '\\')], { encoding: 'utf8', windowsHide: true });
      if (fs.existsSync(junction)) throw new Error(`目录联接没拆掉，已停止（不会调用 git worktree remove）：${r.stderr}`);
    }
    if (!fs.existsSync(path.join(repo, 'node_modules', 'electron'))) throw new Error('本仓库的 node_modules/electron 不见了——停止，先检查');
    const r = run('git', ['worktree', 'remove', '--force', dir], repo);
    run('git', ['worktree', 'prune'], repo);
    ctx.log(r.status === 0 ? `已拆除 ${dir}` : `git worktree remove：${r.stderr.trim()}`);
    return r.status === 0 ? 0 : 1;
  }
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    ctx.step(`git worktree add ${dir} ${FF_COMMIT}`);
    const r = run('git', ['worktree', 'add', '--detach', dir, FF_COMMIT], repo);
    if (r.status !== 0) throw new Error(`git worktree add 失败：${r.stderr}`);
  }
  if (!fs.existsSync(junction)) fs.symlinkSync(path.join(repo, 'node_modules'), junction, 'junction');
  // 隐藏窗口补丁（只改 worktree）
  const mainFile = path.join(dir, 'electron', 'main.cjs');
  let main = fs.readFileSync(mainFile, 'utf8');
  if (!main.includes('ALIGHT_PROBE')) {
    main = main
      .replace("  if (tray) return;", "  if (tray || process.env.ALIGHT_PROBE === '1') return;")
      .replace("  win.once('ready-to-show', () => win && win.show());", "  if (process.env.ALIGHT_PROBE !== '1') win.once('ready-to-show', () => win && win.show());");
    if (!main.includes('ALIGHT_PROBE')) throw new Error('main.cjs 里没找到要打补丁的两行（基线提交变了？）');
    fs.writeFileSync(mainFile, main);
  }
  if (!fs.existsSync(path.join(dir, 'dist', 'index.html')) || ctx.values.rebuild) {
    ctx.step('vite build（worktree 自己的 dist）');
    const b = run(process.execPath, [path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], dir);
    if (b.status !== 0) throw new Error(`vite build 失败：${b.stderr || b.stdout}`);
  }
  ctx.log(dir);
  process.stdout.write(`${dir}\n`);
  return 0;
}
