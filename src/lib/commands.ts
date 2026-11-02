/* 命令注册表与全局键（V0α · 模块 B4「交互」，K21 / X03）。
   单一注册表：面板、快捷键、帮助页、设置页都从它生成（面板与快捷键设置在 V0β）。
   命令带中文标题、拼音别名、可用性谓词、危险等级。

   输入法与文本框（K3 / K2）：
   · 输入法组合期间（isComposing / keyCode 229），任何绑定都不触发；
   · 焦点在文本框里时，「会打出字符」的绑定（没有 Ctrl / Alt / Meta 的字母、数字、符号）不触发；
     Ctrl+N、Alt+1、Esc 这类不产生字符的组合照常触发；
   · 批准黑手套没有全局键，也没有单键：本表里不会出现批准、放行一类的命令绑定（check-interaction 会查）。
   萤火原有的 Alt+1…7、Ctrl+`、Alt+W、Esc 迁到这里；新增 Ctrl+N 新会话、Ctrl+, 设置、Ctrl+B 侧栏、Alt+8 待你。 */
import { useEffect } from 'react';
import { actions } from '../state/actions';
import { store } from '../state/store';
import { isComposingEvent, isEditableTarget, type KeyLike } from './ime';
import type { Level, ViewId } from './types';

export interface Command {
  id: string;
  title: string;
  /** 分类，帮助页与面板里分组用. */
  category?: string;
  /** 拼音全拼与首字母，供面板搜索. */
  aliases?: string[];
  /** 绑定，如 'Alt+1'、'Ctrl+Shift+P'、'Escape'. */
  keys?: string[];
  danger?: 'none' | 'confirm';
  /** true = 可用；false 或一句原因 = 不可用（面板里灰显并写出原因）. */
  enabled?: () => boolean | string;
  /** 赏图（peek）期间界面是惰性的，只有标了 peek 的命令可用. */
  peek?: boolean;
  run: () => void;
}

const registry = new Map<string, Command>();

export function registerCommand(c: Command) { registry.set(c.id, c); }
export function commands(): Command[] { return [...registry.values()]; }
export function commandById(id: string): Command | undefined { return registry.get(id); }

/* ───────────── 键位解析与匹配 ───────────── */

export interface Binding { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

const KEY_ALIAS: Record<string, string> = { esc: 'escape', del: 'delete', return: 'enter', space: ' ', spacebar: ' ', backquote: '`', comma: ',', period: '.', slash: '/' };

export function parseBinding(spec: string): Binding {
  const b: Binding = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const raw of spec.split('+')) {
    const part = raw.trim().toLowerCase();
    if (part === 'ctrl' || part === 'control') b.ctrl = true;
    else if (part === 'alt' || part === 'option') b.alt = true;
    else if (part === 'shift') b.shift = true;
    else if (part === 'meta' || part === 'cmd' || part === 'win' || part === 'super') b.meta = true;
    else b.key = KEY_ALIAS[part] ?? part;
  }
  // 'Ctrl++' 之类：最后一段是空串，key 就是 '+'.
  if (!b.key && spec.endsWith('+')) b.key = '+';
  return b;
}

/** 事件的「键」：字母与数字用物理位置（输入法、Alt 组合下 key 会变），其余用 key. */
export function eventKey(e: { key?: string; code?: string }): string {
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === 'Backquote') return '`';
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return (e.key ?? '').toLowerCase();
}

export function matchesBinding(b: Binding, e: KeyLike & { code?: string }): boolean {
  return !!b.key && !!e.ctrlKey === b.ctrl && !!e.altKey === b.alt && !!e.shiftKey === b.shift && !!e.metaKey === b.meta && eventKey(e) === b.key;
}

/** 这个绑定会不会在文本框里打出字符（没有 Ctrl / Alt / Meta，且是单个字符键）. */
export function isCharBinding(b: Binding): boolean {
  return !b.ctrl && !b.alt && !b.meta && b.key.length === 1;
}

