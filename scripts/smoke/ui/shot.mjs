/* 临时/调试用：打开「模型接入」页截一张图。
   node scripts/smoke/ui/shot.mjs <输出.png> [night|day] [场景名]
   需要先在 5332 端口跑着 vite dev（见 scripts/smoke/ui/README 里的命令说明，或 docs 注释）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { SCENES } from './scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [out, mode = 'night', sceneName = 'mixed'] = process.argv.slice(2);
if (!out) { console.error('用法：node shot.mjs <输出.png> [night|day] [场景]'); process.exit(2); }
const URL_BASE = process.env.ALIGHT_DEV_URL || 'http://127.0.0.1:5332/?boot=0';

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-ui-'));
const H = Number(process.env.H || 1000);
const chrome = await launchChrome({ userDataDir: ud, width: Number(process.env.W || 1500), height: H, colorScheme: mode === 'day' ? 'light' : 'dark' });
try {
  await chrome.init(`window.__FAKE_CFG = ${JSON.stringify(SCENES[sceneName])};`);
  await chrome.init(fs.readFileSync(path.join(here, 'fake-bridge.js'), 'utf8'));
  await chrome.init(`try { localStorage.setItem('alight/e2e-mode', ${JSON.stringify(mode)}); } catch {}`);
  await chrome.goto(URL_BASE, '!!document.querySelector(".side-nav__gear")');
  if (mode === 'day') await chrome.eval(`document.documentElement.dataset.mode='day'`);
  await chrome.click('.side-nav__gear');
  await chrome.sleep(200);
  await chrome.eval(`[...document.querySelectorAll('.side-nav__menu-item')].find(b => b.textContent.includes('模型接入')).click()`);
  await chrome.waitFor('!!document.querySelector(".models-view")');
  await chrome.sleep(900);
  if (process.env.TAB) { await chrome.eval(`[...document.querySelectorAll('.choice-tabs label')].find(l => l.textContent.startsWith(${JSON.stringify(process.env.TAB)})).click()`); await chrome.sleep(400); }
  if (process.env.EVAL) { await chrome.eval(process.env.EVAL); await chrome.sleep(500); }
  await chrome.screenshot(out);
  console.log('截图', out, chrome.consoleLog.filter((l) => l.type === 'error' || l.type === 'exception').slice(0, 5));
} finally {
  await chrome.close();
  try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 下次再清 */ }
}
