/* 卡外她那一句（施工图 §4.4；第 1 轮评审后对齐样稿 C s3/s5）：审批卡、提问卡、报错卡、遗物卡上方的她——
   40 px 头像（20 px 角标外移 3px，不盖脸）+ NamePlate sm + 神色词胶囊（待批 / 待答 = 停在这一步，失败 = 抱歉）+ 气泡里的句子.
   第 4 轮：角标在，名行就带「小图标 + 表情名」胶囊（与角标同一个 expr，缺省 gentle = 温柔），不会出现有角标没胶囊；crisis 两样都不画.
   句子来自 approve.ask|approve.high|question.w|fail.*|done.w（随话量、夜昼）；调用方也可以直接给 text（E 写进对话流的那条 note）.
   卡本体（ApprovalCard、RunCallout 的未竟之信 / 遗物卡）不变、无头像无贴纸——这里的头像只属于卡外这一句.
   persona=false：不画头像，只留事实句（走 voice-facts）；没有句子就什么都不画.
   quiet：她退半步的时候（审批 / 提问 / 失败正是退后的时刻）取最短一档；退半步只作用在头像图上
   （saturate .6 + opacity .8），角标、名牌、句子保持不透明——脸要看得见，字要读得清. */
import type { ExprId, Level } from '../../lib/types';
import { useSay2, type Slots, type VoiceFacts } from '../../lib/voice';
import { useVoice } from '../../state/selectors';
import '../../styles/her.css';
import { HerAvatar } from './HerAvatar';
import { leadWordOf } from './logic';
import { NamePlate } from './NamePlate';
import { guardTail } from './Tail';

export interface HerLeadProps {
  scene?: string;
  slots?: Slots;
  /** 直接给句子（已渲染好的）；有它就不查台词库. */
  text?: string;
  quiet?: boolean;
  /** 头像外环：她在等你（待批 / 待答）= wait，在做事 = work. */
  ring?: 'idle' | 'work' | 'wait';
  /** 神色词；缺省按场景推（待批 / 待答 = 停在这一步，失败 = 抱歉），推不出就不画. 传 null = 明确不画. */
  word?: string | null;
  dot?: 'work' | 'wait';
  mode?: 'chat' | 'work';
  level?: Level;
  /** 头像角标与名行表情胶囊的表情（第 4 轮：角标在，胶囊就在，两路同一个 ExprId）；缺省 gentle. */
  expr?: ExprId;
  /** 危机回合：无角标、无胶囊、无称号（D18）. */
  crisis?: boolean;
  /** 事实上下文（done.w 的 retries / steps / activeMs 之类），只用来挑变体. */
  facts?: VoiceFacts;
  className?: string;
}

/** 卡外那一句的头像边长与角标边长（第 3 轮：40 / 20，外移 3px；角标图标裁掉透明留白后脸占满圆盘）. */
export const LEAD_AVATAR = 40;
export const LEAD_BADGE = 20;

export function HerLead({ scene, slots, text, quiet, ring = 'idle', word, dot, mode = 'work', level, expr = 'gentle', crisis, facts, className }: HerLeadProps) {
  const say = useSay2();
  const voice = useVoice();
  const said = text !== undefined ? undefined : scene ? say(scene, slots ?? {}, { mode, facts, level: level ?? (quiet ? 's' : undefined) }) : undefined;
  const line = (text ?? said?.text ?? '').trim();
  if (!line || said?.silent) return null;
  if (!voice.persona) return <p className={`her-lead her-lead--plain ${className ?? ''}`} data-scene={scene}>{line}</p>;
  const w = word === null ? undefined : word !== undefined ? { word, dot: dot ?? (ring === 'idle' ? undefined : ring) } : leadWordOf(scene);
  return (
    <div className={`her-lead ${quiet ? 'is-quiet' : ''} ${className ?? ''}`} data-her data-scene={scene}>
      <HerAvatar size={LEAD_AVATAR} badgeSize={LEAD_BADGE} expr={crisis ? 'gentle' : expr} ring={ring} badge={!crisis} />
      <div className="her-lead__col">
        <NamePlate size="sm" word={w?.word} dot={w?.dot} expr={crisis ? undefined : expr} />
        <p className="her-lead__text">{guardTail(line)}</p>
      </div>
    </div>
  );
}
