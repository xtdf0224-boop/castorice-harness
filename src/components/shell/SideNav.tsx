/* 左栏（按样稿 s1/s2）：
     顶部：品牌「枝上蝶」+ 栖枝 / ALIGHT，「新开」
     <QueueNav/>（待你 · N · 最久；B4）
     归来 · 案头（任务按所在目录分组，每个任务一只蝶：在途=线框蝶）· 成品架 / 档案（V1，禁用并标注）· 行迹
     底部：白花海 · <QuotaBar/>（额度；B4）· 她的话量（少/中/多）· 设置（含 工具与技能 / 模型接入 / Agent / 任务列表）
   紧凑态（手动收起，或视口 < 960px）只显示图标；< 640px 时变成顶部横条（见 shell.css）。
   夜 / 昼切换在底部一枚图标按钮；完整的主题选择在 设置 › 外观。 */
import {
  Bot, ChevronDown, ChevronRight, ChevronUp, Circle, Eye, ListTodo, MessageCircle, Moon, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Settings, Sun, Wrench, Cpu,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMedia } from '../../lib/hooks';
import { RUN_STATUS } from '../../lib/status';
import type { Level, Task, ViewId } from '../../lib/types';
import { actions } from '../../state/actions';
import { engineChoices } from '../../state/models';
import { latestRun, openRuns, pendingApprovals, personaOn, taskStatus } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { FlowerSea } from '../decor/FlowerSea';
import { AltIcon, BrandMark, Butterfly } from '../decor/marks';
import { Badge, IconButton, cx } from '../ui';
import { LAID_DOWN_META } from '../workspace/shared';
import { QueueNav } from './QueueNav';
import { QuotaBar } from './QuotaBar';
import { COMPACT_QUERY, DRAWER_QUERY } from './queries';

/* ───────────── 导航项 ───────────── */

function NavItem({ view, active, icon, label, keyHint, note, badge, disabled, tag }: {
  view?: ViewId; active?: boolean; icon: ReactNode; label: string; keyHint?: string; note?: string; badge?: ReactNode; disabled?: boolean; tag?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className={cx('side-nav__item', disabled && 'is-disabled')}
        aria-current={active ? 'page' : undefined}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={`${label}${keyHint ? ` (Alt+${keyHint})` : ''}${note ? ` · ${note}` : ''}`}
        onClick={() => { if (view) actions.navigate(view); }}
      >
        {icon}
        <span className="side-nav__label">{label}</span>
        {tag && <span className="side-nav__tag">{tag}</span>}
        {badge}
      </button>
    </li>
  );
}

/* ───────────── 案头：按目录分组的任务 ───────────── */

const CHAT_GROUP = '闲聊';
const LOOSE_GROUP = '未归目录';
const MAX_GROUPS = 6;
const MAX_PER_GROUP = 5;
const SEP = '\u0001';

/** 任务所在目录的末段；闲聊没有目录。 */
function projectOf(t: Task): string {
  if (t.kind === 'chat') return CHAT_GROUP;
  const cwd = t.engine?.cwd;
  if (!cwd) return LOOSE_GROUP;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || LOOSE_GROUP;
}

const SHORT: Record<string, string> = {
  draft: '未开始', queued: '排队', running: '在途', paused: '暂停', awaiting: '待你', completed: '完成', failed: '失败', cancelled: '已取消',
};

