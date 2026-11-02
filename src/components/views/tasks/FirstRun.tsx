/* 先接入一个模型: what the home page and the task list show until at least one model is ready.
   栖枝 ships no model of its own; this says the two ways to connect one and goes to 模型接入.
   第一次打开（greet）时卡片最上面是她的欢迎词 greet.first（模板、零 token、只出这一次），旁边是「AI 辅助角色」小标，
   下面有一句如实的说明：她是 AI 辅助的角色，被真诚问到时会直说. 关掉角色口吻时不出欢迎词，也不出头像. */
import { ArrowRight, KeyRound, Plug, TerminalSquare } from 'lucide-react';
import { useSay2 } from '../../../lib/voice';
import { actions } from '../../../state/actions';
import { personaOn } from '../../../state/selectors';
import { useApp } from '../../../state/store';
import { Button, Panel } from '../../ui';
import { AiTag } from '../../her/AiTag';
import { HerAvatar } from '../../her/HerAvatar';

export function FirstRun({ desktopOk, greet }: { desktopOk: boolean; greet?: boolean }) {
  const persona = useApp((s) => personaOn(s));
  const say2 = useSay2();
  const hello = greet && persona ? say2('greet.first', {}, { mode: 'chat' }) : undefined;
  return (
    <Panel className="first-run" label="开始之前" title="先接入一个模型" icon={Plug} energy>
      {hello?.text && (
        <div className="first-run__hello" data-her>
          <HerAvatar size={52} expr={hello.expr ?? 'shy'} ring="none" />
          <div className="first-run__hello-text">
            <p className="first-run__greet" aria-live="polite">{hello.text}</p>
            <p className="first-run__ai"><AiTag /><span>我是 AI 辅助的角色，被真诚问到时会直说。</span></p>
          </div>
        </div>
      )}
      <p className="first-run__lead">栖枝自己不带模型：接入一个之后，才能聊天，也才能把事情交给 Agent。有两种接法，选一种就行。</p>
      <ul className="first-run__ways">
        <li>
          <TerminalSquare size={16} aria-hidden />
          <p><strong>命令行工具登录</strong><span>已经装了 Claude Code、Codex 等？用自己的账号登录它，Agent 就能在目录里读写文件、执行命令。栖枝不会读取你的登录凭据。</span></p>
        </li>
        <li>
          <KeyRound size={16} aria-hidden />
          <p><strong>API 密钥</strong><span>填一家模型服务的 API Key，密钥加密保存在本机。只用来思考和写作，不会动你的文件；按量计费。</span></p>
        </li>
      </ul>
      {desktopOk ? (
        <div className="first-run__actions">
          <Button variant="primary" iconRight={ArrowRight} onClick={() => actions.navigate('models')}>去模型接入</Button>
        </div>
      ) : (
        <p className="first-run__note">模型接入需要桌面版。你现在打开的是浏览器里的网页版，没法调用模型。</p>
      )}
    </Panel>
  );
}