/** 系统与输入法占用的键（K4）：默认键位不得绑定这些. */
const RESERVED = ['ctrl+ ', 'ctrl+shift', 'alt+shift', 'meta+ ', 'ctrl+.', 'alt+f4', 'alt+tab'];
export function isReservedBinding(spec: string): boolean {
  const b = parseBinding(spec);
  if (!b.key) return true;                     // 只有修饰键（Ctrl+Shift、Alt+Shift）
  if (b.meta) return true;                     // Win+*
  const norm = `${b.ctrl ? 'ctrl+' : ''}${b.alt ? 'alt+' : ''}${b.shift ? 'shift+' : ''}${b.key}`;
  return RESERVED.includes(norm);
}

/** 同一个键绑到两个命令上的冲突. */
export function findConflicts(list: Command[] = commands()): Array<{ key: string; ids: string[] }> {
  const by = new Map<string, string[]>();
  for (const c of list) {
    for (const spec of c.keys ?? []) {
      const b = parseBinding(spec);
      const norm = `${b.ctrl ? 'ctrl+' : ''}${b.alt ? 'alt+' : ''}${b.shift ? 'shift+' : ''}${b.meta ? 'meta+' : ''}${b.key}`;
      by.set(norm, [...(by.get(norm) ?? []), c.id]);
    }
  }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
}

export type KeyEventLike = KeyLike & { code?: string; target?: unknown };

/** 这次按键该执行哪条命令；不该执行（组合态、文本框里的字符键、不可用、赏图中）返回 undefined. 纯函数，除了读 enabled 谓词. */
export function resolveCommand(e: KeyEventLike, list: Command[] = commands(), ctx: { peek?: boolean } = {}): Command | undefined {
  if (isComposingEvent(e)) return undefined;
  const editable = isEditableTarget(e.target);
  for (const c of list) {
    for (const spec of c.keys ?? []) {
      const b = parseBinding(spec);
      if (!matchesBinding(b, e)) continue;
      if (editable && isCharBinding(b)) continue;
      if (ctx.peek && !c.peek) continue;
      if (c.enabled && c.enabled() !== true) continue;
      return c;
    }
  }
  return undefined;
}

/** 键位显示：Alt+1、Ctrl+`、Esc. */
export function bindingLabel(spec: string): string {
  const b = parseBinding(spec);
  const k = b.key === 'escape' ? 'Esc' : b.key === ' ' ? 'Space' : b.key.length === 1 ? b.key.toUpperCase() : b.key.replace(/^./, (m) => m.toUpperCase());
  return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && 'Win', k].filter(Boolean).join('+');
}

/* ───────────── 默认命令 ───────────── */

const NAV: Array<{ key: string; view: ViewId; title: string; aliases: string[] }> = [
  { key: '1', view: 'new', title: '回到归来', aliases: ['huilai', 'hl', 'gl'] },
  { key: '2', view: 'tasks', title: '打开任务列表', aliases: ['renwuliebiao', 'rwlb'] },
  { key: '3', view: 'agents', title: '打开 Agent', aliases: ['agent'] },
  { key: '4', view: 'tools', title: '打开工具与技能', aliases: ['gongjuyujineng', 'gjyjn'] },
  { key: '5', view: 'models', title: '打开模型接入', aliases: ['moxingjieru', 'mxjr'] },
  { key: '6', view: 'history', title: '打开运行历史', aliases: ['yunxinglishi', 'yxls'] },
  { key: '7', view: 'settings', title: '打开设置', aliases: ['shezhi', 'sz'] },
];

const LEVELS: Level[] = ['s', 'm', 'l'];
const levelNow = (): Level => store.get().settings.level ?? 'm';