function TaskNode({ id }: { id: string }) {
  const title = useApp((s) => s.tasks[id]?.title);
  const status = useApp((s) => { const t = s.tasks[id]; return t ? taskStatus(s, t) : undefined; });
  const chat = useApp((s) => s.tasks[id]?.kind === 'chat');
  const current = useApp((s) => s.view === 'task' && s.selectedTaskId === id);
  // 放下之后不再是红色「失败」：灰色「已放下」+ 叶片图标（与页头、右栏同一个说法）.
  const laid = useApp((s) => { const t = s.tasks[id]; const r = t ? latestRun(s, t) : undefined; return r?.status === 'failed' && !!r.laidDownAt; });
  if (!title || !status) return null;
  const meta = laid ? LAID_DOWN_META : status === 'draft' ? undefined : RUN_STATUS[status];
  const Icon = meta?.icon ?? Circle;
  const short = laid ? '已放下' : chat && status === 'draft' ? '闲聊' : SHORT[status];
  // 状态 = 图标的形状 + 文字 + 颜色，不只靠颜色。在途 = 线框蝶（蓝只给蝶与运行中）。
  return (
    <li>
      <button
        type="button"
        className="side-nav__task"
        aria-current={current ? 'true' : undefined}
        title={`${title} · ${meta?.label ?? short}`}
        onClick={() => actions.openTask(id)}
      >
        <span className="side-nav__task-ic" data-tone={meta?.tone ?? 'neutral'} data-laid={laid ? 'true' : undefined} aria-hidden="true">
          {status === 'running' ? <Butterfly size={20} variant="wire" className="side-nav__bf" /> : chat && status === 'draft' ? <MessageCircle size={14} /> : <Icon size={14} />}
        </span>
        <span className="truncate side-nav__task-title">{title}<span className="sr-only">，{meta?.label ?? short}</span></span>
        <span className="side-nav__task-st" data-tone={meta?.tone ?? 'neutral'} data-laid={laid ? 'true' : undefined} aria-hidden="true">{short}</span>
      </button>
    </li>
  );
}

