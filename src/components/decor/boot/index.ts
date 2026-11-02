/* 开屏场景入口：夜 / 昼两版，同一个接口（bootTypes.ts 的 BootScene）。 */
import { createDayScene } from './dayScene';
import { createNightScene } from './nightScene';
import type { BootScene, BootTheme, SceneOptions } from './bootTypes';

export type { BootScene, BootTheme, SceneOptions } from './bootTypes';
export { BootPlayer } from './player';
export { aspectOk } from './bootMath';
export { SOFT_MS, TR_FAST, TR_FULL, beginTransition, trDuration, type TransitionRun } from './transition';
export type { TransitionKind } from './bootTypes';

export function createBootScene(theme: BootTheme, o: SceneOptions): BootScene {
  return theme === 'day' ? createDayScene(o) : createNightScene(o);
}

