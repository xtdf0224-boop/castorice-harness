/* The seam between the UI and whatever executes agents.
   The UI only talks to `backend` through these methods and renders whatever lands in the store.
   Every call goes to live.ts, which drives the task's model (a command-line agent or an API)
   through the desktop bridge and writes what happens into the store as Run, ToolCall, Approval… */
import * as engine from './engine';
import * as live from './live';
import { store, uid } from './store';

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface HarnessBackend {
  startRun(taskId: string): Result<string>;
  pauseRun(runId: string): Result;
  resumeRun(runId: string): Result;
  cancelRun(runId: string): Result;
  retryRun(runId: string, mode: 'resume' | 'restart'): Result<string>;
  decideApproval(approvalId: string, decision: 'approve' | 'reject'): Result;
  /** 回答模型的提问（同一次提问的问题都答完才交还模型）. */
  answerQuestion(questionId: string, answer: string | string[]): Result;
  /** 计划审批：批准之后才执行；revise 带一句意见发回重做. */
  decidePlan(runId: string, decision: 'approve' | 'revise', note?: string): Result;
  sendMessage(taskId: string, text: string): Result;
  /** 让她换个说法（只重写她的话，施工图 §3.7）：模板来源重抽、模型来源走独立一轮；失败保留原文. */
  rewriteHer(taskId: string, msgId: string): Promise<Result>;
  /** 撤销换说法：换回 prevText. */
  undoRewrite(taskId: string, msgId: string): Result;
  /** 落蝶旁边的「让她回一句」：去掉标记，走普通回复. */
  answerLanding(taskId: string, msgId: string): Result;
}

export const backend: HarnessBackend = {
  startRun: (taskId) => live.startLiveRun(taskId),
  pauseRun: (runId) => live.pauseLive(runId),
  resumeRun: (runId) => live.resumeLive(runId),

  cancelRun(runId) {
    if (!store.get().runs[runId]) return fail('找不到这个运行。');
    // 取消前量好它停在第几步（取消之后步骤状态变了），取消成功才说话
    const wasLive = store.get().runs[runId].status;
    live.cancelLive(runId);
    // Marking the run, its steps, calls and approvals as cancelled does not depend on the model.
    let done = false;
    store.update((d) => { const r = d.runs[runId]; if (r) done = engine.cancelRun(d, r, Date.now()); });
    if (done && wasLive !== 'paused') live.noteInterrupted(runId);
    return done ? ok(undefined) : fail('这个运行已经结束。');
  },

  retryRun(runId, mode) {
    const taskId = store.get().runs[runId]?.taskId;
    if (!taskId) return fail('找不到这个运行。');
    return live.startLiveRun(taskId, { retryOf: runId, mode });
  },

  decideApproval(approvalId, decision) {
    return live.decideLive(approvalId, decision) ? ok(undefined) : fail('这项确认已经处理过或已失效。');
  },

  answerQuestion: (questionId, answer) => live.answerQuestionLive(questionId, answer),

  decidePlan: (runId, decision, note) => live.decidePlanLive(runId, decision, note),

  rewriteHer: (taskId, msgId) => live.rewriteHer(taskId, msgId),
  undoRewrite: (taskId, msgId) => live.undoRewriteHer(taskId, msgId),
  answerLanding: (taskId, msgId) => live.answerLanding(taskId, msgId),

  sendMessage(taskId, text) {
    const task = store.get().tasks[taskId];
    if (!task) return fail('找不到这个任务。');
    if (task.kind !== 'chat') return live.messageLive(taskId, text);
    // 落蝶（§4.4）：这句是闭合语、接在她一句收尾的话后面——不调模型，只给这条用户消息挂 reaction:'landing'. 要在 push 之前判（判据看「她的上一条之后用户有没有说过话」）
    const landing = live.isLanding(taskId, text);
    // 危机用语（D18）：命中的回合神色恒 gentle、无 react / 贴纸 / 胶囊，当天不再主动搭话
    const crisis = !landing && live.crisisTurn(text);
    store.update((d) => {
      d.tasks[taskId].messages.push({ id: uid('msg'), role: 'user', text, at: Date.now(), ...(landing ? { reaction: 'landing' as const } : {}) });
      engine.touch(d, taskId, Date.now());
    });
    if (!landing) void live.reply(taskId, { crisis });
    return ok(undefined);
  },
};
