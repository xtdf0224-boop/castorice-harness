// 找到该用哪个 claude 可执行文件。
// 默认＝用户自己装的、自己登录的 claude（PATH 上的 claude.cmd 旁边的 node_modules/@anthropic-ai/claude-code/bin/claude.exe）：
// 栖枝不碰令牌、不读凭据，登录状态完全是用户那份 claude 的。找不到时退回 SDK 随包的二进制，并在界面里说明。
const fs = require('node:fs');
const path = require('node:path');
const { resolveCommand } = require('./proc.cjs');

const isExe = (p) => /\.exe$/i.test(p || '');

/** npm 生成的 claude.cmd 里写着真正的 exe 在哪：`"%dp0%\node_modules\...\claude.exe"  %*`. */
function exeFromCmdShim(cmdPath) {
  const dir = path.dirname(cmdPath);
  let text = '';
  try { text = fs.readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const cands = [];
  const m = text.match(/%dp0%[\\/]+([^"\r\n]*?claude\.exe)/i) || text.match(/%~dp0[\\/]*([^"\r\n]*?claude\.exe)/i);
  if (m) cands.push(path.join(dir, m[1].replace(/[\\/]+/g, path.sep)));
  cands.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** 用户自己的 claude.exe；custom 是「模型接入 › 命令路径」里填的（.cmd 或 .exe）。找不到 null. */
function resolveUserClaudeExe(custom) {
  const found = custom || resolveCommand('claude');
  if (!found) return null;
  if (isExe(found)) return fs.existsSync(found) ? found : null;
  if (process.platform === 'win32') return exeFromCmdShim(found);
  return fs.existsSync(found) ? found : null;
}

/** SDK 随包的二进制（@anthropic-ai/claude-agent-sdk-<平台>）；打进 asar 时要在 asar.unpacked 里. */
function sdkBundledExe() {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(exe) ? exe : null;
  } catch { return null; }
}

/**
 * @returns {{ path: string|undefined, source: 'user'|'sdk'|'none', note?: string }}
 *   source 'user'：用户自己的 claude；'sdk'：随包的（要在界面里说明）；'none'：都没有.
 */
function resolveClaudeForSdk(custom) {
  const own = resolveUserClaudeExe(custom);
  if (own) return { path: own, source: 'user' };
  const bundled = sdkBundledExe();
  if (bundled) {
    return { path: bundled, source: 'sdk', note: '没有找到你自己装的 claude，这次用栖枝随包的版本。登录状态仍然读取你电脑上 claude 的登录，栖枝不碰令牌。想固定用自己的版本，请在「模型接入」里填写 claude 的路径。' };
  }
  return { path: undefined, source: 'none', note: '找不到 claude：既没有 PATH 上的 claude，也没有随包的二进制。请先安装 Claude Code，或在「模型接入」里填写路径。' };
}

module.exports = { resolveUserClaudeExe, sdkBundledExe, resolveClaudeForSdk, exeFromCmdShim };
