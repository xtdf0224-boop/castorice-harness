/* 剧情框（施工图 §4.4，借样稿 B 的 .dlg；设置项 storyBox，默认「闲聊」开，用户 2026-10-28 定）.
   第 3 轮评审：不是加宽的气泡，是游戏对话框——框体本身就是她在说话，所以没有框外的头像：
   · NamePlate lg 骑在框的上边线上（左上），副标固定「死荫的侍女」（官方称号，施工图 §4.4；对话流气泡名牌仍随夜昼换称号），
     名牌右边接表情胶囊（官方 136² 小图标 + 中文表情名，如「温柔」）；表情胶囊就是这一句的神色词，所以有表情时不再另放活动词（「在读书」）.
     旧消息没有 expr、带贴纸（D19，一条话一种表情信号）时不画表情胶囊，回到活动词.
   · 第 4 轮：上边线只从名牌（实底）后面过；副标与表情胶囊落在边线下方的框内第一行（her.css 把 .hnp 摊平成同一行的子项），不再被线横穿成「删除线」；胶囊不透明底.
   · 框体：双层边（外 1 px 实线 + 内 3 px 暗圈）、上沿加粗、左侧小尖、夜间渐变深紫 / 昼间纸色渐变；衬线 15.5/29 正文、
     贴纸右下 ≤100、右下「▼ 继续」仅装饰（1.2 s 呼吸；减少动态时静止）、左下只有「收起」（B 的「记录 / 自动」延后）.
   流式时框内逐字出现（正文是调用方给的 children）；下一条用户消息发出时调用方把这条放回对话流成气泡（200 ms 过渡，减少动态直接换）.
   storyBox 关、退后状态、crisis 回合时调用方不渲染（所以这里的名牌恒有副标，危机回合没有剧情框）. */
import type { ReactNode } from 'react';
import type { ExprId, StickerId } from '../../lib/types';
import '../../styles/her.css';
import { NamePlate } from './NamePlate';
import { StickerImg } from './StickerImg';

export interface StoryBoxProps {
  children: ReactNode;
  word?: string;
  dot?: 'work' | 'wait';
  sticker?: StickerId;
  /** 这一句的表情（旧消息没有就不画表情胶囊）；带贴纸时也不画（D19）. */
  expr?: ExprId;
  streaming?: boolean;
  onCollapse: () => void;
}

export function StoryBox({ children, word, dot, sticker, expr, streaming, onCollapse }: StoryBoxProps) {
  const face = expr && !sticker ? expr : undefined;
  return (
    <section className={`story-box${sticker ? ' has-sticker' : ''}`} data-her data-story-box aria-label="她的最新一句" aria-busy={streaming || undefined}>
      <div className="story-box__name">
        <NamePlate size="lg" sub="死荫的侍女" expr={face} word={face ? undefined : word} dot={dot} />
      </div>
      <div className="story-box__text">{children}</div>
      {sticker ? <div className="story-box__sticker"><StickerImg id={sticker} size={100} /></div> : null}
      <div className="story-box__foot">
        <button type="button" className="story-box__fold" onClick={onCollapse}>收起</button>
        <span className="story-box__go" aria-hidden="true">▼ 继续</span>
      </div>
    </section>
  );
}
