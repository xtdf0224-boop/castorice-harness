import { version as APP_VERSION } from '../package.json';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Ambience, ButterflyLanding } from './components/decor/Ambience';
import { BootSplash } from './components/decor/BootSplash';
import { noteAppShown } from './components/decor/boot/warm';
import { shouldPlayBoot } from './components/decor/bootPolicy';
import { PeekBar } from './components/decor/PeekBar';
import { Sprite } from './components/decor/Sprite';
import { Wallpaper } from './components/decor/Wallpaper';
import { Console } from './components/console/Console';
import { DialogHost, LiveRegion, ToastHost } from './components/shell/hosts';
import { SideNav } from './components/shell/SideNav';
import { StatusPanel } from './components/shell/StatusPanel';
import { ViewBoundary } from './components/shell/ViewBoundary';
import { TrustDialogHost } from './components/shell/TrustDialogHost';
import { AgentsView } from './components/views/AgentsView';
import { HistoryView } from './components/views/HistoryView';
import { ModelsView } from './components/views/ModelsView';
import { QueueView } from './components/views/QueueView';
import { ReturnView } from './components/views/ReturnView';
import { SettingsView } from './components/views/SettingsView';
import { TaskListView } from './components/views/TaskListView';
import { ToolsView } from './components/views/ToolsView';
import { Workspace } from './components/workspace/Workspace';
import { useCommandKeys } from './lib/commands';
import { desktop } from './lib/desktop';
import { afterFrame, reportFirstFrame } from './lib/firstFrame';
import { focusIsLost, focusMainHeading } from './lib/focus';
import { useMedia, useReducedMotion } from './lib/hooks';
import { VIEWS_WITHOUT_STATUS } from './lib/status';
import type { ViewId } from './lib/types';
import { actions } from './state/actions';
import { store, useApp } from './state/store';

/** Page name for document.title; a task page uses the task's own title. */
const VIEW_TITLES: Record<Exclude<ViewId, 'task'>, string> = {
  new: '归来', queue: '待你', tasks: '任务列表', agents: 'Agent', tools: '工具与技能', models: '模型接入', history: '行迹', settings: '设置',
};

