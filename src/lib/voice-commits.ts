/* 承诺类台词的实现点登记表（施工图 §3.10）。
   台词里出现行为承诺词（我会｜我一定｜都会｜一定先｜每次｜保证｜先问｜多确认｜记着｜守着｜替你｜会停下来｜停下来请示｜不会绕过｜先收拾｜对一对｜留意着｜再告诉）时，该行 JSON 必须带 commits:"<实现点 id>"，
   且 id 登记在这里：写明「哪个文件里的哪个东西真的做了这件事」。没有对应实现，就不得入库——要么改写台词，要么先做功能.
   check-voice 会读 file 的源码，断言 includes 这段字面量还在（实现被改名 / 删掉时，台词就跟着红；合并别人的重写后若字面量变了，改这里，不要改台词）.
   这张表是唯一真源；新增条目请同时在 includes 里写一段足够具体、不会随手被改掉的字面量. */

export interface CommitPoint {
  /** 实现点 id（台词 JSON 的 commits 字段引用它）. */
  id: string;
  /** 相对 app/ 的源码文件. */
  file: string;
  /** 该文件里必须能找到的字面量（给数组 = 任意一个找得到即可；排在前面的写得具体，最后一个是改名后仍能认出来的底线）. */
  includes: string | readonly string[];
  /** 人话：台词承诺了什么，这段代码怎么兑现. */
  what: string;
}

export const COMMIT_POINTS: Record<string, CommitPoint> = {
  'plan.approval': {
    id: 'plan.approval',
    file: 'src/state/live.ts',
    includes: ["planApproval?.status === 'pending'", "planApproval.status === 'pending'", 'planApproval'],
    what: '计划出来后要等批准才执行：计划待批时 live.ts 不往下跑步骤（「批准之前我不会动手」）.',
  },
  'run.awaiting': {
    id: 'run.awaiting',
    file: 'src/state/live.ts',
    includes: ["if (run.status === 'running') run.status = 'awaiting';", "status = 'awaiting'", "'awaiting'"],
    what: '出现待批的审批 / 待答的提问时，运行转入 awaiting 并停在那里，等用户在界面里决定（「要{n}拿主意的地方我会停下来问」）.',
  },
  'progress.saved': {
    id: 'progress.saved',
    file: 'src/state/persist.ts',
    includes: ['export function saveSoon', 'saveSoon'],
    what: '会话与运行记录随状态变化自动落库（saveSoon），关掉再开仍在原处（「做到哪儿都存着」）.',
  },
  'trust.readonly': {
    id: 'trust.readonly',
    file: 'src/state/trustGate.ts',
    includes: ["if (choice === 'readonly')", "'readonly'"],
    what: '没确认可信的目录只读：选了「只读继续」就记为 T0，不写入、不运行命令（「确认之前我只读不写」）.',
  },
};

/** 行为承诺词（与 check-voice 同源）. */
export const COMMIT_WORDS = /我会|我一定|都会|一定先|每次|保证|先问|多确认|记着|守着|替你|会停下来|停下来请示|不会绕过|先收拾|对一对|留意着|再告诉/;

export function commitPoint(id: string | undefined): CommitPoint | undefined {
  return id ? COMMIT_POINTS[id] : undefined;
}