function Desk() {
  const rows = useApp((s) => s.taskOrder.slice(0, 60).map((id) => { const t = s.tasks[id]; return t ? `${projectOf(t)}${SEP}${id}` : ''; }), shallow);
  const selectedGroup = useApp((s) => {
    const t = s.view === 'task' && s.selectedTaskId ? s.tasks[s.selectedTaskId] : undefined;
    return t ? projectOf(t) : undefined;
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups: Array<{ name: string; ids: string[] }> = [];
  for (const r of rows) {
    if (!r) continue;
    const [name, id] = r.split(SEP);
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, ids: [] }; groups.push(g); }
    g.ids.push(id);
  }
  const shown = groups.slice(0, MAX_GROUPS);
  const hidden = groups.slice(MAX_GROUPS).reduce((n, g) => n + g.ids.length, 0);
  const isOpen = (name: string, idx: number) => open[name] ?? (name === selectedGroup || idx === 0);
  return (
    <section className="side-nav__desk" aria-labelledby="side-nav-desk-title">
      <div className="side-nav__grp">
        <h2 id="side-nav-desk-title">案头</h2>
        <button type="button" className="side-nav__grp-link" onClick={() => actions.navigate('tasks')} title="任务列表 (Alt+2)">全部</button>
      </div>
      {shown.length === 0 && <p className="side-nav__empty">还没有任务</p>}
      <ul className="side-nav__proj-list">
        {shown.map((g, i) => {
          const expanded = isOpen(g.name, i);
          return (
            <li key={g.name}>
              <button
                type="button"
                className={cx('side-nav__proj', expanded && 'is-open')}
                aria-expanded={expanded}
                onClick={() => setOpen((o) => ({ ...o, [g.name]: !expanded }))}
              >
                {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <span className="truncate">{g.name}</span>
                <em className="side-nav__cnt">({g.ids.length})</em>
              </button>
              {expanded && (
                <ul className="side-nav__kids">
                  {g.ids.slice(0, MAX_PER_GROUP).map((id) => <TaskNode key={id} id={id} />)}
                  {g.ids.length > MAX_PER_GROUP && (
                    <li><button type="button" className="side-nav__more" onClick={() => actions.navigate('tasks')}>另 {g.ids.length - MAX_PER_GROUP} 项…</button></li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <button type="button" className="side-nav__more side-nav__more--root" onClick={() => actions.navigate('tasks')}>另 {hidden} 项在任务列表里…</button>}
    </section>
  );
}

/* ───────────── 底部：她的话量、设置菜单 ───────────── */

const VOICE: Array<{ v: Level; label: string; hint: string }> = [
  { v: 's', label: '少', hint: '短，但仍是她' },
  { v: 'm', label: '中', hint: '会接话（默认）' },
  { v: 'l', label: '多', hint: '站近一些，愿意讲小事' },
];

/** 她的话量：少 / 中 / 多绑 settings.level（setLevel 同时派生旧的 distance 垫片）. 角色口吻关掉时仍可调，只是她说的是事实. */
function Voice() {
  const level = useApp((s) => s.settings.level ?? 'm');
  const persona = useApp((s) => personaOn(s));
  const name = useId();
  return (
    <div className="side-nav__voice">
      <div className="side-nav__voice-row">
        {/* 角色关掉后只说事实，左栏也不再出现她的定位：这一项叫「回复长度」 */}
        <span id={`${name}-l`}>{persona ? '她的话量' : '回复长度'}</span>
        <span className="side-nav__voice-opts" role="radiogroup" aria-labelledby={`${name}-l`}>
          {VOICE.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={level === o.v} title={o.hint} className={cx(level === o.v && 'is-on')} onClick={() => actions.setLevel(o.v)}>{o.label}</button>
          ))}
        </span>
      </div>
    </div>
  );
}

const MENU: Array<{ view: ViewId; label: string; icon: ReactNode; key: string }> = [
  { view: 'settings', label: '设置', icon: <Settings size={16} aria-hidden />, key: '7' },
  { view: 'tools', label: '工具与技能', icon: <Wrench size={16} aria-hidden />, key: '4' },
  { view: 'models', label: '模型接入', icon: <Cpu size={16} aria-hidden />, key: '5' },
  { view: 'agents', label: 'Agent', icon: <Bot size={16} aria-hidden />, key: '3' },
  { view: 'tasks', label: '任务列表', icon: <ListTodo size={16} aria-hidden />, key: '2' },
];

function GearMenu({ compact }: { compact: boolean }) {
  const view = useApp((s) => s.view);
  const models = useApp((s) => engineChoices(s.models).length);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); wrap.current?.querySelector<HTMLElement>('button')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const settingsActive = MENU.some((m) => m.view === view && m.view !== 'tasks');
  return (
    <div className="side-nav__gear-wrap" ref={wrap}>
      {open && (
        <ul className="side-nav__menu" id={menuId} role="menu" aria-label="设置与接入">
          {MENU.map((m) => (
            <li key={m.view} role="none">
              <button type="button" role="menuitem" className="side-nav__menu-item" aria-current={view === m.view ? 'page' : undefined}
                onClick={() => { setOpen(false); actions.navigate(m.view); }}>
                {m.icon}<span>{m.label}</span><kbd className="kbd">Alt+{m.key}</kbd>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={cx('side-nav__gear', settingsActive && 'is-active')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="设置、工具与技能、模型接入"
        onClick={() => setOpen((o) => !o)}
      >
        <AltIcon name="gear" size={18} />
        <span className="side-nav__gear-text">
          <b>设置</b>
          {models > 0
            ? <small>工具与技能 · 模型接入</small>
            : <small className="is-warn"><i aria-hidden />还没有接入模型</small>}
        </span>
        {!compact && <ChevronUp size={14} aria-hidden className="side-nav__gear-chev" />}
        {compact && models === 0 && <span className="side-nav__gear-dot" aria-hidden />}
      </button>
    </div>
  );
}

/* ───────────── 左栏 ───────────── */

export function SideNav() {
  const view = useApp((s) => s.view);
  const collapsed = useApp((s) => s.navCollapsed);
  const mode = useApp((s) => s.settings.mode);
  const wallpaperOn = useApp((s) => s.settings.wallpaper);
  const openCount = useApp((s) => openRuns(s).length);
  const pending = useApp((s) => pendingApprovals(s).length);
  const narrow = useMedia(COMPACT_QUERY);
  // Below 1280px the status panel is a drawer; every view with a status panel needs a way to open it.
  const drawerMode = useMedia(DRAWER_QUERY);
  const compact = collapsed || narrow;
  const hasStatus = view !== 'new' && view !== 'queue';
  const nextMode = mode === 'day' ? 'night' : 'day';

  return (
    <nav className="side-nav" aria-label="主导航" data-compact={compact ? 'true' : 'false'} data-boot-in="nav">
      <div className="side-nav__top">
        <button type="button" className="side-nav__brand" onClick={() => actions.navigate('new')} title="归来 (Alt+1)">
          <BrandMark size={compact ? 34 : 38} glow bootTarget="brand-mark" />
          <span className="side-nav__brandtext">
            <span className="side-nav__name" data-boot-target="brand-name">栖枝</span>
            <span className="side-nav__sub" data-boot-target="brand-sub">ALIGHT</span>
          </span>
        </button>
        <button
          type="button"
          className="side-nav__cta"
          title="新开一件事 (Alt+1)"
          onClick={() => { actions.navigate('new'); actions.requestFocus('composer'); }}
        >
          <Plus size={14} aria-hidden />
          <span className="side-nav__cta-label">新开</span>
        </button>
      </div>

      {/* 「待你 · N · 最久」入口（B4 实现，B1 负责它在左栏里的位置与样式）. */}
      <QueueNav collapsed={compact} />

      <div className="side-nav__scroll">
        <ul className="side-nav__list">
          <NavItem view="new" active={view === 'new'} label="归来" keyHint="1" icon={<AltIcon name="return" size={18} />} />
          {compact && (
            <NavItem
              view="tasks"
              active={view === 'tasks' || view === 'task'}
              label="案头"
              keyHint="2"
              note={openCount > 0 ? `${openCount} 个在途` : undefined}
              icon={<ListTodo size={18} aria-hidden />}
              badge={openCount > 0 && <Badge tone="running" className="side-nav__badge">{openCount}<span className="sr-only"> 个在途</span></Badge>}
            />
          )}
        </ul>
        {!compact && <Desk />}
      </div>

      {/* 成品架 / 档案 / 行迹钉在滚动区下面：窗口再矮，案头也只是在自己那一块里滚，导航项永远不会落到装饰或额度块下面。 */}
      <div className="side-nav__pinned">
        <div className="side-nav__hr" aria-hidden />
        <ul className="side-nav__list">
          <NavItem label="成品架" icon={<AltIcon name="box" size={18} />} disabled tag="V1" note="V1 开放" />
          <NavItem label="档案" icon={<AltIcon name="book" size={18} />} disabled tag="V1" note="V1 开放" />
          <NavItem view="history" active={view === 'history'} label="行迹" keyHint="6" icon={<AltIcon name="history" size={18} />} />
        </ul>
      </div>

      <div className="side-nav__spacer" aria-hidden />
      {!compact && <div className="side-nav__sea" aria-hidden="true"><FlowerSea className="side-nav__sea-svg" w={216} h={56} seed={7} n={7} /></div>}

      {/* 额度条 L0（B4 实现，估算）. */}
      <QuotaBar collapsed={compact} />
      {!compact && <Voice />}

      <div className="side-nav__footer">
        <GearMenu compact={compact} />
        <div className="side-nav__tools">
          {drawerMode && hasStatus && (
            <IconButton
              className="side-nav__status-btn"
              icon={PanelRight}
              label={pending > 0 ? `打开状态面板（${pending} 项待确认）` : '打开状态面板'}
              aria-haspopup="dialog"
              onClick={() => actions.toggleStatusDrawer(true)}
            />
          )}
          <IconButton
            className="side-nav__mode-btn"
            icon={mode === 'day' ? Moon : Sun}
            label={mode === 'day' ? '切换到夜（冥河）' : '切换到昼（花海）'}
            onClick={() => actions.setSetting('mode', nextMode)}
          />
          {wallpaperOn && (
            <IconButton className="side-nav__peek" icon={Eye} label="赏图：淡出界面，完整看壁纸（Alt+W）" onClick={() => actions.togglePeek(true)} />
          )}
          {!narrow && (
            <IconButton
              className="side-nav__collapse"
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              label={collapsed ? '展开导航' : '收起导航'}
              onClick={() => actions.toggleNav()}
            />
          )}
        </div>
      </div>
    </nav>
  );
}
