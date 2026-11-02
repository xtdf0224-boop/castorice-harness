/* Everything a component can do. Each run control goes through `backend` and then gives visible
   feedback (toast + screen-reader announcement), whether it succeeded or not. */
import { speak } from '../lib/persona';
import { say2, voiceNow } from '../lib/voice';
import { effectiveTier, legacyToolsOf, tightenTier } from '../lib/tiers';
import type {
  AgentEngine, AgentId, ConsoleTab, Dialog, Distance, Level, PermissionMode, PetSettings, Settings, Task, TaskEngine, TaskKind, ToolId, ToolPermission, Toast, TrustLevel, UiCommand, ViewId, WorkspaceTab,
} from '../lib/types';
import { VIEWS_WITHOUT_STATUS } from '../lib/status';
import { backend } from './backend';
import { announce, dropToasts, pushEvent, toast as pushToast } from './engine';
import { forgetTask, reply } from './live';
import { pickPet } from './persist';
import { syncPersonaAgent } from './seed';
import { store, uid } from './store';
import { noteAccepted, noteAnswered, noteDismiss } from './voiceGate';

type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number };

/** 桌宠设置的一次改动：voice 和 realtime 可以只带要改的字段（voice.models 同理），别的键整个替换（所以 { vision: undefined } 是清掉模型选择）. */
export type PetPatch = Partial<Omit<PetSettings, 'voice' | 'realtime'>> & {
  voice?: Partial<Omit<PetSettings['voice'], 'models' | 'voiceIds'>> & { models?: Partial<PetSettings['voice']['models']>; voiceIds?: Partial<PetSettings['voice']['voiceIds']> };
  realtime?: Partial<PetSettings['realtime']>;
};

function feedback(t: ToastInput, spoken?: string) {
  store.update((d) => {
    pushToast(d, t);
    announce(d, spoken ?? `${t.title}${t.body ? `：${t.body}` : ''}`);
  });
}

const NO_MODEL: ToastInput = {
  tone: 'warning', title: '还没有选择模型', body: '先到「模型接入」连接一个模型，再回来给任务选上它。',
  action: { label: '去模型接入', command: { type: 'navigate', view: 'models' } },
};

/** 旧 distance 垫片的派生规则（D17）：回滚到 0.1.4 后话量「少」并入「中」. */
const derivedDistance = (persona: boolean, level: Level): Distance => (persona === false ? 0 : level === 'l' ? 2 : 1);

/** 记得小事的上限（§2.2）：≤20 条 × ≤80 字. */
export const MEMORY_MAX_ITEMS = 20;
export const MEMORY_MAX_CHARS = 80;
const clock = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const runOf = (runId: string) => store.get().runs[runId];
const orchestratorName = () => store.get().agents.find((a) => a.id === 'orchestrator')?.name ?? '编排 Agent';
const taskOfRun = (runId: string) => store.get().tasks[runOf(runId)?.taskId ?? ''];
/** The status panel is a drawer below 1280px; docked above, where "open" has no meaning. */
const drawerMode = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1279px)').matches;

