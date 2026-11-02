/* 运行里"要你点头"的三件事的动作（B3 引擎）：回答模型的提问、批准 / 要求修改计划、批准前编辑计划。
   界面（任务页的卡片、「待你」页）都调这里；做不到的会弹一条提示，不会悄悄失败。
   批准工具调用仍然是 backend.decideApproval / actions.decideApproval. */
import type { PlanDraftStep } from './engine';
import { answerQuestionLive, decidePlanLive, editPlanLive, type Result } from './live';
import { toast } from './engine';
import { store } from './store';

export type { PlanDraftStep } from './engine';

function surface(r: Result, title: string): Result {
  if (!r.ok) store.update((d) => toast(d, { tone: 'warning', title, body: r.error, key: 'run-action' }));
  return r;
}

/** 回答一个问题。answer 是选中的选项名，或使用者自己写的话（可以几个一起）。
 *  同一次提问里的问题都回答完，才一次性交还给模型. */
export function answerQuestion(questionId: string, answer: string | string[]): Result {
  return surface(answerQuestionLive(questionId, answer), '没能提交回答');
}

/** 计划：approve = 批准，批准之后才开始执行；revise = 带一句意见发回去，重新出一版. */
export function decidePlan(runId: string, decision: 'approve' | 'revise', note?: string): Result {
  return surface(decidePlanLive(runId, decision, note), decision === 'approve' ? '没能批准计划' : '没能发回计划');
}

/** 批准之前改计划：标题、说明、负责的 Agent，增删步骤、调顺序。批准时会记为「已编辑」. */
export function editPlan(runId: string, steps: PlanDraftStep[]): Result {
  return surface(editPlanLive(runId, steps), '没能保存对计划的修改');
}
