/* 高风险操作的「两步确认」：第一步「放行…」→ 第二步「确认放行」（待批卡、「待你」里的待批行共用）。
   两步是同一个位置、同一种按钮，所以光靠换文案挡不住手滑：双击的第二下、按住 Enter 的重复事件会直接落在刚换好的「确认」上。
   这里补三道：
     · 进入第二步后焦点离开按钮（回到卡片，见组件）——按住 Enter 的重复按键到不了「确认」，要确认得再 Tab 过去或再点；
     · 第一步之后的 guardMs 内，第二步的点击一律不算（双击 / 触屏连点）；
     · 超过 timeoutMs 没有第二次点击，退回第一步（超时是取消，不是采纳）。
   判断本身是个小状态机（createTwoStep），不依赖渲染，闭包里的旧值也不会放行；check-interaction 用假时钟直接测它。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 第一步之后这么久之内的“确认”点击当作手滑 / 重复，不算数. */
export const ARM_GUARD_MS = 500;
/** 第一步之后这么久没有第二次点击，退回第一步. */
export const ARM_TIMEOUT_MS = 5000;

export type TwoStepPress = 'arm' | 'confirm' | 'ignore';

export function createTwoStep(opts: { guardMs?: number; timeoutMs?: number; now?: () => number } = {}) {
  const guardMs = opts.guardMs ?? ARM_GUARD_MS;
  const timeoutMs = opts.timeoutMs ?? ARM_TIMEOUT_MS;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let armedAt: number | null = null;
  return {
    /** 按了一次按钮：第一次 → 'arm'；来得太快 → 'ignore'（仍在第二步）；够慢 → 'confirm'（回到第一步）；超时之后再按 → 又是 'arm'. */
    press(): TwoStepPress {
      const t = now();
      if (armedAt !== null && t - armedAt > timeoutMs) armedAt = null;
      if (armedAt === null) { armedAt = t; return 'arm'; }
      if (t - armedAt < guardMs) return 'ignore';
      armedAt = null;
      return 'confirm';
    },
    reset() { armedAt = null; },
  };
}

/** 组件用：armed 控制按钮文案；press() 给出该做什么. */
export function useTwoStep(timeoutMs = ARM_TIMEOUT_MS) {
  const machine = useMemo(() => createTwoStep({ timeoutMs }), [timeoutMs]);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  useEffect(() => {
    if (!armed) return undefined;
    const t = window.setTimeout(() => { machine.reset(); armedRef.current = false; setArmed(false); }, timeoutMs);
    return () => window.clearTimeout(t);
  }, [armed, machine, timeoutMs]);

  /** card：进入第二步时把焦点交回去的容器（需要 tabIndex={-1}）. */
  const press = useCallback((card?: HTMLElement | null): TwoStepPress => {
    const r = machine.press();
    if (r === 'arm') { armedRef.current = true; setArmed(true); card?.focus({ preventScroll: true }); }
    else if (r === 'confirm') { armedRef.current = false; setArmed(false); }
    return r;
  }, [machine]);

  return { armed, press };
}
