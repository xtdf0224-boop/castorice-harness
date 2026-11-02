/* Agent 页上她的话：取 V1 的 agents.* 场景（say2），带话量 / 夜昼 / 口吻（useSay2 已绑定）.
   · 场景缺 / 取到空串：按 `fallbacks` 依次再试（例：agents.busy.pipe → agents.busy）；
   · persona=false：say2 走 voice-facts；它没有这一条时用本文件里的朴素事实句（无口吻、无表情、无贴纸），页面不会出现空气泡；
   · persona=true 且各场景都取不到：返回空串，调用方不画气泡（不替她编台词）.
   她的话不带贴纸（D19）；表情只用来选页头头像的 expr. */
import { useMemo } from 'react';
import { voiceSeed, type Say2Opts, type Slots, useSay2 } from '../../../lib/voice';
import type { Agent, ExprId, Level } from '../../../lib/types';
import { useVoice } from '../../../state/selectors';

export interface HerLine { text: string; expr: ExprId }

/** 牌面与她的话里用的短名：「检索 Agent」→「检索」；编排 Agent 保持原名（遐蝶 / 编排 Agent）. */
export const shortName = (a: Pick<Agent, 'id' | 'name'>): string => (a.id === 'orchestrator' ? a.name : a.name.replace(/\s*Agent$/i, '') || a.name);

/** persona=false 时的事实版（V1 的 voice-facts 没有对应条目时才用）. 只写事实，不加口吻. */
const FACT: Record<string, (s: Slots) => string> = {
  'agents.lead': () => '四个 Agent：编排、检索、编码、审查。可以在这里停用、换模型、收紧工具档。',
  'agents.self': () => '编排 Agent：拆解目标、分派步骤、汇总结果，使用任务的模型，不能停用。',
  'agents.busy': (s) => `${s.who ?? '一个 Agent'}正在${s.doing ?? '工作'}。`,
  'agents.busy.pipe': (s) => `${s.who ?? '一个 Agent'}正在${s.doing ?? '工作'}${s.step ? `（第 ${s.step} / ${s.total} 步）` : ''}。`,
  'agents.busy.self': (s) => `编排 Agent 正在${s.doing ?? '工作'}${s.who ? `（接手${s.who}）` : s.step ? `（第 ${s.step} / ${s.total} 步）` : ''}。`,
  'agents.takeover': (s) => `${s.who ?? 'Agent'}已停用，它的步骤由编排 Agent 接手${s.doing ? `：${s.doing}` : ''}。`,
  'agents.wait': (s) => `${s.who ?? '一个 Agent'}停在这里，等待确认。`,
  'agents.idle': (s) => `${s.who ?? 'Agent'}空闲。`,
  'agents.idle.nomodel': () => '没有可用的模型。到「模型接入」接入一个后才能开工。',
  'agents.off': (s) => `${s.who ?? 'Agent'}已停用，它的步骤交给编排 Agent。`,
  'agents.on': (s) => `${s.who ?? 'Agent'}已启用。`,
  'agents.locked': () => '编排 Agent 不能停用。',
  'agents.setmodel': (s) => `${s.who ?? 'Agent'}改用 ${s.model ?? '所选模型'}。`,
  'agents.white': () => '白：这一项在这位同伴这里不额外收紧，照全局设置。',
  'agents.silver': () => '银：这一项需要确认；是否真会先问，以下方写出的此刻情况为准。',
  'agents.black': () => '黑：这一项对这位同伴禁用。',
  'agents.follow': () => '跟随任务：用新建任务时选的模型。',
  'agents.comp.api': () => 'API 方式不使用工具，档位不起作用。',
  'agents.comp.two': () => '只认写文件和联网搜索两项，其余由命令行工具自己管。',
  'agents.comp.none': () => '这个命令行工具不受这里的档位限制。',
  'agents.res': () => '检索：找资料、读文档、做对比。',
  'agents.cod': () => '编码：读代码、写改动、跑命令。',
  'agents.rev': () => '审查：跑测试、复核结论。',
};

/** pick：只要行 ID 满足条件的变体（同一场景里分「回应一句」与「常驻状态」两类，避免同一个意思换几个字说两遍）. 找不到满足的就用默认抽到的那一条. */
export type SayHer = (scenes: string | string[], slots?: Slots, opts?: Pick<Say2Opts, 'facts'> & { n?: number; pick?: (lineId: string) => boolean }) => HerLine | undefined;

export function useAgentSay(): { say: SayHer; persona: boolean; level: Level } {
  const say2 = useSay2();
  const { persona, level } = useVoice();
  return useMemo(() => {
    const say: SayHer = (scenes, slots = {}, opts = {}) => {
      const list = Array.isArray(scenes) ? scenes : [scenes];
      const seed = opts.n === undefined ? undefined : voiceSeed(Date.now(), 'agents', opts.n);
      for (const scene of list) {
        let r = say2(scene, slots, { mode: 'work', facts: opts.facts, ...(seed ? { seed } : {}) });
        if (opts.pick && !r.silent && !opts.pick(r.src?.id ?? '')) {
          for (let i = 1; i <= 24; i += 1) {
            const alt = say2(scene, slots, { mode: 'work', facts: opts.facts, seed: voiceSeed(Date.now(), 'agents-pick', i) });
            if (!alt.silent && opts.pick(alt.src?.id ?? '')) { r = alt; break; }
          }
        }
        if (r.silent) continue;
        const text = r.text.trim();
        if (text) return { text, expr: r.expr ?? 'gentle' };
      }
      return undefined;
    };
    const sayAny: SayHer = (scenes, slots, opts) => {
      const hit = say(scenes, slots, opts);
      if (hit) return hit;
      if (persona) return undefined;
      const list = Array.isArray(scenes) ? scenes : [scenes];
      for (const scene of list) {
        const f = FACT[scene];
        if (f) return { text: f(slots ?? {}), expr: 'gentle' };
      }
      return undefined;
    };
    return { say: sayAny, persona, level };
  }, [say2, persona, level]);
}

/** 她的话按句切成气泡：少 1 个、中 / 多最多 2 个（§4.3 页头）；一句话就一个气泡. */
export function splitBubbles(text: string, max: number): string[] {
  const parts = text.match(/[^。？！]+[。？！]?/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  if (max <= 1 || parts.length <= 1) return [text];
  if (parts.length <= max) return parts;
  return [parts[0], parts.slice(1).join('')];
}