function defaults(): Command[] {
  const list: Command[] = NAV.map((n) => ({
    id: `nav.${n.view}`, title: n.title, category: '页面', aliases: n.aliases, keys: [`Alt+${n.key}`], run: () => actions.navigate(n.view),
  }));
  list.push(
    { id: 'nav.queue', title: '打开待你', category: '页面', aliases: ['daini', 'dn', 'dkdn'], keys: ['Alt+8'], run: () => actions.navigate('queue') },
    {
      id: 'session.new', title: '新开一件事', category: '页面', aliases: ['xinkai', 'xk', 'xhh'], keys: ['Ctrl+N'],
      run: () => { actions.navigate('new'); actions.requestFocus('composer'); },
    },
    { id: 'settings.open', title: '设置', category: '页面', aliases: ['shezhi', 'sz'], keys: ['Ctrl+,'], run: () => actions.navigate('settings') },
    { id: 'nav.toggle', title: '收起或展开侧栏', category: '界面', aliases: ['cebian', 'cl'], keys: ['Ctrl+B'], run: () => actions.toggleNav() },
    { id: 'console.toggle', title: '展开或收起控制台', category: '界面', aliases: ['kongzhitai', 'kzt'], keys: ['Ctrl+`'], run: () => actions.toggleConsole() },
    {
      id: 'peek.toggle', title: '赏图（淡出界面看壁纸）', category: '界面', aliases: ['shangtu', 'st'], keys: ['Alt+W'], peek: true,
      enabled: () => store.get().settings.wallpaper || !!store.get().peek,
      run: () => actions.togglePeek(!store.get().peek),
    },
    {
      // Esc 分层，最内层优先：对话框与菜单自己处理（它们先拿到事件）；这里只管赏图与状态抽屉.
      id: 'layer.close', title: '关闭赏图或状态抽屉', category: '界面', keys: ['Escape'], peek: true,
      enabled: () => { const s = store.get(); return !!s.peek || (s.statusDrawerOpen && !s.dialog); },
      run: () => { if (store.get().peek) actions.togglePeek(false); else actions.toggleStatusDrawer(false); },
    },
    { id: 'voice.closer', title: '靠近些', category: '她', aliases: ['kaojinxie', 'kjx'], enabled: () => levelNow() !== 'l' || '已经是最近的一档', run: () => actions.setLevel(LEVELS[Math.min(2, LEVELS.indexOf(levelNow()) + 1)]) },
    { id: 'voice.farther', title: '远一点', category: '她', aliases: ['yuanyidian', 'yyd'], enabled: () => levelNow() !== 's' || '已经是最远的一档', run: () => actions.setLevel(LEVELS[Math.max(0, LEVELS.indexOf(levelNow()) - 1)]) },
    // 请她安静 = 角色口吻关（只说事实）；正常说 = 开. 与「安静一小时」不是一回事.
    { id: 'voice.plain', title: '请她安静（只说事实）', category: '她', aliases: ['qingtaanjing', 'qtaj'], enabled: () => store.get().settings.persona !== false || '已经只说事实了', run: () => actions.setPersona(false) },
    { id: 'voice.normal', title: '正常说', category: '她', aliases: ['zhengchangshuo', 'zcs'], enabled: () => store.get().settings.persona === false || '已经是正常说话了', run: () => actions.setPersona(true) },
    // 安静一小时：同一个命令与右栏按钮；再用一次解除.
    { id: 'voice.quiet', title: '安静一小时', category: '她', aliases: ['anjingyixiaoshi', 'ajyxs'], run: () => actions.quietFor((store.get().quietUntil ?? 0) > Date.now() ? 0 : 60) },
    { id: 'voice.noProactive', title: '别主动说话', category: '她', aliases: ['biezhudongshuohua', 'bzdsh'], enabled: () => store.get().settings.proactive !== 'off' || '她已经不会主动说话了', run: () => actions.setProactive('off') },
    { id: 'voice.proactive', title: '允许她主动说话', category: '她', aliases: ['yunxutazhudongshuohua', 'yxtzdsh'], enabled: () => store.get().settings.proactive === 'off' || '她本来就可以主动说话', run: () => actions.setProactive('auto') },
    {
      id: 'voice.fold', title: '折叠她的话', category: '她', aliases: ['zhedietadehua', 'zdtdh'],
      enabled: () => !!store.get().selectedTaskId && store.get().view === 'task' || '先打开一个任务',
      run: () => { const id = store.get().selectedTaskId; if (id) actions.toggleFold(id); },
    },
  );
  return list;
}
for (const c of defaults()) registerCommand(c);

/** App.tsx 调用一次：安装全局键盘处理. 命中时 preventDefault 并 stopImmediatePropagation，
 *  这样萤火留在 App.tsx 里的旧处理（B1 删除之前）不会再重复执行一次. */
export function useCommandKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = resolveCommand(e, commands(), { peek: !!store.get().peek });
      if (!cmd) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cmd.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
