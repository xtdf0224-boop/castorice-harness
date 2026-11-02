// The pet's two global hotkeys: open (or close) the chat panel, and pause / resume watching.
const { globalShortcut } = require('electron');

/** Holding a hotkey down repeats it (after Windows' repeat delay, 250–1000 ms, many times a second), and both hotkeys are
 *  toggles: a press this soon after the last one (or after the last repeat) is the same press. */
const REPEAT_MS = 800;

/** What we registered, per key: { wanted, active (the combination registered now, '' if none), error }, and the
 *  callbacks (so unchanged settings leave the registration alone). */
let applied = null;
const NONE = { ok: true, errors: [], ask: false, pause: false };
let lastResult = NONE;

function clear() {
  if (applied) {
    for (const key of ['ask', 'pause']) {
      const a = applied[key];
      if (a && a.active) { try { globalShortcut.unregister(a.active); } catch { /* already gone */ } }
    }
  }
  applied = null;
  lastResult = NONE;
}

/** fn, once per press: the repeats of a held key (and a bounce right after) do nothing. */
function oncePerPress(fn) {
  let last = 0;
  return () => {
    const t = Date.now();
    const again = t - last < REPEAT_MS;
    last = t;
    if (!again) fn();
  };
}

/** Register one combination: '' when it took, else why not. */
function take(label, accelerator, fn) {
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, fn);
  } catch {
    return `${label}快捷键「${accelerator}」格式不对。`;
  }
  return ok ? '' : `${label}快捷键 ${accelerator} 注册失败，可能被别的程序占用了。`;
}

/* ───────────── what may be a global hotkey ───────────── */
// A global hotkey takes the combination away from every program. A bare key (or Shift + a letter) would stop all typing,
// and the editing keys (Ctrl+C…) and the system's own would break copy / paste and the desktop. So: at least one of
// Ctrl / Alt / Win, and a plain key besides, and not one of the combinations below.

const MODS = {
  ctrl: 'ctrl', control: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl',
  alt: 'alt', option: 'alt', altgr: 'alt',
  shift: 'shift',
  super: 'win', meta: 'win', win: 'win', windows: 'win', cmd: 'win', command: 'win',
};
/** With Ctrl (and maybe Shift) only: the editing keys every program uses. */
const EDIT_KEYS = new Set(['c', 'v', 'x', 'z', 'a', 'y']);

/** '' when the combination may be registered, else a Chinese sentence saying why not (shown under the hotkey box). */
function badAccelerator(label, accelerator) {
  const parts = String(accelerator).split('+').map((p) => p.trim());
  const shape = `${label}快捷键「${accelerator}」格式不对。`;
  if (parts.length < 2 || parts.some((p) => !p)) {
    return parts.length === 1 && parts[0] && !MODS[parts[0].toLowerCase()]
      ? `${label}快捷键「${accelerator}」不能用：单独一个键会让所有程序都打不出它，至少要一个修饰键（Ctrl / Alt / Win）加一个普通键。`
      : shape;
  }
  const key = parts[parts.length - 1].toLowerCase();
  const mods = new Set(parts.slice(0, -1).map((p) => MODS[p.toLowerCase()]));
  if (mods.has(undefined)) return shape;
  if (MODS[key]) return `${label}快捷键「${accelerator}」不能用：除了修饰键，还要一个普通键。`;
  const strong = [...mods].filter((m) => m !== 'shift');
  if (!strong.length) return `${label}快捷键「${accelerator}」不能用：只有 Shift 会让所有程序都打不出大写，要加上 Ctrl、Alt 或 Win。`;
  const only = (...names) => strong.length === names.length && names.every((n) => mods.has(n));
  if (only('ctrl') && (EDIT_KEYS.has(key) || key === 'insert')) return `${label}快捷键「${accelerator}」不能用：这是复制、粘贴、撤销这类通用的编辑快捷键，别的程序要用。`;
  if (only('alt') && ['f4', 'tab', 'esc', 'escape', 'space'].includes(key)) return `${label}快捷键「${accelerator}」不能用：这是 Windows 自己的窗口快捷键。`;
  if (only('ctrl') && ['esc', 'escape'].includes(key)) return `${label}快捷键「${accelerator}」不能用：这是 Windows 自己的快捷键。`;
  if (only('ctrl', 'alt') && ['delete', 'del'].includes(key)) return `${label}快捷键「${accelerator}」不能用：这是 Windows 自己的快捷键。`;
  if (only('win') && ['l', 'd', 'e', 'r', 'tab', 'm', 'i', 'x', 'v', 'space'].includes(key)) return `${label}快捷键「${accelerator}」不能用：这是 Windows 自己的快捷键。`;
  return '';
}

function register(label, accelerator, fn, taken) {
  if (!accelerator) return { wanted: accelerator, active: '', error: null };
  const bad = badAccelerator(label, accelerator);
  if (bad) return { wanted: accelerator, active: '', error: bad };
  if (taken.has(accelerator.toLowerCase())) return { wanted: accelerator, active: '', error: `${label}快捷键 ${accelerator} 和另一个桌宠快捷键重复了。` };
  taken.add(accelerator.toLowerCase());
  const error = take(label, accelerator, fn);
  return { wanted: accelerator, active: error ? '' : accelerator, error: error || null };
}

/**
 * Register both hotkeys (replacing the previous ones). A new combination that cannot be registered leaves the one it
 * replaced working, if it still can be. Returns what could not be registered, and whether each key works as set
 * (`ask` / `pause`: false when not set, or not registered).
 */
function apply({ ask, pause }, { onAsk, onPause }) {
  const want = { ask: String(ask || '').trim(), pause: String(pause || '').trim() };
  // Same keys as last time and both took: nothing to redo.
  if (applied && applied.ask.wanted === want.ask && applied.pause.wanted === want.pause && !lastResult.errors.length) {
    applied.fns.ask = onAsk;
    applied.fns.pause = onPause;
    return lastResult;
  }
  const before = applied ? { ask: applied.ask.active, pause: applied.pause.active } : { ask: '', pause: '' };
  clear();
  const fns = { ask: onAsk, pause: onPause };
  // Indirect callbacks so a re-apply with new handlers does not need to re-register.
  const cbs = { ask: oncePerPress(() => fns.ask && fns.ask()), pause: oncePerPress(() => fns.pause && fns.pause()) };
  const labels = { ask: '呼出', pause: '暂停' };
  const taken = new Set();
  const keys = { ask: register(labels.ask, want.ask, cbs.ask, taken), pause: register(labels.pause, want.pause, cbs.pause, taken) };
  for (const key of ['ask', 'pause']) {
    const k = keys[key];
    const old = before[key];
    // The new combination did not take: the old one goes on working, unless it is the same or the other key has it now.
    if (k.active || !k.error || !old || old.toLowerCase() === k.wanted.toLowerCase() || taken.has(old.toLowerCase())) continue;
    if (!take(labels[key], old, cbs[key])) {
      k.active = old;
      k.error = `${k.error}暂时还用原来的 ${old}。`;
      taken.add(old.toLowerCase());
    }
  }
  applied = { ...keys, fns };
  const errors = [keys.ask.error, keys.pause.error].filter(Boolean);
  const works = (k) => !!k.active && k.active === k.wanted;
  lastResult = { ok: errors.length === 0, errors, ask: works(keys.ask), pause: works(keys.pause) };
  return lastResult;
}

module.exports = { apply, clear, badAccelerator };
