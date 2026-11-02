/* 她的头像（施工图 §4.2、D2、D4、D19、§4.7）。
   · sq（默认）= 圆角方形（半径 ≈20%）裁切，取 527² 源图矩形 x70–460, y0–390；CSS 等价 img{width:135.1%;left:-17.9%;top:0}（D4，不切冠尖）.
     这三个数写在 img 的行内样式里（数值来自 lib/expr 的 FACE_CROP_CSS），样式表缺了也不会裁到冠.
   · size ≤ 72 时 badge 默认开：max(22px, .40·size) 的 136² 图标，描边 1.5px 底色（第 3 轮评审：56 px 下 20 px 的脸才读得出表情）；
     图标四周的透明留白在 ExprBadge 里裁掉（crop，img 125% 外移，显示边长仍 ≤136）；带贴纸的消息显式 badge={false}（D19）；
     小头像（卡外那一句，40 px）给 badgeSize=20，角标外移 right/bottom -3px，不盖脸.
   · full = 整张立绘不裁（图片本身直角或 ≤14px 圆角；这个组件里没有任何 overflow:hidden，图片外接盒不会被自己的祖先切到），最大 349.
   · 外环编码运行状态而非表情（D2）：idle = --ring-idle，work = --ring-work，wait = --ring-wait.
   · 换表情：新图 150 ms 淡入（data-swap）；减少动态与窗口隐藏时的处理在 her.css.
   DOM：data-her-avatar、data-expr、data-shape、data-ring；data-badge 在角标上. 素材路径来自 lib/expr.ts. */
import { useEffect, useRef } from 'react';
import { ART_MAX, EXPR_NAME, FACE_CROP_CSS, FACE_SRC } from '../../lib/expr';
import type { ExprId } from '../../lib/types';
import '../../styles/her.css';
import { ExprBadge } from './ExprBadge';

export interface HerAvatarProps {
  size: number;
  expr?: ExprId;
  ring?: 'idle' | 'work' | 'wait' | 'none';
  badge?: boolean;
  /** 角标边长（CSS px）；缺省 max(22, .40·size)。给了就按「外移 3px、不盖脸」放（卡外那一句的 40 px 头像配 20 px 角标）. */
  badgeSize?: number;
  shape?: 'sq' | 'full';
  className?: string;
}

/** sq 的图片宽是容器宽的 135.1%，所以容器边长上限 = ART_MAX.face / 1.351（渲染边长 ≤ 349）. */
const SQ_MAX = Math.floor((ART_MAX.face / FACE_CROP_CSS.width) * 100);

const cls = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(' ');

export function HerAvatar({ size, expr = 'gentle', ring = 'idle', badge, badgeSize, shape = 'sq', className }: HerAvatarProps) {
  const alt = `遐蝶（${EXPR_NAME[expr]}）`;
  // 表情变了才淡入；第一次挂载（含虚拟列表里滚进来的行）不闪.
  const last = useRef(expr);
  const swapped = last.current !== expr;
  useEffect(() => { last.current = expr; }, [expr]);

  if (shape === 'full') {
    const px = Math.min(Math.max(1, Math.round(size)), ART_MAX.face);
    const bpx = Math.max(18, Math.round(px * 0.2));
    return (
      <span data-her-avatar data-expr={expr} data-shape="full" className={cls('hface', 'hface--full', className)} style={{ width: px }}>
        <img
          key={expr} className="hface__full" src={FACE_SRC(expr)} alt={alt} width={px} height={px}
          data-swap={swapped ? '' : undefined} draggable={false} style={{ display: 'block', width: px, height: 'auto', maxWidth: 'none' }}
        />
        {badge ? (
          <span className="hface__badge hface__badge--in" style={{ width: bpx, height: bpx }}>
            <ExprBadge decorative expr={expr} size={bpx} />
          </span>
        ) : null}
      </span>
    );
  }

  const px = Math.min(Math.max(1, Math.round(size)), SQ_MAX);
  const showBadge = badge ?? px <= 72;
  const bpx = badgeSize ? Math.max(1, Math.round(badgeSize)) : Math.max(22, Math.round(px * 0.4));
  const off = badgeSize ? -3 : -Math.round(bpx * 0.25);
  return (
    <span
      data-her-avatar
      data-expr={expr}
      data-shape="sq"
      data-ring={ring}
      className={cls('hface', className)}
      style={{ position: 'relative', display: 'inline-block', width: px, height: px, flex: 'none' }}
    >
      <span className="hface__clip" data-ring={ring}>
        <img
          key={expr}
          className="hface__img"
          src={FACE_SRC(expr)}
          alt={alt}
          draggable={false}
          data-swap={swapped ? '' : undefined}
          style={{
            position: 'absolute', display: 'block', maxWidth: 'none', height: 'auto',
            width: `${FACE_CROP_CSS.width}%`, left: `${FACE_CROP_CSS.left}%`, top: FACE_CROP_CSS.top,
          }}
        />
      </span>
      {showBadge ? (
        <span className="hface__badge" style={{ width: bpx, height: bpx, right: off, bottom: off }}>
          <ExprBadge decorative crop expr={expr} size={bpx} />
        </span>
      ) : null}
    </span>
  );
}
