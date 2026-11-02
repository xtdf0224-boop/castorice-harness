/* 窗口外壳与页面对齐（V0α · 模块 B4「交互」）：系统托盘、任务栏角标、系统通知，以及「看过了」「离开过」两个计时。
   「一份数据，三个出口」：左栏「待你 · N」、任务栏角标、系统通知都来自同一个 deriveQueue（queue.ts），数字必须相等。
   · 角标：页面用 canvas 画一个小圆角徽章（数字，>9 写「9+」，有等着亲自处理的事时是金色）转成 PNG，交给桌面端贴在任务栏图标上；
     队列为空或数据未就绪时清除，不显示 0。
   · 通知：只在窗口失焦时弹（桌面端也会再查一遍）；待批 / 待回复 / 计划待批 / 失败各有一句她的话；
     回合结束默认无声；一次攒下 3 条以上合并成一条摘要；刚启动时从存档里读出来的旧条目不弹。
   · 看过了：任务页开着、窗口在前台时，持续把这个任务的 lastSeenAt 推到现在——回合结束、失败的条目因此不会在你眼前冒出来。
   · 离开过：键盘鼠标 ≥ returnAfterMin 分钟没动、再动起来，就记一次离开，归来页据此写归来简（brief.ts）。
   · 她开口（proactive.ts）：库读完之后才启动 startProactive()——一次性 setTimeout，不轮询，窗口隐藏时不排。 */
import { desktop, type DesktopCommand } from '../lib/desktop';
import { speak } from '../lib/persona';
import { petRealtime } from '../pet/brain';
import type { AppState, QueueItem, Task } from '../lib/types';
import { actions } from './actions';
import { awayWindow, detectAway } from './brief';
import { persistMode, whenReady } from './persist';
import { startProactive } from './proactive';
import { badgeSpec, queueReady, type BadgeSpec } from './queue';
import { selectQueue } from './selectors';
import { store } from './store';

/* ───────────── 命令（托盘菜单、点通知） ───────────── */

/** 桌宠右键菜单：让她看某个程序（当作游戏）或只聊天. 和设置页的名单是同一份——更严的名单优先，所以互相挪出来. */
export function petWatch(exe: string, allow: boolean) {
  const name = exe.trim().toLowerCase();
  if (!name) return;
  const p = store.get().settings.pet;
  const without = (list: string[]) => list.filter((x) => x !== name);
  const added = (list: string[]) => (list.includes(name) ? list : [...list, name]);
  if (!allow) { actions.setPet({ gameDeny: added(p.gameDeny), gameAllow: without(p.gameAllow) }); return; }
  // 「当作游戏」是用户明说的事：它在「永远不看」里（那边优先）就先从那里移出来，再加进「游戏，可以看」，并说一声（理由文案同设置页的名单）.
  const wasNever = p.neverWatch.includes(name);
  actions.setPet({ gameAllow: added(p.gameAllow), gameDeny: without(p.gameDeny), neverWatch: without(p.neverWatch) });
  if (wasNever) actions.toast({ tone: 'info', title: `${name} 已从「永远不看」里移出`, body: '那边的优先级更高，所以先把它移出来，再加进「游戏，可以看」。想改回去，到设置 › 桌宠 › 名单里。' });
}

/** 滚到设置页的「桌宠」一节并把键盘焦点放在它的标题上（托盘的「桌宠设置…」）. 设置页可能还没挂上，所以等几帧. */
export function focusPetSettings() {
  let tries = 0;
  const go = () => {
    const panel = typeof document !== 'undefined' ? document.getElementById('settings-pet') : null;
    if (!panel) { if (typeof requestAnimationFrame === 'function' && ++tries < 30) requestAnimationFrame(go); return; }
    const calm = document.documentElement.dataset.motion === 'reduced' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    const heading = panel.querySelector<HTMLElement>('h2');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  };
  go();
}

function run(cmd: DesktopCommand) {
  switch (cmd.type) {
    case 'new': actions.navigate('new'); actions.requestFocus('composer'); return;
    case 'close-to-tray': actions.setSetting('closeToTray', !!cmd.value); return;
    case 'approvals': actions.navigate('queue'); return;
    case 'open-task': if (store.get().tasks[cmd.taskId]) actions.openTask(cmd.taskId); return;
    case 'pet-toggle': actions.setPet({ enabled: !store.get().settings.pet.enabled }); return;
    case 'pet-settings': actions.navigate('settings'); focusPetSettings(); return;
    case 'pet-realtime': petRealtime(cmd.on); return;
    case 'pet-watch': petWatch(cmd.exe, cmd.allow); return;
    default: return;
  }
}

/* ───────────── 任务栏角标 ───────────── */