export function App() {
  const mode = useApp((s) => s.settings.mode);
  const view = useApp((s) => s.view);
  const hasTask = useApp((s) => !!(s.selectedTaskId && s.tasks[s.selectedTaskId]));
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const taskTitle = useApp((s) => (s.selectedTaskId ? s.tasks[s.selectedTaskId]?.title : undefined));
  const consoleOpen = useApp((s) => s.console.open);
  const consoleHeight = useApp((s) => s.console.height);
  const navCollapsed = useApp((s) => s.navCollapsed);
  const drawerOpen = useApp((s) => s.statusDrawerOpen);
  const peek = useApp((s) => !!s.peek && s.settings.wallpaper);
  const bootAt = useApp((s) => s.bootAt);
  // 开屏「蝶落枝头」：覆盖层，不是闸门——下面的应用一直可以输入。
  // 只在首次与升级后播（bootPolicy.ts；设置里可改为每次启动或关闭），外观设置的「预览」随时重播。
  const [booting, setBooting] = useState(() => shouldPlayBoot(APP_VERSION, store.get().settings.bootAnimation));
  useEffect(() => { if (bootAt) setBooting(true); }, [bootAt]);
  useCommandKeys();
  const reduced = useReducedMotion();
  const narrow = useMedia('(max-width: 1279px)');
  const showStatus = !VIEWS_WITHOUT_STATUS.has(view);
  // Docked at >=1280px the drawer flag has no meaning; clear it so it cannot pop open when the window narrows.
  useEffect(() => { if (!narrow || !showStatus) actions.toggleStatusDrawer(false); }, [narrow, showStatus]);

  useEffect(() => { document.documentElement.dataset.mode = mode; }, [mode]);
  // 原生标题栏与窗口底色跟着夜/昼走（深色标题栏配昼、浅色配夜会和界面打架）；没有桌面桥时是空调用。
  useEffect(() => { desktop?.app?.setTheme?.(mode); }, [mode]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.console = consoleOpen ? 'open' : 'closed';
    root.style.setProperty('--console-h', `${consoleHeight}px`);
  }, [consoleOpen, consoleHeight]);
  useEffect(() => { document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'; }, [reduced]);
  useEffect(() => { document.documentElement.dataset.peek = peek ? 'on' : 'off'; }, [peek]);
  useEffect(() => { document.documentElement.dataset.boot = booting ? 'on' : 'off'; if (!booting) noteAppShown(); }, [booting]);
  // 不播开屏时：主界面第一次提交之后告诉主进程可以显示窗口（要播开屏的话由 BootSplash 在开屏第 0 帧画好时说；这里只发一次，谁先到谁算）。
  // 开屏放弃了（素材 4 s 没就绪）、播完了也走到这里——早已发过，是空操作.
  useEffect(() => { if (!booting) afterFrame(reportFirstFrame); }, [booting]);

  // 仅开发：?fixture=demo 灌入示例状态，?probe=notext 隐去文字只留光晕（对比度度量用）。生产构建里没有这段。
  useEffect(() => {
    if (import.meta.env.DEV) void import('./components/decor/devFixture').then((m) => m.applyDevQuery());
  }, []);

  // The tab title names the current page.
  const pageTitle = view === 'task' && hasTask && taskTitle ? taskTitle : VIEW_TITLES[view === 'task' ? 'tasks' : view];
  useEffect(() => { document.title = `${pageTitle} · 栖枝`; }, [pageTitle]);

  // When the page changes and the element that had focus is gone (a list row, the composer's submit
  // button…), put focus on the new page's heading instead of letting it fall to <body>. Focus that is
  // still on a persistent control, such as the side nav, is left alone.
  const pageKey = `${view}:${view === 'task' && hasTask ? selectedTaskId : ''}`;
  const lastPageKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = lastPageKey.current;
    lastPageKey.current = pageKey;
    if (previous === undefined || previous === pageKey) return;
    if (focusIsLost()) focusMainHeading();
  }, [pageKey]);

  // 全局键（Ctrl+` 控制台、Alt+1…8 分区、Esc 关赏图/状态抽屉…）都在命令注册表里：src/lib/commands.ts 的 useCommandKeys。

  const content = (() => {
    switch (view) {
      case 'new': return <ReturnView />;
      case 'queue': return <QueueView />;
      case 'task': return hasTask ? <Workspace /> : <TaskListView />;
      case 'tasks': return <TaskListView />;
      case 'agents': return <AgentsView />;
      case 'tools': return <ToolsView />;
      case 'models': return <ModelsView />;
      case 'history': return <HistoryView />;
      case 'settings': return <SettingsView />;
    }
  })();

  return (
    <>
      <Sprite />
      <Wallpaper />
      <Ambience />
      <a className="skip-link" href="#main">跳到主要内容</a>
      <div
        className="app"
        inert={peek || undefined}
        data-view={view}
        data-status={showStatus ? 'on' : 'off'}
        data-nav={navCollapsed ? 'collapsed' : 'open'}
        data-console={consoleOpen ? 'open' : 'closed'}
        data-drawer={narrow ? (drawerOpen ? 'open' : 'closed') : 'docked'}
        style={{ ['--console-h' as string]: `${consoleHeight}px` }}
      >
        <SideNav />
        <main id="main" className="app__main" tabIndex={-1}>
          <div className="app__view" key={view}><ViewBoundary name={VIEW_TITLES[view === 'task' ? 'tasks' : view]}>{content}</ViewBoundary></div>
        </main>
        {narrow && showStatus && drawerOpen && <div className="app__drawer-scrim" onClick={() => actions.toggleStatusDrawer(false)} aria-hidden />}
        {showStatus && <StatusPanel />}
        <Console />
      </div>
      {peek && <PeekBar />}
      {booting && <BootSplash key={bootAt ?? 0} onDone={() => setBooting(false)} />}
      <ToastHost />
      <DialogHost />
      <TrustDialogHost />
      <LiveRegion />
      <ButterflyLanding />
    </>
  );
}
