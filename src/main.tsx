import './lib/earlyBoot';       // 必须是第一行：同步设好 data-mode、开始预加载开屏素材，与下面所有模块的求值、读存储、渲染 React 并行
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './lib/presence';
import { startPet } from './pet/brain';
import { refreshModels } from './state/models';
import { startWindowVisibility } from './lib/windowVisibility';
import { flushSave, loadState, saveSoon, whenReady } from './state/persist';
import { startEngine } from './state/runner';
import { startShellSync } from './state/shell';
import { store } from './state/store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/decor.css';
import './styles/shell.css';
import './styles/console.css';
import './styles/workspace.css';
import './styles/views-tasks.css';
import './styles/views-config.css';
import './styles/views-live.css';
import './styles/menu.css';

startWindowVisibility();
const initial = loadState(Date.now());
document.documentElement.dataset.mode = initial.settings.mode;
store.init(initial, saveSoon);
startEngine();
void refreshModels();
startShellSync();
startPet();     // 桌宠的大脑（没有桌面桥的浏览器开发版里什么都不做）
window.addEventListener('pagehide', flushSave);
// A file dropped on the window must never replace the app page.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (e) => { if (!e.defaultPrevented) e.preventDefault(); });

// 桌面版的任务要从库里异步读（约 15–100 ms，内置 3 秒超时）：等读完再画首屏，免得先闪一下「没有任务」、
// 首页的「归来」也先按首次使用来画。浏览器开发版与没有桥时立刻就绪。
void whenReady().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
