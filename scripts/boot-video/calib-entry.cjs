'use strict';
// 色彩标定用的 Electron 入口：在「屏外真窗口」（perf-work/realwin/offwin.cjs 的安全层：永远在所有显示器之外）里播放标定片，
// 页面 = <video>（1:1 物理像素）+ 一排同色的 DOM 色块。窗口显示后：读 MediaCapabilities / 视频状态 → capturePage() 存 PNG → 写 info.json（带 hwnd，
// 供 calibrate.py 用 ffmpeg gfxcapture 抓 DWM 合成后的窗口像素）→ 等 CAL_QUIT 文件出现后退出。
// 环境变量：CAL_URL（file:// 页面）、CAL_OUT（输出目录）、CAL_QUIT（出现这个文件就退出）、CAL_CODEC（MediaCapabilities 用的 codecs 字符串，可空）
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const REALWIN = 'G:/Claude Code Workplace/castorice-harness/perf-work/realwin';
const { createOffscreenWindow, hwndOf, displayRects } = require(REALWIN + '/offwin.cjs');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
for (const f of (process.env.CAL_FLAGS || '').split(',').filter(Boolean)) { const [k, v] = f.split('='); if (v === undefined) app.commandLine.appendSwitch(k); else app.commandLine.appendSwitch(k, v); }
const GEO = require('./geometry.json');
const OUT = process.env.CAL_OUT, QUIT = process.env.CAL_QUIT;
fs.mkdirSync(OUT, { recursive: true });
app.whenReady().then(() => {
  const win = createOffscreenWindow({ width: 1707, height: 1067, backgroundColor: '#000000', webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } }, () => {});
  win.loadURL(process.env.CAL_URL);
  win.once('ready-to-show', async () => {
    win.__safeShow();
    await new Promise((r) => setTimeout(r, Number(process.env.CAL_WAIT_MS || 1800)));
    const ev = (s) => win.webContents.executeJavaScript(s, true);
    const info = { hwnd: hwndOf(win), bounds: win.getBounds(), content: win.getContentBounds(), displays: displayRects(), pid: process.pid };
    try {
      info.page = await ev(`(async () => {
        const v = document.querySelector('video');
        const q = v.getVideoPlaybackQuality();
        const r = { dpr: devicePixelRatio, inner: [innerWidth, innerHeight], vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState, t: v.currentTime, paused: v.paused, err: v.error && v.error.code, dropped: q.droppedVideoFrames, total: q.totalVideoFrames, rect: (() => { const b = v.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })() };
        const cs = ${JSON.stringify(process.env.CAL_CODEC || '')};
        if (cs) { try { const m = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: 'video/mp4; codecs="' + cs + '"', width: ${GEO.width}, height: ${GEO.height}, framerate: 120, bitrate: 12000000 } }); r.mc = { supported: m.supported, smooth: m.smooth, powerEfficient: m.powerEfficient }; } catch (e) { r.mc = String(e); } }
        return r; })()`);
    } catch (e) { info.pageError = String(e); }
    try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, 'capturePage.png'), img.toPNG()); info.capturePageSize = img.getSize(); } catch (e) { info.capErr = String(e); }
    fs.writeFileSync(path.join(OUT, 'info.json'), JSON.stringify(info));
  });
  setInterval(() => { if (QUIT && fs.existsSync(QUIT)) app.quit(); }, 100);
});
app.on('window-all-closed', () => app.quit());
