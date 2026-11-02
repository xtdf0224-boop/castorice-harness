/* 桌宠设置页的输入检查（热键、程序名、整数）：纯函数，没有 React、没有样式，scripts/pet-brain-check.ts 才能单独测它.
   热键按 Electron globalShortcut 的读法：至少一个修饰键（Ctrl / Alt / Win）加一个普通键，不抢复制粘贴、关窗口、切窗口这类到处在用的组合
   （主进程注册时也会同样拒绝）. 从萤火的 petInput.ts 移植. */

export type Checked = { ok: true; value: string } | { ok: false; error: string };
const fail = (error: string): Checked => ({ ok: false, error });

/* Electron 认的写法 → 它的规范名. Windows 没有 Command / Option 键，所以拒绝. */
const MODIFIER: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', shift: 'Shift',
  super: 'Super', meta: 'Super', win: 'Super', windows: 'Super',
};
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const NOT_ON_WINDOWS = new Set(['command', 'cmd', 'option', 'altgr']);
const KEY: Record<string, string> = {
  space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  printscreen: 'PrintScreen', plus: 'Plus',
  numdec: 'numdec', numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv',
};
/* 不带 Shift 的标点键；「+」是分隔符，加号键写 Plus. */
const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);
/* 全局热键绝不能抢的组合：会让复制粘贴、切窗口到处失灵. */
const RESERVED = new Set([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+S', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+F', 'Ctrl+N', 'Ctrl+T', 'Ctrl+P', 'Ctrl+Shift+T',
  'Alt+F4', 'Alt+Tab', 'Alt+Space', 'Alt+Escape', 'Alt+Enter', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Delete',
  'Super+L', 'Super+D', 'Super+E', 'Super+R', 'Super+Tab', 'Super+V',
]);

function keyName(t: string): string | undefined {
  if (/^[a-z0-9]$/i.test(t)) return t.toUpperCase();
  const f = /^f(\d{1,2})$/i.exec(t);
  if (f && +f[1] >= 1 && +f[1] <= 24) return `F${+f[1]}`;
  const n = /^num([0-9])$/i.exec(t);
  if (n) return `num${n[1]}`;
  const named = KEY[t.toLowerCase()];
  if (named) return named;
  return PUNCTUATION.has(t) ? t : undefined;
}

/** 按 Electron globalShortcut 的读法检查一个热键，返回规范写法（"alt + f" → "Alt+F"）. */
export function parseAccelerator(raw: string): Checked {
  const text = raw.trim();
  if (!text) return fail('热键不能为空');
  const parts = text.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return fail('写法是「修饰键+按键」，例如 Ctrl+Alt+B');
  const key = keyName(parts[parts.length - 1]);
  const mods = new Set<string>();
  for (const m of parts.slice(0, -1)) {
    const lower = m.toLowerCase();
    if (NOT_ON_WINDOWS.has(lower)) return fail(`Windows 上没有「${m}」键，请用 Ctrl、Alt、Shift 或 Win`);
    const name = MODIFIER[lower];
    if (!name) return fail(`「${m}」不是修饰键。修饰键有 Ctrl、Alt、Shift、Win，按键写在最后`);
    mods.add(name);
  }
  if (!key) return fail(`「${parts[parts.length - 1]}」不是可用的按键：用字母、数字、F1–F24、方向键等`);
  // 只有 Shift 只会改变打出来的字母；全局热键绑在它上面会吃掉平时的打字.
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Super')) return fail('至少要带 Ctrl、Alt 或 Win 之一，否则会抢走平时的打字');
  const value = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  if (RESERVED.has(value)) return fail(`${value} 是系统或常用快捷键，换一个组合`);
  return { ok: true, value };
}

export const MAX_NAMES = 200;

/** 名单里存的程序：小写的文件名（"C:\Games\StarRail.exe" → "starrail.exe"，"starrail" → "starrail.exe"）. */
export function parseExe(raw: string): Checked {
  let s = raw.trim().replace(/^["']+|["']+$/g, '');
  s = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1).trim().toLowerCase();
  if (!s) return fail('请填程序名，例如 starrail.exe');
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) return fail('程序名里有不能用的字符');
  if (/\.(lnk|url|bat|cmd|msi|dll|com|ps1)$/.test(s)) return fail('要填程序本身的 .exe 文件名，不是快捷方式或脚本');
  if (!s.endsWith('.exe')) s += '.exe';
  if (s === '.exe') return fail('请填程序名，例如 starrail.exe');
  if (s.length > 100) return fail('程序名太长了');
  return { ok: true, value: s };
}

/** 夹在 lo–hi 之间的整数（离开输入框后显示的就是它）. */
export function parseIntIn(lo: number, hi: number) {
  return (raw: string): Checked => {
    const text = raw.trim();
    const n = Number(text);
    if (!text || !Number.isFinite(n)) return fail('请输入数字');
    return { ok: true, value: String(Math.min(hi, Math.max(lo, Math.round(n)))) };
  };
}

