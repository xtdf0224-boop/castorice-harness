// 权限模式的映射与钩子决定。纯函数：不引用 Electron、不读文件、不联网，check-engine 直接测。
//
// 页面的权限模式（PermissionMode）：ask 逐项 / acceptEdits 接受编辑 / plan 计划 / auto 自动 / bypass 放手。
// 一、Claude（SDK）：全部有对应的 SDK 模式；auto 若 claude 不认，就地降级并说明。
// 二、其他引擎：能映射的映射，做不到的发 notice「已降级」。
// 三、PreToolUse 钩子（放行主路径）的决定：deny / ask / 不表态。钩子在引擎所有判定之前运行，
//     bypassPermissions / auto 下也生效（X17 探针已验证）；钩子自己出错必须当 deny（探针：回调抛异常＝"没表态"，会放行）。

/* ───────────── 工具分类（与 src/lib/providers.ts 的 toolCategory 逐条一致，check-engine 对表） ───────────── */

function toolCategory(name, input) {
  const n = String(name || '').toLowerCase();
  const cmd = input && typeof input.command === 'string' ? input.command.trim() : '';
  const b = n.match(/browser_(navigate|snapshot|scroll|back|screenshot|wait|click|type|press)/);
  if (b) return ['click', 'type', 'press', 'navigate', 'back'].includes(b[1]) ? 'browser_act' : 'browser_read';
  if (/^(bash|powershell|shell|execute|run_shell_command|exec_command|local_shell)$/.test(n)) return /^git(\s|$)/.test(cmd) && !/[;&|<>`$\n\r]/.test(cmd) ? 'git' : 'shell';
  if (/^(read|notebookread|read_file|read_many_files)$/.test(n)) return 'read_file';
  if (/^(write|edit|multiedit|notebookedit|apply_patch|write_file|replace|edit_file)$/.test(n)) return 'write_file';
  if (/^(grep|glob|ls|search|code_search|list_directory|search_file_content|find)$/.test(n)) return 'code_search';
  if (/^(websearch|web_search|google_web_search)$/.test(n)) return 'web_search';
  if (/^(webfetch|web_fetch|fetch)$/.test(n)) return 'web_fetch';
  return 'other';
}

/* ───────────── Claude：页面模式 → SDK 模式 ───────────── */

const PAGE_MODES = ['ask', 'acceptEdits', 'plan', 'auto', 'bypass'];
const MODE_LABEL = { ask: '逐项', acceptEdits: '接受编辑', plan: '计划', auto: '自动', bypass: '放手' };

/**
 * @param {string} pageMode  页面的权限模式（缺省 ask）
 * @param {{ phase?: 'plan'|'step'|'chat', readOnly?: boolean }} o
 *   phase 'plan'：这一轮只出计划。页面选了「计划」→ 用 SDK 原生计划模式（只读调研）；其余模式用 default＋钩子强制只读。
 *   phase 'step'：执行一步。页面选了「计划」→ 批准之后按逐项（default）执行。
 *   readOnly：目录未信任（T0）或只读任务 → 一律 default（自动放行类的模式没意义，钩子也会挡写入）。
 * @returns {{ mode: 'default'|'acceptEdits'|'plan'|'auto'|'bypassPermissions', bypass: boolean, note?: string }}
 */
function sdkModeFor(pageMode, o = {}) {
  const m = PAGE_MODES.includes(pageMode) ? pageMode : 'ask';
  const phase = o.phase || 'step';
  if (phase === 'plan') {
    return { mode: m === 'plan' ? 'plan' : 'default', bypass: false };
  }
  if (o.readOnly) {
    return { mode: 'default', bypass: false, note: m === 'ask' || m === 'plan' ? undefined : `这次只读运行，「${MODE_LABEL[m]}」不适用，按逐项处理。` };
  }
  switch (m) {
    case 'acceptEdits': return { mode: 'acceptEdits', bypass: false };
    case 'auto': return { mode: 'auto', bypass: false };
    case 'bypass': return { mode: 'bypassPermissions', bypass: true };
    default: return { mode: 'default', bypass: false };
  }
}

/** claude 报告的实际模式与请求不同（版本不认 auto 等）时的说明；一致返回 undefined。 */
function sdkModeMismatchNote(requested, actual) {
  if (!requested || !actual || requested === actual) return undefined;
  if (requested === 'auto') return `这个版本的 claude 没有「自动」模式，已降级为「${actual === 'default' ? '逐项' : actual}」。`;
  if (requested === 'bypassPermissions') return `「放手」没有生效（claude 报告的模式是 ${actual}），仍按该模式处理。`;
  return `权限模式与请求不同：请求 ${requested}，实际 ${actual}。`;
}

/* ───────────── 其他引擎：能映射的映射，做不到的如实降级 ───────────── */

/**
 * Codex（exec，approval_policy=never）：只能选沙箱。
 * @param {string} pageMode
 * @param {'read-only'|'workspace-write'|'danger-full-access'} baseSandbox 页面按工具策略/用户设置给的沙箱
 */
function codexPlan(pageMode, baseSandbox) {
  const m = PAGE_MODES.includes(pageMode) ? pageMode : 'ask';
  if (m === 'plan') return { sandbox: 'read-only', note: undefined };
  if (m === 'ask') return { sandbox: baseSandbox, note: 'Codex 的无头模式不能逐项确认，已按沙箱策略执行（已降级）。' };
  if (m === 'acceptEdits') return { sandbox: baseSandbox, note: baseSandbox === 'read-only' ? undefined : 'Codex 没有「只接受编辑」：工作文件夹内的编辑和命令都按沙箱放行（已降级）。' };
  if (m === 'auto') return { sandbox: baseSandbox, note: 'Codex 没有自动分类器，已按沙箱策略执行（已降级）。' };
  return { sandbox: baseSandbox, note: baseSandbox === 'danger-full-access' ? undefined : '「放手」在 Codex 上受沙箱限制：没有放开到整台电脑（已降级）；要放开请在模型接入里改 Codex 沙箱。' };
}

/** DeepSeek Harness（无头）：只有 read-only 可以强制，其余是它自己的默认。 */
function dshPlan(pageMode) {
  const m = PAGE_MODES.includes(pageMode) ? pageMode : 'ask';
  if (m === 'plan') return { env: { DSH_PERMISSION_MODE: 'read-only' }, note: undefined };
  return { env: {}, note: `DeepSeek Harness 的无头模式不能逐项确认，「${MODE_LABEL[m]}」按它自己的权限配置执行（已降级）。` };
}

/* ───────────── ACP 代理的定义（catalog/acp-agents.json 的 perm 字段，MODELS-SPEC §10.4） ───────────── */

let catalogAgents = null;
/** 目录里的代理定义（静态 JSON，随版本发布）；没有这个 id 返回 undefined。 */
function catalogAgent(id) {
  if (!catalogAgents) {
    try { catalogAgents = new Map(require('./catalog/acp-agents.json').map((a) => [a.id, a])); } catch { catalogAgents = new Map(); }
  }
  return typeof id === 'string' ? catalogAgents.get(id) : undefined;
}
/** 传进来的可以是代理 id（目录里的）或主进程自己组装的定义对象（用户登记的代理）；页面传不进这里。 */
const agentDef = (agent) => (agent && typeof agent === 'object' ? agent : catalogAgent(agent));

/**
 * 这个代理的权限模式是验证过的吗？只有 perm.level === 'verified' 且登记了 modeMap（现在只有 Kimi，实测 default / plan / auto / yolo）才算：
 * 只有它们才会被主进程切模式，也只有它们设不上只读相关的模式时才拒绝启动。其余代理不猜模式名。
 */
function acpVerified(agent) {
  const d = agentDef(agent);
  return !!d && !!d.perm && d.perm.level === 'verified' && !!d.perm.modeMap && typeof d.perm.modeMap === 'object' && Object.keys(d.perm.modeMap).length > 0;
}

/** 提示语里用的短名（目录里的 label 是 Kimi Code CLI，旧文案一直写「Kimi」）。 */
const SHORT_NAME = { kimi: 'Kimi' };

/**
 * ACP 客户端：创建 / 恢复会话后选模式（配置选项里的 mode 类，或旧的 session/set_mode）。
 * 只有代理定义里 perm.level 为 verified 并给了 modeMap 的才映射（Kimi 实测有 default / plan / auto / yolo）；
 * 其余代理（Qwen、MiniMax、Gemini……）不去猜它们的模式名，如实说「未验证」。
 * @param {string|object} agent 代理 id（目录里的）或代理定义
 * @param {string} pageMode
 * @param {string[]|undefined} available 会话返回的可用模式 id；未知传 undefined
 * @returns {{ modeId?: string, note?: string }}
 */
function acpPlan(agent, pageMode, available) {
  const m = PAGE_MODES.includes(pageMode) ? pageMode : 'ask';
  if (!acpVerified(agent)) {
    return m === 'ask' ? { modeId: undefined, note: undefined } : { modeId: undefined, note: `这个命令行工具的权限模式没有验证过，「${MODE_LABEL[m]}」未生效，按它的默认逐项确认（未验证）。` };
  }
  const def = agentDef(agent);
  const map = def.perm.modeMap;
  const name = SHORT_NAME[def.id] || def.label || def.id;
  const want = map[m];
  // 没有单独的「只接受编辑」：登记的模式和「逐项」是同一个（或没登记）→ 按逐项，并说明
  if (m === 'acceptEdits' && (!want || want === map.ask)) return { modeId: map.ask, note: `${name} 没有「只接受编辑」，按逐项确认处理（已降级）。` };
  if (!want) return { modeId: undefined, note: `${name} 没有登记「${MODE_LABEL[m]}」对应的模式，按它的默认处理（已降级）。` };
  if (available && !available.includes(want)) return { modeId: undefined, note: `${name} 这次没有提供「${want}」模式，按它的默认处理（已降级）。` };
  return { modeId: want, note: m === 'auto' || m === 'bypass' ? `${name} 在这个模式下手套只记账、不拦截（已降级）。` : undefined };
}

/**
 * 其余引擎（Codex / DSH / ACP）要用的“有效模式”：页面选了「计划」时，只有计划阶段只读；
 * 计划批准之后的执行阶段按逐项（ask）处理——与 sdkModeFor（计划＋执行 → default）一致。
 * 否则批准之后每一步还在 read-only 沙箱 / DSH 只读 / Kimi plan 模式里，写不了文件也跑不了命令.
 * @returns {string|undefined} PAGE_MODES 里的一个；页面没给就是 undefined
 */
function effectiveMode(pageMode, phase) {
  const m = PAGE_MODES.includes(pageMode) ? pageMode : undefined;
  return m === 'plan' && phase !== 'plan' ? 'ask' : m;
}

/* ───────────── 旧 stream-json 驱动（claude-compat / 关掉 SDK / SDK 启动失败后的回退） ───────────── */

/** 旧驱动没有钩子：只读（T0 / 只读任务 / 计划阶段）时，主进程自己把这些工具并入禁用名单. */
const READ_ONLY_DENY_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'];
const WRITE_OR_CMD_RULE = /^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)(\(|$)/;

/** 旧驱动的权限模式：只有 default / acceptEdits 能如实对应，其余按逐项并说明。 */
function legacyMode(pageMode, phase) {
  if (pageMode === 'acceptEdits' && phase !== 'plan') return { mode: 'acceptEdits' };
  if (!pageMode || pageMode === 'ask') return { mode: 'default' };
  return { mode: 'default', note: `旧驱动不支持「${MODE_LABEL[pageMode] || pageMode}」，这次按逐项确认处理（已降级）。` };
}

/**
 * 旧驱动的工具名单与权限模式。页面给的 allow / deny 只是“页面以为的级别”；信任账本（T0）与只读任务是主进程说了算：
 * readOnly（或计划阶段）时写入 / 命令类工具并入 deny、从 allow 剔除、权限模式强制 default（acceptEdits 会让 claude 自己批准编辑）.
 * @returns {{ allow: string[], deny: string[], mode: 'default'|'acceptEdits', note?: string }}
 */
function legacyPolicy({ allow = [], deny = [], pageMode, phase, readOnly }) {
  const ro = !!readOnly || phase === 'plan';
  // 旧驱动没有钩子也没有提问卡：AskUserQuestion / ExitPlanMode 仍然关掉
  const denyList = [...new Set([...deny, 'AskUserQuestion', 'ExitPlanMode', ...(ro ? READ_ONLY_DENY_TOOLS : [])])];
  const base = legacyMode(pageMode, phase);
  if (!ro) return { allow, deny: denyList, mode: base.mode, note: base.note };
  const note = readOnly
    ? (pageMode && pageMode !== 'ask' && pageMode !== 'plan' ? `这次只读运行，「${MODE_LABEL[pageMode] || pageMode}」不适用，按逐项处理。` : undefined)
    : base.note;
  return { allow: allow.filter((t) => !WRITE_OR_CMD_RULE.test(t)), deny: denyList, mode: 'default', note };
}

/* ───────────── 钩子决定 ───────────── */

/** 不动文件也不对外的内部工具：钩子一律不表态。 */
const INTERNAL_TOOLS = new Set([
  'askuserquestion', 'exitplanmode', 'enterplanmode', 'toolsearch', 'todowrite', 'taskcreate', 'taskupdate', 'tasklist', 'taskget', 'taskstop', 'taskoutput',
  'skill', 'listagents', 'reportfindings', 'agent', 'task', 'sendmessage',
]);
/** 只读任务（T0 / 只读 / 计划阶段）里仍允许的"其他"工具。 */
const READ_OK_CATEGORIES = new Set(['read_file', 'code_search', 'web_search', 'web_fetch', 'browser_read']);

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'absolute_path', 'dir_path', 'directory'];

/**
 * 词法解析一个路径（不碰文件系统）：统一斜杠、转小写，按段处理 . 与 ..。
 * kind：'abs' 绝对（盘符 / 根 / UNC，canon 是规范化后的整串）、'rel' 相对（escapes = 用 .. 跳出了起点）、
 *       'home' ~ 开头、'driverel' 盘符相对（D:evil.txt，相对 D 盘的当前目录，位置不可知）。
 * 之前只做字符串前缀比较：`G:/work/proj/../../x` 因为以 `g:/work/proj/` 开头被当成界内。
 */
function lexResolve(p) {
  const n = String(p).trim().replace(/\\/g, '/').toLowerCase();
  if (/^[a-z]:(?!\/)/.test(n)) return { kind: 'driverel' };
  let kind = 'rel';
  let prefix = '';
  let rest = n;
  if (/^[a-z]:\//.test(n)) { kind = 'abs'; prefix = n.slice(0, 3); rest = n.slice(3); }
  else if (n.startsWith('//')) { kind = 'abs'; prefix = '//'; rest = n.slice(2); }
  else if (n.startsWith('/')) { kind = 'abs'; prefix = '/'; rest = n.slice(1); }
  else if (n.startsWith('~')) return { kind: 'home' };
  const stack = [];
  let escapes = false;
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); else escapes = true; continue; }
    stack.push(seg);
  }
  return { kind, escapes, canon: prefix + stack.join('/') };
}

/** v 是不是在 roots（已 lexResolve 过的绝对根）之内。相对路径按 cwd 解析，而 cwd 就是界内的根：不跳出去就算界内；strict 时相对路径一律算界外. */
function pathInside(v, roots, strict) {
  const r = lexResolve(v);
  if (r.kind === 'rel') return !strict && !r.escapes;
  if (r.kind !== 'abs') return false;
  return roots.some((root) => r.canon === root.canon || r.canon.startsWith(root.canon.endsWith('/') ? root.canon : `${root.canon}/`));
}
const absRoots = (roots) => (roots || []).filter((r) => typeof r === 'string' && r.trim()).map(lexResolve).filter((r) => r.kind === 'abs');

/** Glob / ls 的 pattern、Grep 的 glob 过滤器也是路径：`C:/Users/**`、`../../**`、`~/*` 都会读到工作文件夹之外。只看通配符之前的那段. */
const GLOB_TOOLS = /^(glob|ls|find|list_directory)$/;
function globEscapes(v, rs) {
  const prefix = String(v).replace(/\\/g, '/').split(/[*?[{]/)[0].trim();
  if (!prefix) return false; // `**/*.ts`: relative to the working folder
  return !pathInside(prefix, rs, false);
}

/** 工具输入里第一个落在 roots 之外的路径；没有返回 ''。 `tool`（小写）：Glob 之类还要看 pattern，Grep 还要看 glob. */
function outsideRoots(input, roots, tool) {
  if (!input || typeof input !== 'object') return '';
  const rs = absRoots(roots);
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (!pathInside(v, rs, false)) return v;
  }
  const globKey = GLOB_TOOLS.test(String(tool || '')) ? 'pattern' : String(tool || '') === 'grep' ? 'glob' : '';
  if (globKey && typeof input[globKey] === 'string' && input[globKey].trim() && globEscapes(input[globKey], rs)) return input[globKey];
  return '';
}

/** 严格界内：至少有一个路径，且每个路径都是绝对路径、规范化之后位于 roots 之内（相对路径不算）。原生计划模式的“计划文件可写”例外用它. */
function strictlyInside(input, roots) {
  if (!input || typeof input !== 'object') return false;
  const rs = absRoots(roots);
  let seen = false;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    seen = true;
    if (!pathInside(v, rs, true)) return false;
  }
  return seen;
}

/** deny 清单里"只有名字"的条目（带括号的内容规则交给 claude 自己匹配，钩子不替它猜）。 */
function plainNames(list) {
  return new Set((list || []).filter((t) => typeof t === 'string' && !t.includes('(')).map((t) => t.toLowerCase()));
}

/**
 * @param {{
 *   mode: string,              // SDK 模式
 *   readOnly: boolean,         // T0 / 只读任务 / 计划阶段
 *   readOnlyWhy?: string,      // 给模型看的原因
 *   deny?: string[],           // 工具策略里关掉的工具
 *   roots?: string[],          // 界内目录（工作文件夹、技能文件夹…）
 *   planRoot?: string,         // 原生计划模式下计划文件所在目录（允许写）
 *   stopped?: boolean,         // 使用者已取消 / 中断这一轮：一律 deny
 *   onlyTools?: Set<string>,   // 小写的工具名：只有这些能用，别的一律 deny（桌宠联网答疑）
 * }} ctx
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @returns {{ decision: 'deny'|'ask'|'none', reason?: string }}
 */
function hookDecision(ctx, toolName, toolInput) {
  const name = String(toolName || '');
  const lower = name.toLowerCase();
  // 只放行名单里的工具（桌宠的联网答疑只有 WebSearch / WebFetch）：别的一律拒绝，包括内部工具；不靠页面，不弹确认.
  if (ctx.onlyTools && !ctx.onlyTools.has(lower)) return { decision: 'deny', reason: `这次运行只能用 ${[...ctx.onlyTools].join(' / ')}：不能用「${name}」。` };
  if (INTERNAL_TOOLS.has(lower)) return { decision: 'none' };
  // 使用者已经取消 / 中断这一轮：不管什么模式，不再放行任何新的操作（放手 / 自动 / 接受编辑下 claude 自己不会再问）
  if (ctx.stopped) return { decision: 'deny', reason: '这次运行已经被使用者停止了，请不要再执行任何操作。' };
  if (plainNames(ctx.deny).has(lower)) return { decision: 'deny', reason: `「${name}」在栖枝的「工具与技能」里已关闭。请不要用它，换一种做法。` };

  const category = toolCategory(name, toolInput);
  if (ctx.readOnly) {
    // 计划文件例外只给“绝对路径且规范化之后在计划目录里”的写入；相对路径、`plans/../settings.json` 一律不算.
    const planFile = ctx.mode === 'plan' && ctx.planRoot && category === 'write_file' && strictlyInside(toolInput, [ctx.planRoot]);
    if (!planFile && !READ_OK_CATEGORIES.has(category)) {
      return { decision: 'deny', reason: `${ctx.readOnlyWhy || '这次运行是只读的'}：不能执行「${name}」。请只用读取类工具，需要改动时先把方案告诉使用者。` };
    }
  }
  // 越界：自动放行类的模式（acceptEdits / auto / bypassPermissions）下 claude 自己不会问，钩子替它问。
  // 原生计划模式里计划文件在 <配置目录>/plans/ 下，算界内。
  const roots = ctx.mode === 'plan' && ctx.planRoot ? [...(ctx.roots || []), ctx.planRoot] : (ctx.roots || []);
  const away = outsideRoots(toolInput, roots, lower);
  if (away) return { decision: 'ask', reason: `这次要访问工作文件夹以外的位置：${away}。` };
  return { decision: 'none' };
}

/** 把 hookDecision 包成 SDK 的 PreToolUse 回调；出任何错都当 deny（探针：回调抛异常 = 没表态 = 照常放行）。 */
function makePreToolUseHook(ctx, onDecision) {
  return async (input) => {
    let d;
    try {
      d = hookDecision(ctx, input && input.tool_name, input && input.tool_input);
    } catch (e) {
      d = { decision: 'deny', reason: `栖枝的权限钩子出错了（${String(e && e.message || e).slice(0, 80)}），为安全起见已拒绝这次调用。` };
    }
    try { if (onDecision) onDecision(input, d); } catch { /* 记账失败不影响决定 */ }
    if (d.decision === 'none') return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
  };
}

module.exports = {
  PAGE_MODES, MODE_LABEL, toolCategory, sdkModeFor, sdkModeMismatchNote, codexPlan, dshPlan, acpPlan, acpVerified, agentDef, effectiveMode, legacyMode, legacyPolicy, READ_ONLY_DENY_TOOLS,
  INTERNAL_TOOLS, outsideRoots, strictlyInside, hookDecision, makePreToolUseHook,
};
