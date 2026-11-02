/* 首页的输入框「信封」（V0α · 模块 B4「交互」，K31 / K32）。
   「寄往 目录 · 引擎 · 手套」在文字上方，右边是闲聊 / 工作的切换——由你选，不靠模型自动分类（避免误伤排障类会话）。
   闲聊：无工具、不动文件，只寄往一个引擎；工作：目录、引擎、权限模式（手套）都要定，开始前先过一遍信任（requestTrust）。
   强度、参与的 Agent、技能、只读、浏览器折叠在「⋯」里。Enter 发送；输入法组合期间的回车是选字（PromptBox 里的守卫）. */
import { Cpu, Ellipsis, FolderOpen, Globe, Hammer, MessageCircle, Shield, Sparkles, Users } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { desktop } from '../../../lib/desktop';
import { useSay2 } from '../../../lib/voice';
import type { Effort } from '../../../lib/effort';
import { PERSONA } from '../../../lib/persona';
import { DRIVERS, PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import type { Agent, AgentId, AppState, DriverId, ModelState, PermissionMode, TaskEngine, TaskKind, TrustLevel, WorkAccess } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { agentEngine, choiceEfforts, defaultChoice, engineFromChoice, type EngineChoice } from '../../../state/models';
import { personaOn as isPersonaOn } from '../../../state/selectors';
import { skillsForKind } from '../../../state/skills';
import { requestTrust, trustLevel } from '../../../state/trustGate';
import { shallow, useApp } from '../../../state/store';
import { Segmented, cx } from '../../ui';
import { AgentMark } from '../../her/AgentMark';
import { MenuSelect } from '../../ui/MenuSelect';
import { ExprBadge } from '../../her/ExprBadge';
import { ModelChips } from '../../workspace/ModelChips';
import { PromptBox } from '../../workspace/PromptBox';
import { useChoices, useModelsKnown } from './choices';
import { DEFAULT_MODE, modeInfo, modeNote } from './permission';
import { PermissionChip } from './PermissionChip';
import '../../../styles/interaction-composer.css';

const TITLE_CLIP = 24;
const KIND_KEY = 'alight/home-kind';

/** First line of the text, cut to ~24 characters: the task's name. */
function deriveTitle(text: string) {
  const first = text.split('\n')[0].trim();
  const chars = Array.from(first);
  return chars.length > TITLE_CLIP ? `${chars.slice(0, TITLE_CLIP).join('')}…` : first;
}

const selectComposerFocus = (s: AppState) => (s.focusRequest?.target === 'composer' ? s.focusRequest.at : 0);

const KIND_OPTIONS: Array<{ value: TaskKind; label: string; icon: typeof MessageCircle; hint: string }> = [
  { value: 'chat', label: '闲聊', icon: MessageCircle, hint: '随便聊聊，不动文件也不执行命令' },
  { value: 'work', label: '工作', icon: Hammer, hint: '交给 Agent 一个目标：先出计划、调用工具、关键操作前征求确认' },
];

const ACCESS_OPTIONS: Array<{ value: WorkAccess; label: string; sub: string }> = [
  { value: 'policy', label: '按工具策略', sub: '按「工具与技能」里设置的策略执行' },
  { value: 'read', label: '只读', sub: '只能读取和搜索，不写文件、不执行命令' },
];

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const normPath = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/** A way's default 推理强度 (set on 模型接入), when the chosen model accepts it. */
const startEffort = (m: ModelState, c: EngineChoice, model: string): Effort | undefined =>
  (c.effort && choiceEfforts(m, c, model).includes(c.effort) ? c.effort : undefined);

function readKind(): TaskKind {
  try { return localStorage.getItem(KIND_KEY) === 'chat' ? 'chat' : 'work'; } catch { return 'work'; }
}
function writeKind(k: TaskKind) {
  try { localStorage.setItem(KIND_KEY, k); } catch { /* 记不住就算了 */ }
}

/** 最近用过的真实目录（练习目录不算），最多 5 个. */
function selectRecentFolders(s: AppState): string[] {
  const root = s.models.workspaceRoot ? normPath(s.models.workspaceRoot) : undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of s.taskOrder) {
    const cwd = s.tasks[id]?.engine?.cwd;
    if (!cwd) continue;
    const n = normPath(cwd);
    if (seen.has(n) || (root && n.startsWith(`${root}/`))) continue;
    seen.add(n);
    out.push(cwd);
    if (out.length >= 5) break;
  }
  return out;
}