/** 在 32×32 的画布上画一个圆角徽章：数字居中，金色（等着亲自处理）或淡紫. */
export function drawBadge(spec: BadgeSpec): string | undefined {
  try {
    if (typeof document === 'undefined' || !spec.count) return undefined;
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const g = c.getContext('2d');
    if (!g) return undefined;
    const fill = spec.tone === 'gold' ? '#e6c88a' : '#c6aed3';
    const ink = spec.tone === 'gold' ? '#241a06' : '#1f1030';
    g.clearRect(0, 0, 32, 32);
    g.beginPath();
    g.roundRect(1, 1, 30, 30, 11);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(14,12,26,0.92)';
    g.stroke();
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${spec.text.length > 1 ? 16 : 21}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
    g.fillText(spec.text, 16, 17);
    return c.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/* ───────────── 通知 ───────────── */

const NOTIFY_KINDS: ReadonlySet<QueueItem['kind']> = new Set(['approval', 'question', 'plan', 'failed']);
const NEW_WITHIN_MS = 2 * 60_000;
const MERGE_AT = 3;
const MERGE_WAIT_MS = 1500;

const windowInFront = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

/** 通知正文：待批写那一步做什么，失败写哪个任务；其余只一句. 不放整段原因，也不在通知里直接批准. */
function noteFor(it: QueueItem): { title: string; body: string; command: DesktopCommand } {
  const task = store.get().tasks[it.taskId]?.title ?? '';
  const scene = it.kind === 'approval' ? 'notify.approval' : it.kind === 'question' ? 'notify.question' : it.kind === 'plan' ? 'notify.plan' : 'notify.failed';
  const command: DesktopCommand = it.kind === 'failed' ? { type: 'open-task', taskId: it.taskId } : { type: 'approvals' };
  return { title: '栖枝', body: speak(scene, { title: it.kind === 'approval' ? it.title : task }), command };
}

/* ───────────── 看过了 ───────────── */

/** 任务里「会让队列出新条目」的最晚时刻：最新运行的结束、最后一条消息、任务更新. */
function latestEventAt(s: AppState, t: Task): number {
  const run = t.runIds.length ? s.runs[t.runIds[t.runIds.length - 1]] : undefined;
  const last = t.messages.length ? t.messages[t.messages.length - 1].at : 0;
  return Math.max(run?.endedAt ?? 0, last, t.updatedAt ?? 0);
}

function syncSeen(s: AppState) {
  if (s.view !== 'task' || !s.selectedTaskId || !windowInFront()) return;
  const t = s.tasks[s.selectedTaskId];
  if (!t) return;
  if ((t.lastSeenAt ?? 0) >= latestEventAt(s, t)) return;
  actions.markSeen(t.id, Date.now());
}

/* ───────────── 起点 ───────────── */

export function startShellSync() {
  const shell = desktop?.app;


  let closeToTray = store.get().settings.closeToTray;
  shell?.setPrefs({ closeToTray });

  // 启动时已经在队列里的条目不算「新」，也不弹.
  let known = new Set(queueReady(store.get()) ? selectQueue(store.get()).map((i) => i.key) : []);
  let lastView = store.get().view;
  let lastSeenAt = store.get().lastSeen;
  const noteAway = (leftAt: number | undefined) => {
    if (leftAt === undefined) return;
    const w = detectAway(leftAt, Date.now(), store.get().settings.returnAfterMin);
    if (w) awayWindow.set(w);
  };
  noteAway(lastSeenAt);   // 冷启动：上一次会话最后一次操作离现在够久
  let lastBadge = '';
  let pending: QueueItem[] = [];
  let mergeTimer: number | undefined;

  const flush = () => {
    mergeTimer = undefined;
    const batch = pending;
    pending = [];
    if (!shell || !batch.length) return;
    if (batch.length >= MERGE_AT) {
      shell.notify({ title: '栖枝', body: speak('notify.many', { count: batch.length }), command: { type: 'approvals' } });
    } else {
      for (const it of batch) shell.notify(noteFor(it));
    }
  };

  const onChange = () => {
    const s = store.get();
    if (s.settings.closeToTray !== closeToTray) {
      closeToTray = s.settings.closeToTray;
      shell?.setPrefs({ closeToTray });
    }
    // 回来了：lastSeen 是 presence 记下的离开时刻.
    if (s.lastSeen !== lastSeenAt) { lastSeenAt = s.lastSeen; noteAway(lastSeenAt); }
    // 离开首页之后，这封信不再回来.
    if (lastView === 'new' && s.view !== 'new') awayWindow.clear();
    lastView = s.view;

    const ready = queueReady(s) && persistMode().ready;
    const items = ready ? selectQueue(s) : [];

    // 角标（数字与左栏同源）.
    if (shell?.setBadge) {
      const spec = ready ? badgeSpec(items) : badgeSpec([]);
      const key = `${spec.count}|${spec.tone}|${spec.label}`;
      if (key !== lastBadge) {
        lastBadge = key;
        shell.setBadge({ count: spec.count, png: spec.count ? drawBadge(spec) : undefined, label: spec.label });
      }
    }

    // 新出现的条目：窗口不在前台时，按类别发一句话.
    const now = Date.now();
    const fresh = items.filter((i) => !known.has(i.key));
    known = new Set(items.map((i) => i.key));
    if (shell && fresh.length && !windowInFront()) {
      const worth = fresh.filter((i) => NOTIFY_KINDS.has(i.kind) && now - i.since < NEW_WITHIN_MS);
      if (worth.length) {
        pending.push(...worth);
        if (mergeTimer === undefined) mergeTimer = window.setTimeout(flush, MERGE_WAIT_MS);
      }
    }

    syncSeen(s);
  };

  store.subscribe(onChange);
  // 读库结束时 persist.ts 不一定再提交一次状态：等它就绪后补算一遍（角标与「—」）.
  void whenReady(60_000).then(onChange);
  // 主动搭话、每日问候、休息关照（施工图 §3.6b）：库读完之后才启动——这里比 main.tsx 里的渲染先跑，那时候还没有任务可说话
  void whenReady(60_000).then(() => { startProactive(); });
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => syncSeen(store.get()));
    document.addEventListener('visibilitychange', () => syncSeen(store.get()));
  }
  onChange();
  shell?.onCommand(run);
}