export const actions = {
  /* ── navigation ── */
  navigate(view: ViewId) {
    store.update((d) => { d.view = view; d.statusDrawerOpen = false; });
  },
  openTask(taskId: string, runId?: string, tab?: WorkspaceTab) {
    store.update((d) => {
      if (!d.tasks[taskId]) return;
      // 打开任务页＝看过了：「回合结束待查看」「失败」从待你里退场（queue.ts）.
      d.tasks[taskId].lastSeenAt = Math.max(d.tasks[taskId].lastSeenAt ?? 0, Date.now());
      d.view = 'task';
      d.selectedTaskId = taskId;
      d.selectedRunId = runId;
      d.statusDrawerOpen = false;
      if (tab) d.workspaceTab = tab;
    });
  },
  selectRun(runId: string) {
    store.update((d) => { d.selectedRunId = runId; });
  },
  setWorkspaceTab(tab: WorkspaceTab) {
    store.update((d) => { d.workspaceTab = tab; });
  },
  toggleNav() {
    store.update((d) => { d.navCollapsed = !d.navCollapsed; });
  },
  /** Replay the 开机动画 (Settings › 外观 › 预览). */
  playBoot() {
    store.update((d) => { d.bootAt = Date.now(); d.peek = false; });
  },
  togglePeek(on?: boolean) {
    store.update((d) => {
      d.peek = d.settings.wallpaper ? (on ?? !d.peek) : false;
      if (d.peek) d.statusDrawerOpen = false;
    });
  },
  toggleStatusDrawer(open?: boolean) {
    store.update((d) => { d.statusDrawerOpen = open ?? !d.statusDrawerOpen; });
  },
  requestFocus(target: 'approvals' | 'composer' | 'console' | 'plan') {
    store.update((d) => {
      d.focusRequest = { target, at: Date.now() };
      // 没有右栏的页面里没有抽屉可开（开了标志位只会白白吞掉一次 Esc）
      if (target === 'approvals' && drawerMode() && !VIEWS_WITHOUT_STATUS.has(d.view)) d.statusDrawerOpen = true;
      if (target === 'console') d.console.open = true;
    });
  },

  /* ── tasks ── */
  /** 任务页开着、窗口在前台时，shell.ts 会持续调用它；只往前走，不倒退. */
  markSeen(taskId: string, at = Date.now()) {
    const t = store.get().tasks[taskId];
    if (!t || (t.lastSeenAt ?? 0) >= at) return;
    store.update((d) => { const x = d.tasks[taskId]; if (x) x.lastSeenAt = Math.max(x.lastSeenAt ?? 0, at); });
  },
  /** 输入框里的权限模式（K32）：逐项 / 接受编辑 / 计划 / 自动 / 放手. 下一次运行起生效. */
  setTaskPermissionMode(taskId: string, mode: PermissionMode) {
    store.update((d) => { const e = d.tasks[taskId]?.engine; if (e) e.permissionMode = mode; });
  },
  /** 她站多近：0 纯事实（同时等于关掉人设）/ 1 正式 / 2 近一些. */
  setDistance(distance: Distance) {
    if (store.get().settings.distance === distance && store.get().settings.persona === (distance > 0)) return;
    store.update((d) => { d.settings.distance = distance; d.settings.persona = distance > 0; d.settings.level = distance === 2 ? 'l' : 'm'; syncPersonaAgent(d); });
    // 回话用新的距离说：「好的……我站近一些。」
    feedback({ tone: 'neutral', title: speak('distance.set'), ttl: 2800 });
  },
  /** 话量：少 / 中 / 多（取代 setDistance）. 本版同时派生旧 distance 垫片（D17）：distance = persona===false ? 0 : level==='l' ? 2 : 1. */
  setLevel(level: Level) {
    if (store.get().settings.level === level) return;
    store.update((d) => { d.settings.level = level; d.settings.distance = derivedDistance(d.settings.persona, level); });
    feedback({ tone: 'neutral', title: speak('distance.set'), ttl: 2800 });
  },
  /** 角色口吻（D6）：关 = 纯事实，不改话量. 同样派生 distance 垫片并同步编排 Agent 的名字与字块. */
  setPersona(on: boolean) {
    if (store.get().settings.persona === on) return;
    store.update((d) => { d.settings.persona = on; d.settings.distance = derivedDistance(on, d.settings.level); syncPersonaAgent(d); });
    feedback({ tone: 'neutral', title: speak('distance.set'), ttl: 2800 });
  },
  /** 她主动说话（D7）. 本版派生旧 lifeNudge 垫片：lifeNudge = proactive === 'on'（与 persist.migrateSettings 的 lifeNudge===true → 'on' 对称）.
   *  auto（只在话量「多」时开口）和 off 都写 false：0.1.4 的 lifeNudge 不看话量、界面里也没有开关，写 true 会让回滚后凭空开始调模型搭话. */
  setProactive(proactive: Settings['proactive']) {
    if (store.get().settings.proactive === proactive) return;
    store.update((d) => { d.settings.proactive = proactive; d.settings.lifeNudge = proactive === 'on'; });
  },
  /** 安静一小时（§3.9）：minutes>0 写 quietUntil，0 解除. 安静期间她只说最短中性句，rest/late 降成一行系统行（voiceGate G1），事实类通知照常.
   *  命令 voice.quiet 与右栏按钮都走这里；运行中的 proactive 定时器会随 quietUntil 的变化自行重排. */
  quietFor(minutes: number) {
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    store.update((d) => { d.quietUntil = until; });
    feedback({ tone: 'neutral', title: until ? '安静一小时' : '已解除安静', body: until ? `到 ${clock(until)} 之前，她只说最短的话。` : undefined, ttl: 2800 });
  },
  /** 折叠她的话（该任务）：折叠态每条她的话显示为一行摘要，点开展开；内容卡不受影响. */
  toggleFold(taskId: string) {
    const t0 = store.get().tasks[taskId];
    const folding = !!t0 && !t0.foldHer;
    store.update((d) => { const t = d.tasks[taskId]; if (t) t.foldHer = !t.foldHer; });
    // 折叠她的主动话 = 一次「关闭」（I-22：3 秒内连关两次 → 本会话降一档）；只在真有主动话可折时记，展开不记
    if (folding && t0.messages.some((m) => m.proactive && m.role === 'agent')) noteDismiss('her', 'x', Date.now());
  },
  /** 未竟之信「放下」：写 laidDownAt（只写一次），待你里不再出现它（queue.ts），与它有关的 toast 一并收掉. */
  layDown(runId: string) {
    if (!store.get().runs[runId] || store.get().runs[runId].laidDownAt) return;
    store.update((d) => {
      const r = d.runs[runId];
      if (!r || r.laidDownAt) return;
      r.laidDownAt = Date.now();
      dropToasts(d, `run:${runId}`);
    });
  },
  /** 记得小事（§3.9，邀请制）：memoryOn 关时不存；≤20 条 × ≤80 字（按字符数，空白折成一个空格）；同一范围内相同的话不重复存；
   *  taskId 缺省 = 所有对话可见. 只收用户自己确认过的文字——调用方（消息操作里的输入框）负责让用户亲手确认. */
  addMemory(text: string, taskId?: string): { ok: true; id: string } | { ok: false; error: string } {
    const s = store.get();
    const t = text.replace(/\s+/g, ' ').trim();
    if (!s.settings.memoryOn) return { ok: false, error: '「记得小事」还没有打开' };
    if (!t) return { ok: false, error: '内容是空的' };
    if (Array.from(t).length > MEMORY_MAX_CHARS) return { ok: false, error: `一条最多 ${MEMORY_MAX_CHARS} 字` };
    const same = s.memory.find((m) => m.text === t && m.taskId === taskId);
    if (same) return { ok: true, id: same.id };
    if (s.memory.length >= MEMORY_MAX_ITEMS) return { ok: false, error: `最多记 ${MEMORY_MAX_ITEMS} 条，请先删掉一些` };
    const id = uid('mem');
    store.update((d) => { d.memory.push({ id, text: t, at: Date.now(), taskId }); });
    return { ok: true, id };
  },
  /** 改一条记得的小事（同样的长度与重复检查）. */
  editMemory(id: string, text: string): { ok: true } | { ok: false; error: string } {
    const s = store.get();
    const item = s.memory.find((m) => m.id === id);
    if (!item) return { ok: false, error: '这一条已经不在了' };
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, error: '内容是空的' };
    if (Array.from(t).length > MEMORY_MAX_CHARS) return { ok: false, error: `一条最多 ${MEMORY_MAX_CHARS} 字` };
    if (s.memory.some((m) => m.id !== id && m.text === t && m.taskId === item.taskId)) return { ok: false, error: '已经有同样的一条了' };
    store.update((d) => { const m = d.memory.find((x) => x.id === id); if (m) m.text = t; });
    return { ok: true };
  },
  /** 删一条记得的小事. */
  removeMemory(id: string) {
    store.update((d) => { d.memory = d.memory.filter((m) => m.id !== id); });
  },
  /** 撤销「让她换个说法」（C1 的请求，集成者并入）：只有一份实现，在 E 的 live.undoRewriteHer（换回 prevText，再撤一次又换回来，check-engine 对表）；这里只是 backend 的薄包装. */
  undoRewrite(taskId: string, msgId: string) {
    const r = backend.undoRewrite(taskId, msgId);
    if (!r.ok) feedback({ tone: 'warning', title: '没有可以换回去的原文', body: r.error });
  },
  /** 选项胶囊的退出项（C1 的请求，集成者并入）：只出一条 leave.c 模板短回（零 token、不追问）并 noteDismiss(scene,'later')（§4.4、I-22）. persona 关时 leave.c 标 false → silent，不出气泡. */
  exitPill(taskId: string, scene?: string) {
    const v = voiceNow();
    const r = say2('leave.c', {}, { level: v.level, mode: 'chat', theme: v.theme, persona: v.persona, callName: v.callName, seed: `${taskId}:${Date.now()}` });
    if (r.text && !r.silent) {
      store.update((d) => {
        const t = d.tasks[taskId];
        if (!t) return;
        const at = Date.now();
        t.messages.push({
          id: uid('msg'), role: 'agent', agentId: 'orchestrator', kind: 'note', text: r.text, at,
          persona: d.settings.persona ? d.settings.mode : undefined, expr: r.expr ?? 'gentle', src: r.src,
        });
        t.updatedAt = at;
      });
    }
    noteDismiss(scene ?? 'leave.c', 'later', Date.now());
  },
  /** 一键清空记得的小事（设置页「清空」）. 关掉 memoryOn 不会清，数据保留. */
  clearMemory() {
    if (!store.get().memory.length) return;
    store.update((d) => { d.memory = []; });
  },
  /** 记得小事开关：关 = 不存不读不注入，数据保留. */
  setMemoryOn(on: boolean) {
    if (store.get().settings.memoryOn === on) return;
    store.update((d) => { d.settings.memoryOn = on; });
  },
  /** 她退半步（视觉收起那一层）开关；关了也不影响「卡内无头像无贴纸」的硬规则. */
  setStepBack(on: boolean) {
    if (store.get().settings.stepBack === on) return;
    store.update((d) => { d.settings.stepBack = on; });
  },
  /** 剧情框：off / 闲聊最新一句 / 含计划引言与总结. */
  setStoryBox(mode: Settings['storyBox']) {
    if (store.get().settings.storyBox === mode) return;
    store.update((d) => { d.settings.storyBox = mode; });
  },
  /** 贴纸开关：关了就不出贴纸（含模型建议的）. */
  setStickers(on: boolean) {
    if (store.get().settings.stickers === on) return;
    store.update((d) => { d.settings.stickers = on; });
  },
  /** 「让她自己想话题」：true 才用模型想主动搭话的话题；默认话题来自台词库 nudge.* 模板. */
  setProactiveTopics(on: boolean) {
    if (store.get().settings.proactiveTopics === on) return;
    store.update((d) => { d.settings.proactiveTopics = on; });
  },
  /** 每日问候（模板，零 token）开关. */
  setLifeGreeting(on: boolean) {
    if (store.get().settings.lifeGreeting === on) return;
    store.update((d) => { d.settings.lifeGreeting = on; });
  },
  /** 休息关照胶囊里「去歇一会儿」一类被点了：「被忽略」计数清零（G9-⑤）. */
  acceptRest() { noteAccepted(Date.now()); },
  /** 「今天别再提醒」（休息关照的退出胶囊、toast 上的按钮）：当晚 / 当天不再提（G9-④）. */
  muteRest() {
    noteDismiss('nudge.rest', 'enough', Date.now());
    feedback({ tone: 'neutral', title: '好，今天不再提醒', ttl: 2400 });
  },
  /** 她的话旁的小按钮（MessageActions）：x = 关闭 / 折叠；skip = 这句不用说（该场景当日不再）；enough = 今天别再说（休息关照则是今天别再提醒）；
   *  noreply = 不必回（只清掉「上一次主动没得到回应」，不降档）. 一律经 voiceGate 记账（G8 / I-22）. */
  dismissHer(taskId: string, msgId: string, how: 'x' | 'skip' | 'enough' | 'noreply') {
    const m = store.get().tasks[taskId]?.messages.find((x) => x.id === msgId);
    const now = Date.now();
    if (how === 'noreply') return noteAnswered(taskId, now);
    noteDismiss(m?.src?.scene ?? (m?.proactive ? 'nudge' : 'her'), how, now);
  },
  createTask(input: { title: string; goal: string; kind?: TaskKind; engine?: TaskEngine; agentIds: AgentId[]; start: boolean; skills?: string[]; trust?: TrustLevel }): string {
    const id = uid('task');
    const now = Date.now();
    const kind = input.kind ?? 'work';
    store.update((d) => {
      const first = input.goal.trim();
      const task: Task = {
        id, title: input.title.trim() || (kind === 'chat' ? '闲聊' : '未命名任务'), goal: first, createdAt: now, updatedAt: now,
        agentIds: input.agentIds.length ? input.agentIds : ['orchestrator'], runIds: [],
        messages: first ? [{ id: uid('msg'), role: 'user', text: first, at: now }] : [],
        kind, engine: input.engine, skills: input.skills, trust: input.trust, lastSeenAt: now,
      };
      d.tasks[id] = task;
      d.taskOrder.unshift(id);
      d.view = 'task';
      d.selectedTaskId = id;
      d.selectedRunId = undefined;
      d.workspaceTab = 'conversation';
      pushEvent(d, { kind: 'user', level: 'info', text: `${kind === 'chat' ? '新建闲聊' : '新建任务'}：${task.title}` });
    });
    // The composer is disabled until a model is ready; this only catches a task whose model went away.
    if (!input.engine) { feedback(NO_MODEL); return id; }
    if (kind === 'chat') {
      if (input.goal.trim()) void reply(id);
      return id;
    }
    if (input.start) {
      const r = backend.startRun(id);
      if (r.ok) feedback({ tone: 'running', title: '任务已创建并开始运行', body: `${input.engine.label} 正在制定计划。` });
      else feedback({ tone: 'warning', title: '任务已创建，但还没开始', body: r.error });
    } else {
      feedback({ tone: 'info', title: '任务已创建', body: '准备好后点「开始」。' });
    }
    return id;
  },
  /** Switch the model a task uses; the next reply starts a fresh conversation with it. */
  setTaskEngine(taskId: string, engine: TaskEngine) {
    store.update((d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      const sameModel = t.engine && engine.provider === t.engine.provider && engine.auth === t.engine.auth && engine.driver === t.engine.driver && engine.model === t.engine.model;
      t.engine = engine;
      if (!sameModel) t.session = undefined;
      t.messages.push({ id: uid('msg'), role: 'system', text: `已切换到 ${engine.label}。`, at: Date.now() });
    });
  },
  requestDeleteTask(taskId: string) {
    store.update((d) => { d.dialog = { kind: 'delete-task', taskId }; });
  },
  deleteTask(taskId: string) {
    const task = store.get().tasks[taskId];
    if (!task) return;
    // Stop the real agent first: it must not keep editing the folder of a task that no longer exists.
    forgetTask(taskId);
    store.update((d) => {
      const gone = new Set(task.runIds);
      // Toasts about this task (approval, failure, completion) would be left with dead actions.
      for (const runId of task.runIds) {
        dropToasts(d, `run:${runId}`);
        for (const a of d.runs[runId]?.approvals ?? []) dropToasts(d, `approval:${a.id}`);
      }
      d.toasts = d.toasts.filter((t) => {
        const c = t.action?.command;
        if (!c) return true;
        if ('taskId' in c && c.taskId === taskId) return false;
        if ('runId' in c && c.runId && gone.has(c.runId)) return false;
        return true;
      });
      for (const runId of task.runIds) delete d.runs[runId];
      d.events = d.events.filter((e) => !e.runId || !gone.has(e.runId));
      delete d.tasks[taskId];
      d.taskOrder = d.taskOrder.filter((id) => id !== taskId);
      if (d.selectedTaskId === taskId) { d.selectedTaskId = undefined; d.selectedRunId = undefined; if (d.view === 'task') d.view = 'tasks'; }
    });
    feedback({ tone: 'neutral', title: '任务已删除', body: `「${task.title}」及其运行记录已移除。` });
  },

  /* ── run control ── */
  startRun(taskId: string) {
    const r = backend.startRun(taskId);
    if (r.ok) {
      store.update((d) => { d.selectedRunId = undefined; });
      feedback({ tone: 'running', title: '开始运行', body: `${orchestratorName()} 正在制定计划。` });
    } else feedback({ tone: 'danger', title: '无法开始', body: r.error });
  },
  pauseRun(runId: string) {
    const r = backend.pauseRun(runId);
    if (r.ok) feedback({ tone: 'paused', title: '已暂停', body: '当前调用已中断，点「继续」会重新执行这一步。' });
    else feedback({ tone: 'warning', title: '无法暂停', body: r.error });
  },
  resumeRun(runId: string) {
    const r = backend.resumeRun(runId);
    if (r.ok) feedback({ tone: 'running', title: '已继续', body: runOf(runId)?.status === 'awaiting' ? '还有待确认的操作，处理后才会往下执行。' : '从暂停处继续执行。' });
    else feedback({ tone: 'danger', title: '无法继续', body: r.error });
  },
  requestCancel(runId: string) {
    if (store.get().settings.confirmBeforeCancel) store.update((d) => { d.dialog = { kind: 'cancel-run', runId }; });
    else actions.cancelRun(runId);
  },
  cancelRun(runId: string) {
    const r = backend.cancelRun(runId);
    if (r.ok) feedback({ tone: 'neutral', title: '已取消运行', body: '未完成的步骤已停止，已生成的产物仍然保留。' });
    else feedback({ tone: 'warning', title: '无法取消', body: r.error });
  },
  retryRun(runId: string, mode: 'resume' | 'restart' = 'resume') {
    const prev = runOf(runId);
    const r = backend.retryRun(runId, mode);
    if (r.ok) {
      store.update((d) => { d.selectedRunId = undefined; if (prev) { d.view = 'task'; d.selectedTaskId = prev.taskId; } });
      // Describe the run that was actually created, not the one it replaces.
      const next = runOf(r.value);
      const cancelled = prev?.status === 'cancelled';
      const carried = next ? next.plan.filter((st) => st.carried).length : 0;
      if (mode === 'restart') {
        feedback({ tone: 'running', title: '已从头重新运行', body: '所有步骤会重新执行。' });
      } else if (!next?.planReady) {
        feedback({ tone: 'running', title: cancelled ? '已继续运行' : '已开始重试', body: '上次在计划完成前结束，会重新制定计划。' });
      } else {
        const at = next.plan.find((st) => !st.carried && st.status !== 'done');
        feedback({ tone: 'running', title: cancelled ? '已继续未完成的步骤' : '已开始重试',
          body: at
            ? `从第 ${at.index + 1} 步「${at.title}」继续${carried > 0 ? `，前 ${carried} 步沿用上次结果` : ''}。`
            : '前面的步骤都已完成，直接汇总。' });
      }
    } else feedback({ tone: 'danger', title: '无法重试', body: r.error });
  },
  decideApproval(approvalId: string, decision: 'approve' | 'reject') {
    const r = backend.decideApproval(approvalId, decision);
    if (!r.ok) return feedback({ tone: 'warning', title: '无法处理', body: r.error });
    if (decision === 'approve') feedback({ tone: 'success', title: '已批准', body: 'Agent 会执行这项操作。', ttl: 3000 });
    else feedback({ tone: 'neutral', title: '已拒绝', body: '这项操作不会执行，Agent 会换一种做法或向你说明。', ttl: 3500 });
  },
  sendMessage(taskId: string, text: string) {
    const r = backend.sendMessage(taskId, text.trim());
    if (!r.ok) feedback({ tone: 'danger', title: '发送失败', body: r.error });
  },

  /* ── agents and tools ── */
  setToolPermission(toolId: ToolId, permission: ToolPermission) {
    store.update((d) => {
      const tool = d.tools.find((t) => t.id === toolId);
      if (tool) tool.permission = permission;
    });
    const tool = store.get().tools.find((t) => t.id === toolId);
    feedback({ tone: 'info', title: '工具策略已更新', body: `「${tool?.name}」：${permission === 'auto' ? '自动执行' : permission === 'confirm' ? '需要确认' : '已禁用'}，从下一步开始。` });
  },
  setAgentEnabled(agentId: AgentId, enabled: boolean) {
    if (agentId === 'orchestrator' && !enabled) return feedback({ tone: 'warning', title: '编排 Agent 不能停用', body: '它负责拆解目标和分派步骤。' });
    store.update((d) => { const a = d.agents.find((x) => x.id === agentId); if (a) a.enabled = enabled; });
    const agent = store.get().agents.find((a) => a.id === agentId);
    feedback({ tone: 'info', title: enabled ? 'Agent 已启用' : 'Agent 已停用', body: enabled ? `新任务可以选择「${agent?.name}」。` : `新任务中它的步骤会交给编排 Agent。` });
  },
  /** Give an agent its own model, or (undefined) let it follow the task's. The 编排 Agent always follows the task. */
  setAgentEngine(agentId: AgentId, engine: AgentEngine | undefined) {
    if (agentId === 'orchestrator') return feedback({ tone: 'info', title: '编排 Agent 用任务的模型', body: '它负责拆解和汇总，跟着任务选的模型走。' });
    store.update((d) => { const a = d.agents.find((x) => x.id === agentId); if (a) a.engine = engine; });
  },
  /** Tools an agent may use when its steps run on a command-line agent. */
  setAgentTools(agentId: AgentId, tools: ToolId[]) {
    store.update((d) => {
      const a = d.agents.find((x) => x.id === agentId);
      if (a) a.tools = d.tools.map((t) => t.id).filter((id) => tools.includes(id));
    });
  },
  /** 把某 Agent 的某工具收紧到 tier（confirm / off），或 undefined = 沿用全局. 只能收紧、不能放宽；编排 Agent 与 'other' 拒绝（§2.1.1）.
   *  本版同时双写旧 tools 清单（legacyToolsOf，D17）.
   *  时机：白档工具在步骤启动时就写进了 allow（live.policySpec），Claude Code 对 allow 里的工具不再回头问，所以改档从「下一步」起才算数.
   *  成功后给一条反馈把这句说清；该 Agent 正好有一步在跑、且这个工具原本是白档时，另说一句「这一步里仍会用」. */
  setAgentTier(agentId: AgentId, toolId: ToolId, tier: ToolPermission | undefined) {
    const s = store.get();
    const agent = s.agents.find((x) => x.id === agentId);
    if (!agent) return;
    const next = tightenTier(agent, toolId, tier, s.tools);
    if (next === 'refused') {
      return feedback(agentId === 'orchestrator'
        ? { tone: 'info', title: '编排 Agent 沿用全局设置', body: '它的工具档在「工具」页统一调整，这里只能收紧其他 Agent。' }
        : { tone: 'info', title: '这个工具不能单独设置', body: '其他工具按全局策略处理。' });
    }
    const before = effectiveTier(agent, toolId, s.tools);
    store.update((d) => {
      const a = d.agents.find((x) => x.id === agentId);
      if (!a) return;
      if (Object.keys(next).length) a.tiers = next; else delete a.tiers;
      a.tools = legacyToolsOf(a);
    });
    const after = effectiveTier({ ...agent, tiers: Object.keys(next).length ? next : undefined }, toolId, s.tools);
    if (after === before) return;
    const toolName = s.tools.find((t) => t.id === toolId)?.name ?? '这个工具';
    const inStep = before === 'auto' && Object.values(s.runs).some((r) => r.status === 'running' && r.plan.some((st) => st.status === 'running' && (st.ranAs ?? st.agentId) === agentId));
    feedback({
      tone: 'info', title: `「${agent.name}」的工具档已更新`,
      body: `「${toolName}」${after === 'off' ? '已对它关上' : after === 'confirm' ? '改为需要确认' : '改为自动执行'}，从下一步开始。${inStep ? '正在运行的这一步里，原本是白档的工具会照旧用到这一步结束。' : ''}`,
    });
  },

  /* ── settings ── */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    store.update((d) => {
      d.settings[key] = value;
      if (key === 'mode' || key === 'persona') syncPersonaAgent(d);
    });
  },
  /** 改桌宠设置（docs/PET-PLAN.md §3）. 合并之后整份过 pickPet——和读存档时同一套校验，坏值进不了 store；没有任何变化就不动 store（大脑不会白白重发配置）. */
  setPet(patch: PetPatch) {
    store.update((d) => {
      const cur = d.settings.pet;
      const { voice, realtime, ...rest } = patch;
      const next = pickPet({
        ...cur, ...rest,
        voice: { ...cur.voice, ...voice, models: { ...cur.voice.models, ...voice?.models }, voiceIds: { ...cur.voice.voiceIds, ...voice?.voiceIds } },
        realtime: { ...cur.realtime, ...realtime },
      });
      if (JSON.stringify(next) !== JSON.stringify(cur)) d.settings.pet = next;
    });
  },
  /** Delete every task, run and event; settings, model access, agents and tool policies stay. */
  clearHistory() {
    const count = store.get().taskOrder.length;
    for (const id of Object.keys(store.get().tasks)) forgetTask(id);
    store.update((d) => {
      d.tasks = {};
      d.taskOrder = [];
      d.runs = {};
      d.events = [];
      d.selectedTaskId = undefined;
      d.selectedRunId = undefined;
      d.celebration = undefined;
      d.console.focusId = undefined;
      d.focusRequest = undefined;
      // What is left would point at tasks and runs that no longer exist.
      d.toasts = d.toasts.filter((t) => !t.action || t.action.command.type === 'navigate');
      if (d.view === 'task') d.view = 'tasks';
    });
    feedback({ tone: 'neutral', title: '任务记录已清除', body: `${count} 个任务及其运行记录已移除，设置、模型接入、Agent 和工具策略都还在。` });
  },

  /* ── console ── */
  toggleConsole(open?: boolean) {
    store.update((d) => { d.console.open = open ?? !d.console.open; });
  },
  openConsole(tab: ConsoleTab, focusId?: string) {
    store.update((d) => { d.console.open = true; d.console.tab = tab; d.console.focusId = focusId; });
  },
  setConsoleTab(tab: ConsoleTab) {
    store.update((d) => { d.console.tab = tab; });
  },
  setConsoleHeight(height: number) {
    store.update((d) => { d.console.height = Math.round(Math.min(Math.max(height, 160), window.innerHeight * 0.7)); });
  },

  /* ── toasts, dialogs, celebration ── */
  toast(t: ToastInput, spoken?: string) { feedback(t, spoken); },
  dismissToast(id: string) {
    store.update((d) => { d.toasts = d.toasts.filter((t) => t.id !== id); });
  },
  openDialog(dialog: Dialog) {
    store.update((d) => { d.dialog = dialog; });
  },
  closeDialog() {
    store.update((d) => { d.dialog = undefined; });
  },
  confirmDialog() {
    const dialog = store.get().dialog;
    store.update((d) => { d.dialog = undefined; });
    if (!dialog) return;
    if (dialog.kind === 'cancel-run') actions.cancelRun(dialog.runId);
    else if (dialog.kind === 'delete-task') actions.deleteTask(dialog.taskId);
    else if (dialog.kind === 'clear-history') actions.clearHistory();
  },
  clearCelebration() {
    store.update((d) => { d.celebration = undefined; });
  },

  /** Run a command carried by a toast or link. */
  run(cmd: UiCommand) {
    switch (cmd.type) {
      case 'open-task': return actions.openTask(cmd.taskId, cmd.runId, cmd.tab);
      case 'open-console':
        // Show the run the command is about, not whichever one the console happened to be following.
        if (cmd.taskId) actions.openTask(cmd.taskId, cmd.runId);
        return actions.openConsole(cmd.tab, cmd.focusId);
      case 'resume-run': {
        // A stale toast (the run was already resumed or cancelled) does nothing instead of raising an error.
        if (runOf(cmd.runId)?.status !== 'paused') return;
        const task = taskOfRun(cmd.runId);
        if (task) actions.openTask(task.id, cmd.runId);
        return actions.resumeRun(cmd.runId);
      }
      case 'retry-run': return actions.retryRun(cmd.runId, cmd.mode);
      case 'show-approvals': {
        // 首页与「待你」没有右栏，焦点请求没有人接：先去那条待批所在的任务页（有 taskId 时，别的任务页也一样），再请求聚焦
        const d = store.get();
        const elsewhere = !!cmd.taskId && (d.view !== 'task' || d.selectedTaskId !== cmd.taskId);
        if (VIEWS_WITHOUT_STATUS.has(d.view) || elsewhere) {
          if (!cmd.taskId) return d.view === 'new' ? actions.navigate('queue') : undefined;   // 不知道是哪个任务：到「待你」，那里就是全部待批
          actions.openTask(cmd.taskId, cmd.runId);
        }
        return actions.requestFocus('approvals');
      }
      case 'navigate': return actions.navigate(cmd.view);
      case 'mute-rest': return actions.muteRest();
    }
  },
};