interface Picked { key: string; model: string; effort?: Effort }

/** boot：是否在输入框上方放开屏后第一句（归来笺已经打过招呼时由 ReturnView 关掉，免得同一屏问候两次）.
   collapsible：首页用——开着时先收成一行（输入框 + 发送），点一下、敲一个键或把焦点移到别的控件，才展开寄往 / 强度 / 手套那几组下拉；
   这样归来笺（这一页的主体）不被 250 px 高的输入框挤掉. 展开后这次停留里不再收回去（免得下拉开着时它的锚点消失）. */
export function Composer({ boot: showBoot = true, collapsible = false }: { boot?: boolean; collapsible?: boolean } = {}) {
  const agents = useApp((s) => s.agents);
  const focusAt = useApp(selectComposerFocus);
  const skillList = useApp((s) => s.skills?.list);
  const recents = useApp(selectRecentFolders, shallow);
  const mode = useApp((s) => s.settings.mode);
  const personaOn = useApp(isPersonaOn);
  const { models, choices } = useChoices();
  const known = useModelsKnown();
  const say2 = useSay2();

  const [kind, setKindState] = useState<TaskKind>(readKind);
  const [text, setText] = useState('');
  const [override, setOverride] = useState<AgentId[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [pick, setPick] = useState<Picked | null>(null);
  const [skillsOff, setSkillsOff] = useState<string[]>([]);
  const [browserOn, setBrowserOn] = useState(false);
  const [folder, setFolder] = useState('');
  const [access, setAccess] = useState<WorkAccess>('policy');
  const [permission, setPermission] = useState<PermissionMode>(DEFAULT_MODE);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [folderTrust, setFolderTrust] = useState<TrustLevel | undefined>(undefined);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const errId = `${base}-err`;
  const setKind = (k: TaskKind) => { setKindState(k); writeKind(k); setInvalid(false); };
  const compact = collapsible && !engaged && !text && !invalid && !more;
  const engage = () => { if (collapsible && !engaged) setEngaged(true); };

  useEffect(() => {
    if (focusAt && Date.now() - focusAt < 2000) textRef.current?.focus();
  }, [focusAt]);
  // 首页默认焦点在输入框，不在待你的某一行（免得一进来按 Enter 误触）；别处已经有焦点时不抢.
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) textRef.current?.focus({ preventScroll: true });
  }, []);

  // 选了真实目录：先看一眼它现在是什么信任档，信封下面写一句（开始时 requestTrust 才是真正的闸）.
  useEffect(() => {
    if (!folder) { setFolderTrust(undefined); return; }
    let live = true;
    void trustLevel(folder).then((t) => { if (live) setFolderTrust(t); }).catch(() => { if (live) setFolderTrust(undefined); });
    return () => { live = false; };
  }, [folder]);

  // Nothing picked yet (or the picked way is gone): start from the default vendor and the effort set on 模型接入.
  const picked = pick && choices.some((c) => c.key === pick.key) ? pick : null;
  const choice = picked ? choices.find((c) => c.key === picked.key) : defaultChoice(models, choices);
  const model = picked ? picked.model : choice?.model ?? '';
  const effort = picked ? picked.effort : choice ? startEffort(models, choice, model) : undefined;
  const cli = choice?.auth === 'cli';
  const driver = cli && choice?.driver ? DRIVERS[choice.driver] : undefined;
  const who = personaOn ? PERSONA[mode].name : '编排 Agent';
  // 输入框的占位字与开屏后第一句（场景 boot 的 boot.c.* / boot.w.*，随闲聊 / 工作切换；一次一句，不进对话流；关掉角色口吻就不出）.
  const chatKind = kind === 'chat';
  const placeholder = say2(chatKind ? 'composer.c' : 'composer.w', {}, { mode: chatKind ? 'chat' : 'work' }).text || (chatKind ? '想聊点什么' : '写下一个目标');
  const boot = showBoot && personaOn && choice ? say2('boot', {}, { mode: chatKind ? 'chat' : 'work' }) : undefined;
  const taskName = choice ? engineLabel(PROVIDER_BY_ID[choice.provider], choice.auth, choice.driver, model) : '';

  // Each Agent's own model, when it has one that is ready (the 编排 Agent always follows the task).
  const own = useMemo(() => new Map<AgentId, TaskEngine | undefined>(
    agents.filter((a) => a.id !== 'orchestrator').map((a): [AgentId, TaskEngine | undefined] => [a.id, agentEngine(models, a.engine, {})]),
  ), [agents, models]);

  // Over an API model every enabled Agent takes part; over a command-line agent only those with a model of their own do.
  const defaults = agents.filter((a) => a.id !== 'orchestrator' && a.enabled && (!cli || own.get(a.id))).map((a) => a.id);
  const wanted = override ?? defaults;
  const work = kind === 'work';
  const agentIds: AgentId[] = work
    ? agents.filter((a) => a.id === 'orchestrator' || (a.enabled && wanted.includes(a.id))).map((a) => a.id)
    : ['orchestrator'];

  // Command-line tools in play: the task's own model and/or an Agent's. They decide whether a folder,
  // permissions and the browser matter.
  const cliDrivers = [
    cli ? choice?.driver : undefined,
    ...(work ? agentIds.map((id) => { const e = own.get(id); return e?.auth === 'cli' ? e.driver : undefined; }) : []),
  ].filter((d): d is DriverId => !!d);
  const cliInvolved = cliDrivers.length > 0;
  const agentCli = cliDrivers.length > (cli ? 1 : 0);
  const canBrowse = cliDrivers.some((d) => d !== 'dsh');
  const offeredSkills = choice ? skillsForKind(skillList, kind) : [];
  const withTools = work && cliInvolved;

  const onPick = (p: Picked) => {
    const next = choices.find((c) => c.key === p.key);
    if (!next) return;
    // ModelChips already settles 推理强度 (kept if the model has it, else the new way's default).
    setPick(p);
    // The default cast differs between API and command-line models.
    if ((next.auth === 'cli') !== cli) setOverride(null);
  };

  const chooseFolder = async (v: string) => {
    if (v !== '__pick__') { setFolder(v); return; }
    const d = await desktop?.pickFolder(folder || undefined);
    if (d) setFolder(d);
  };

  const submit = async () => {
    if (!choice) return;
    const trimmed = text.trim();
    if (work && !trimmed) { setInvalid(true); textRef.current?.focus(); return; }
    setBusy(true);
    try {
      let cwd: string | undefined;
      let trust: TrustLevel | undefined;
      if (cliInvolved) {
        // Minute precision alone would put two tasks started in the same minute in one folder.
        const slug = `${kind}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
        cwd = work && folder ? folder : await desktop?.workspaceFolder(slug);
        // 工作任务开始前先过信任：T0 只读、T1 我的目录；取消就不创建.
        if (work && cwd) {
          const t = await requestTrust(cwd);
          if (t === null) {
            actions.toast({ tone: 'neutral', title: '先不开始', body: '没有确认这个目录，任务没有创建。想继续时再点发送。' });
            return;
          }
          trust = t;
        }
      }
      const engine: TaskEngine = {
        ...engineFromChoice(choice, {
          cwd, access: withTools ? access : undefined, model, effort,
          browser: withTools && canBrowse && browserOn && access !== 'read',
        }),
        permissionMode: withTools ? permission : undefined,
      };
      const title = kind === 'chat' ? (trimmed ? deriveTitle(trimmed) : `和${who}的闲聊`) : deriveTitle(trimmed);
      const off = offeredSkills.filter((x) => skillsOff.includes(x.folder));
      const skills = off.length ? offeredSkills.filter((x) => !skillsOff.includes(x.folder)).map((x) => x.folder) : undefined;
      actions.createTask({ title, goal: trimmed, kind, engine, agentIds, start: true, skills, trust });
    } catch (e) {
      actions.toast({ tone: 'danger', title: '没能新建', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const note = withTools && cli ? modeNote(permission, choice?.driver) : undefined;
  const untrusted = !!folder && folderTrust === 'T0' && withTools;
  const hint = !choice
    ? (known ? '先接入一个模型，才能开始。' : '正在读取模型接入…')
    : !work
      ? (cli ? `通过 ${taskName} 聊天，不会动文件。` : `通过 ${taskName} 对话。`)
      : untrusted
        ? '这个目录还没有确认是你自己的：只读打开，开始时会先问一声。'
        : note
          ? note
          : cli
            ? `${driver?.label} 会在目录里读写文件、执行命令${driver?.approvals === 'per-call' ? `；模式：${modeInfo(permission).label}` : '，它的无头模式不能逐项确认，按沙箱策略执行'}。`
            : agentCli
              ? '计划和写作由这个 API 模型完成；用命令行模型的 Agent 会在目录里读写文件、执行命令。'
              : 'API 方式只思考和写作，不会读写你的文件、不会执行命令；要动手请选命令行方式，或给 Agent 指定一个命令行模型。';

  const folderOptions = [
    { value: '', label: '练习目录', sub: '自动新建一个独立的、可丢弃的文件夹', icon: FolderOpen },
    ...recents.map((p) => ({ value: p, label: baseName(p), sub: p, icon: FolderOpen })),
    { value: '__pick__', label: '选择目录…', icon: FolderOpen },
  ];

  const addr = (
    <>
      <span className="env-label">寄往</span>
      {withTools && (
        <>
          <MenuSelect<string> variant="chip" icon={FolderOpen} label="目录" value={folder} options={folderOptions} onChange={(v) => void chooseFolder(v)}
            display={folder ? baseName(folder) : '练习目录'} title={folder || '自动新建一个独立的、可丢弃的文件夹'} search={false} minWidth={300} />
          <span className="env-dot" aria-hidden>·</span>
        </>
      )}
      {choice && <ModelChips pick={{ key: choice.key, model, effort }} onPick={onPick} />}
      {withTools && cli && (
        <>
          <span className="env-dot" aria-hidden>·</span>
          <PermissionChip value={permission} onChange={setPermission} driver={choice?.driver} />
        </>
      )}
      <Segmented<TaskKind> size="sm" className="pchip-seg env-kind" label="类型" options={KIND_OPTIONS} value={kind} onChange={setKind} />
    </>
  );

  const chips = (
    <>
      <button type="button" className={cx('pchip pchip--toggle env-more', more && 'is-on')} aria-expanded={more} title="强度之外的更多选项：Agent、技能、只读、浏览器"
        onClick={() => setMore((v) => !v)}>
        <Ellipsis size={14} aria-hidden /><span className="sr-only">更多选项</span>
      </button>
      {more && work && <AgentsChip agents={agents} ids={agentIds} own={own} onToggle={(id, on) => setOverride(on ? [...wanted, id] : wanted.filter((x) => x !== id))} />}
      {more && withTools && (
        <MenuSelect<WorkAccess> variant="chip" icon={Shield} label="读写范围" value={access} onChange={setAccess} options={ACCESS_OPTIONS}
          title={access === 'read' ? '只能读取和搜索' : '按「工具与技能」里的策略'} />
      )}
      {more && withTools && canBrowse && access !== 'read' && (
        <button type="button" className={cx('pchip pchip--toggle', browserOn && 'is-on')} aria-pressed={browserOn}
          title={browserOn ? 'Agent 可以操作栖枝浏览器（点击、输入会先征求确认）' : '让 Agent 可以操作栖枝浏览器'} onClick={() => setBrowserOn((v) => !v)}>
          <Globe size={13} aria-hidden />浏览器{browserOn ? ' · 开' : ''}
        </button>
      )}
      {more && offeredSkills.length > 0 && (
        <SkillsChip skills={offeredSkills} off={skillsOff} onToggle={(f, on) => setSkillsOff((prev) => (on ? prev.filter((x) => x !== f) : [...prev, f]))} />
      )}
    </>
  );

  return (
    // A disabled fieldset locks every control inside it (text box, chips, send) until a model is ready.
    <fieldset
      className={cx('home-composer', !choice && 'is-locked', compact && 'home-composer--compact')}
      disabled={!choice}
      onPointerDownCapture={engage}
      onKeyDownCapture={engage}
      onFocusCapture={(e) => { if ((e.target as Element) !== textRef.current) engage(); }}
    >
      {boot?.text && (
        <p className="home-composer__boot" data-her data-boot-line>
          {boot.expr && <ExprBadge expr={boot.expr} size={22} />}
          <span>{boot.text}</span>
        </p>
      )}
      <PromptBox
        variant="home"
        id={`${base}-text`}
        value={text}
        onChange={(v) => { setText(v); if (invalid && v.trim()) setInvalid(false); }}
        onSubmit={() => void submit()}
        inputRef={textRef}
        label={kind === 'chat' ? `和${who}聊天` : `交给${who}的任务`}
        placeholder={!choice ? '先接入一个模型，才能聊天或交给 Agent 任务' : placeholder}
        allowEmpty
        minRows={compact ? 1 : undefined}
        sending={busy}
        invalid={invalid}
        describedBy={invalid ? errId : undefined}
        addr={addr}
        chips={chips}
        hint={invalid ? <span className="pbox__err" id={errId} role="alert">先描述一个目标，Agent 才知道要做什么。</span> : <span className={cx(choice && 'is-live', (untrusted || note) && 'is-note')}>{hint}</span>}
      />
    </fieldset>
  );
}

/** A <details> chip menu: closes on an outside click, and on Esc with focus back on its summary. */
function useChipMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
  };
  return { ref, onKeyDown };
}

/** 技能: which installed skills this task may use (all enabled ones by default). */
function SkillsChip({ skills, off, onToggle }: { skills: Array<{ folder: string; name: string; description: string }>; off: string[]; onToggle: (folder: string, on: boolean) => void }) {
  const { ref, onKeyDown } = useChipMenu();
  const on = skills.filter((s) => !off.includes(s.folder)).length;
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={onKeyDown}>
      <summary title="这次可以用的技能"><Sparkles size={13} aria-hidden />技能 {on}/{skills.length}</summary>
      <div className="pchip__menu" role="group" aria-label="这次可以用的技能">
        {skills.map((s) => (
          <label key={s.folder} className="pchip__opt pchip__opt--skill">
            <input type="checkbox" checked={!off.includes(s.folder)} onChange={(e) => onToggle(s.folder, e.target.checked)} />
            <Sparkles size={14} aria-hidden />
            <span className="pchip__opt-text"><strong className="mono">{s.name}</strong><small>{s.description}</small></span>
          </label>
        ))}
      </div>
    </details>
  );
}

/** 参与的 Agent: a small menu of checkboxes. Each row says which model that Agent will use. */
function AgentsChip({ agents, ids, own, onToggle }: {
  agents: Agent[];
  ids: AgentId[];
  own: Map<AgentId, TaskEngine | undefined>;
  onToggle: (id: AgentId, on: boolean) => void;
}) {
  const { ref, onKeyDown } = useChipMenu();
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={onKeyDown}>
      <summary title="参与的 Agent"><Users size={13} aria-hidden />{ids.length} 个 Agent</summary>
      <div className="pchip__menu" role="group" aria-label="参与的 Agent">
        {agents.map((a) => {
          const required = a.id === 'orchestrator';
          const engine = own.get(a.id);
          return (
            <label key={a.id} className={cx('pchip__opt', !a.enabled && 'is-off')}>
              <input type="checkbox" checked={required || (a.enabled && ids.includes(a.id))} disabled={required || !a.enabled}
                onChange={(e) => onToggle(a.id, e.target.checked)} />
              <AgentMark agent={a.id} size={22} state={a.enabled ? 'idle' : 'off'} />
              <span className="pchip__opt-text">
                <strong>{a.name}</strong>
                <small>{required ? '必选 · ' : !a.enabled ? '已停用 · ' : ''}{a.role}</small>
                {engine
                  ? <small className="pchip__opt-model is-own"><Cpu size={11} aria-hidden />{engine.label}</small>
                  : <small className="pchip__opt-model">{a.engine && !required ? '跟随任务（它选的模型现在用不了）' : '跟随任务'}</small>}
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
