/* 名牌（施工图 §4.2，样稿 C 的 .np，借 B 的剧情式副标）.
   左紫胶囊 + 蝶标 + 右铭牌（衬线 700，字距 .2em）；副标只准这三个官方称号（不进 AI 辅助角色小标，那是 AiTag）；
   word 是神色词胶囊（前缀点：蓝 = 在做 / 金 = 等你 / 无）；expr 是表情胶囊（官方 136² 小图标 + 中文表情名，第 3 轮：头像角标之外，
   名行再写一遍表情名，「表情会变」才看得见）——一条话只有一种表情信号（D19）：带贴纸 / 危机 / 旧消息的调用方不传.
   夜里文字是浅色，铭牌本身是纸色，所以字色写死深紫. */
import { EXPR_NAME, ICON_SRC } from '../../lib/expr';
import type { ExprId } from '../../lib/types';
import '../../styles/her.css';
import { BADGE_CROP } from './ExprBadge';
import { ButterflyMark } from './ButterflyMark';

export const NAMEPLATE_SUBS = ['死荫的侍女', '拥抱新生的祈望', '冥河的女儿'] as const;
export type NamePlateSub = (typeof NAMEPLATE_SUBS)[number];

export interface NamePlateProps {
  name?: string;
  sub?: NamePlateSub;
  /** 神色词（在写 / 在想 / 停在这一步…）. */
  word?: string;
  size: 'sm' | 'md' | 'lg';
  /** 神色词前缀点：蓝 = 在做，金 = 等你，缺省无. */
  dot?: 'work' | 'wait';
  /** 这一句的表情：给了就在名行画「小图标 + 中文表情名」胶囊. */
  expr?: ExprId;
}

const MARK: Record<NamePlateProps['size'], number> = { sm: 13, md: 15, lg: 19 };
/** 表情胶囊里小图标的圆盘边长（CSS px）；img 125% 裁掉透明留白，显示边长 ≈ 23 ≤ 136. */
const EICON = 18;

export function NamePlate({ name = '遐蝶', sub, word, size, dot, expr }: NamePlateProps) {
  return (
    <span data-nameplate data-size={size} className={`hnp hnp--${size}`}>
      <span className="hnp__tag">
        <span className="hnp__cap" aria-hidden="true"><ButterflyMark size={MARK[size]} /></span>
        <span className="hnp__plate">{name}</span>
      </span>
      {sub ? <span data-nameplate-sub className="hnp__sub">{sub}</span> : null}
      {expr ? (
        <span data-expr-chip={expr} className="hnp__expr">
          <span className="hnp__eicon" aria-hidden="true">
            <img src={ICON_SRC(expr)} alt="" width={Math.round(EICON * BADGE_CROP)} height={Math.round(EICON * BADGE_CROP)} draggable={false} />
          </span>
          {EXPR_NAME[expr]}
        </span>
      ) : null}
      {word ? (
        <span data-word className="hnp__word">
          {dot ? <span aria-hidden="true" className={`hnp__dot hnp__dot--${dot}`} /> : null}
          {word}
        </span>
      ) : null}
    </span>
  );
}
