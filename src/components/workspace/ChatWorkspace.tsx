/* 闲聊 task page: a header with who you are talking to (遐蝶: her face with the status ring, nameplate, her little status,
   the model) and the conversation filling the rest.
   问候与主动搭话都不在这里：每天第一次的问候是 proactive.maybeGreet 写的 greet.* 模板（零 token，先过话语总闸），静默 8 分钟之类的调度也归 proactive.ts（V2）。
   这里不能再开一个「空页 900 ms 后 reply({greet:true}) 调模型」的定时器——它绕过总闸（安静一小时、危机当天、退后），还违背设置页「句子来自内置模板，不调用模型」（施工图 §3.3、§3.6）. */
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useNow } from '../../lib/hooks';
import { moodWord } from '../../lib/mood';
import { mood } from '../../lib/persona';
import { actions } from '../../state/actions';
import { useHerCrisis, useVoice } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { AgentMark } from '../her/AgentMark';
import { HerAvatar } from '../her/HerAvatar';
import { NamePlate } from '../her/NamePlate';
import { EngineTag, IconButton } from '../ui';
import { Conversation } from './Conversation';

export function ChatWorkspace({ taskId }: { taskId: string }) {
  const task = useApp((s) => {
    const t = s.tasks[taskId];
    return t ? { title: t.title, engine: t.engine?.label } : undefined;
  }, shallow);
  const st = useApp((s) => ({ moodOn: s.settings.lifeMood, mode: s.settings.mode }), shallow);
  const voice = useVoice();
  const crisis = useHerCrisis(taskId);
  const typing = useApp((s) => s.tasks[taskId]?.messages.some((m) => m.streaming) ?? false);
  // 页头的头像表情 = 她最后一句话带的神色（旧消息没有就是 gentle，不兜底、不画角标）.
  const lastExpr = useApp((s) => {
    const ms = s.tasks[taskId]?.messages;
    if (!ms) return undefined;
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if (m.role === 'agent' && m.persona && m.kind !== 'error') return m.crisis ? undefined : m.expr;
    }
    return undefined;
  });
  const awaiting = useApp((s) => {
    const t = s.tasks[taskId];
    const r = t?.runIds.length ? s.runs[t.runIds[t.runIds.length - 1]] : undefined;
    return r?.status === 'awaiting';
  });
  const now = useNow(60_000);

  if (!task) return null;
  const word = moodWord({
    surface: 'chat', streaming: typing, crisis,
    idleMood: st.moodOn && voice.persona ? mood(st.mode, 'idle', new Date(now)) : undefined,
  });
  const ring = awaiting ? 'wait' : typing ? 'work' : 'idle';
  // 危机当天页头只写「遐蝶」，不带称号（冥河 / 死荫是死亡意象，不该挂在自伤的话旁边；第 2 轮评审）.
  const sub = crisis ? undefined : st.mode === 'day' ? '拥抱新生的祈望' : '冥河的女儿';

  return (
    <div className="workspace chat-ws" data-run="chat">
      <section className="panel chat-ws__header" aria-label="闲聊概览">
        <IconButton icon={ArrowLeft} label="返回任务列表" onClick={() => actions.navigate('tasks')} />
        {voice.persona
          ? <span data-her className="chat-ws__face"><HerAvatar size={44} expr={lastExpr ?? 'gentle'} ring={ring} badge={!!lastExpr} /></span>
          : <span className="chat-ws__face"><AgentMark agent="orchestrator" size={40} state={typing ? 'busy' : 'idle'} /></span>}
        <div className="chat-ws__who">
          <h1 className="chat-ws__title">{task.title}</h1>
          {voice.persona ? (
            <p className="chat-ws__status" data-her><NamePlate size="sm" sub={sub} word={word} dot={ring === 'idle' ? undefined : ring} /></p>
          ) : (
            <p className="chat-ws__status"><strong>编排 Agent</strong><span aria-hidden> · </span><span>{typing ? '在写' : '在线'}</span></p>
          )}
        </div>
        <div className="chat-ws__tools">
          {task.engine && <EngineTag label={task.engine} />}
          <IconButton icon={Trash2} label="删除这段闲聊" onClick={() => actions.requestDeleteTask(taskId)} />
        </div>
      </section>
      <section className="panel ws-main chat-ws__main" aria-label="闲聊">
        <div className="ws-main__panel">
          <Conversation taskId={taskId} active chat />
        </div>
      </section>
    </div>
  );
}
