// 被测应用的差异：萤火 v2.0.0（基线）与栖枝（被测）在桥名、localStorage 键、设置字段上不同。
import fs from 'node:fs';
import path from 'node:path';

export const TARGETS = {
  ff: {
    id: 'ff', name: '萤火 v2.0.0', bridge: 'fireflyDesktop',
    keys: { state: 'firefly-harness/v1', prefs: 'firefly-harness/prefs' },
    titleSuffix: '萤火',
    /** 把主题设成「默认」的设置字段（截图用）。 */
    themeSetting: (theme) => ({ mode: theme === 'day' ? 'sam' : 'firefly' }),
  },
  alight: {
    id: 'alight', name: '栖枝', bridge: 'alightDesktop',
    keys: { state: 'alight/v1', prefs: 'alight/prefs' },
    titleSuffix: '栖枝',
    themeSetting: (theme) => ({ mode: theme === 'day' ? 'day' : 'night' }),
  },
};

/** 主输入框（首页与任务页的 PromptBox 都是这个类名；两个版本相同）。 */
export const INPUT_SELECTOR = 'textarea.pbox__input';

export function detectTarget(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    if (pkg.name === 'firefly-harness') return TARGETS.ff;
    if (pkg.name === 'alight-desk') return TARGETS.alight;
  } catch { /* 默认栖枝 */ }
  return TARGETS.alight;
}

export function readPackage(appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')); } catch { return {}; }
}
