/* 表情角标：官方 136² 表情图标，圆形，仅图标（施工图 §4.2、§4.7）。
   渲染边长（CSS px）≤ 自然边长 136（D4 / D-04）. 带 data-badge 与 data-expr（D-01：内容卡内这两个属性都必须为 0 个）.
   图标本身是透明底的 RGBA，所以垫一个深紫圆盘（界面底色，不是她的形象）；不改图、不缩放出界. */
import { EXPR_NAME, ICON_NATURAL, ICON_SRC } from '../../lib/expr';
import type { ExprId } from '../../lib/types';
import '../../styles/her.css';

export interface ExprBadgeProps {
  expr: ExprId;
  size: number;
  /** 紧挨着头像时，头像的 alt 已经说了表情，角标不再重复读一遍. */
  decorative?: boolean;
  /** 裁掉图标四周的透明留白（脸占满圆盘）：img 放大到 125% 再外移 12.5%，由外层圆形容器（overflow:hidden）裁切.
   *  官方 136² 图标内容只占中间约 72%，56 px 头像上的 22 px 角标不裁的话脸只剩 12 px（第 3 轮评审）；img 显示边长仍 ≤136. */
  crop?: boolean;
}

/** 官方 136² 图标内容占图的比例约 .72，放大到 1.25 倍后头部约占圆盘 90%. */
export const BADGE_CROP = 1.25;

export function ExprBadge({ expr, size, decorative, crop }: ExprBadgeProps) {
  const px = Math.min(Math.max(1, Math.round(size)), ICON_NATURAL);
  const big = crop ? Math.min(Math.round(px * BADGE_CROP * 10) / 10, ICON_NATURAL) : px;
  return (
    <img
      data-badge
      data-expr={expr}
      className="hbadge"
      src={ICON_SRC(expr)}
      alt={decorative ? '' : `表情：${EXPR_NAME[expr]}`}
      aria-hidden={decorative || undefined}
      width={crop ? Math.round(big) : px}
      height={crop ? Math.round(big) : px}
      draggable={false}
      style={crop ? { width: big, height: big, margin: -(big - px) / 2, maxWidth: 'none' } : { width: px, height: px }}
    />
  );
}
