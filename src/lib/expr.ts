/* 她的官方素材契约（施工图 §4.2）：表情 / 图标 / 贴纸 / 命途徽记的 ID、文件名与尺寸规则。
   文件由 C2 放进 public/art/her/（现在不存在没关系）；文件名即契约，所有组件都从这里取路径。
   base 取法照 persona.ts 的 typeof import.meta 守卫：check:ui 在 Node 里静态渲染，直接读 import.meta.env.BASE_URL 会抛 TypeError. */
import type { AgentId, ExprId, StickerId } from './types';

const BASE: string = (typeof import.meta !== 'undefined' && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || './';

/** 六个官方表情（固定顺序）. */
export const EXPR_IDS: readonly ExprId[] = ['gentle', 'relaxed', 'shy', 'surprised', 'confused', 'grumpy'];
/** 中文名（D9）：只用于 alt 文本与设置页；游戏内叫法未核实. */
export const EXPR_NAME: Record<ExprId, string> = {
  gentle: '温柔', relaxed: '放松', shy: '害羞', surprised: '惊讶', confused: '困惑', grumpy: '皱眉',
};
/** 贴纸白名单（D10）：withering / takeoff 不进. */
export const STICKER_IDS: readonly StickerId[] = ['butterfly', 'blushing', 'create', 'dontthink', 'like', 'bewildered'];
/** 命途（D14：产品自定的象征，不宣称官方对应）. */
export type PathId = 'remembrance' | 'erudition' | 'hunt' | 'preservation';
export const PATH_IDS: readonly PathId[] = ['remembrance', 'erudition', 'hunt', 'preservation'];
export const PATH_OF: Record<AgentId, PathId> = {
  orchestrator: 'remembrance', researcher: 'erudition', coder: 'hunt', reviewer: 'preservation',
};
/** 命途的中文单词（牌面用；英文副题挪牌背）. */
export const PATH_NAME: Record<PathId, string> = { remembrance: '记忆', erudition: '智识', hunt: '巡猎', preservation: '存护' };

/** 自然边长（px）：渲染边长（CSS px）必须 ≤ 自然边长；527² 的立绘最大显示 ≤ 349（D4）. */
export const FACE_NATURAL = 527;
export const ICON_NATURAL = 136;
export const STICKER_NATURAL = 510;
/** 头像圆角方形裁切取 527² 源图的矩形 x70–460, y0–390（D4）；CSS 等价 img{width:135.1%;left:-17.9%;top:0}. */
export const FACE_CROP = { x: 70, y: 0, w: 390, h: 390 } as const;
/** 各素材的最大显示边长（CSS px）. */
export const ART_MAX = { face: 349, icon: 136, sticker: 120 } as const;

/** 由 FACE_CROP 推出的 CSS 数值（D-03 断言用）：width / left 为占容器宽的百分比，top 为 0. */
export const FACE_CROP_CSS = {
  width: Math.round((FACE_NATURAL / FACE_CROP.w) * 1000) / 10,       // 135.1
  left: -Math.round((FACE_CROP.x / FACE_CROP.w) * 1000) / 10,        // -17.9
  top: 0,
} as const;

export const ART_DIR = `${BASE}art/her/`;
export const FACE_SRC = (id: ExprId): string => `${ART_DIR}face-${id}.webp`;
export const ICON_SRC = (id: ExprId): string => `${ART_DIR}icon-${id}.webp`;
export const STICKER_SRC = (id: StickerId): string => `${ART_DIR}sticker-${id}.webp`;
/** <48 px 处用 `-s`（64²），≥48 用 128². */
export const PATH_SRC = (path: PathId, size: number): string => `${ART_DIR}path-${path}${size < 48 ? '-s' : ''}.webp`;
/** 属性图（量子）. */
export const TYPE_QUANTUM_SRC = `${ART_DIR}type-quantum.webp`;
/** 已有的官方立绘（主牌月面圆形裁切；就近署名 data-credit="moon"，D16）. */
export const FIGURE_OFFICIAL_SRC = `${BASE}art/figure-official.webp`;

/** 是否合法 ExprId（解析模型输出 / 读存档时用）. */
export const isExprId = (v: unknown): v is ExprId => typeof v === 'string' && (EXPR_IDS as readonly string[]).includes(v);
export const isStickerId = (v: unknown): v is StickerId => typeof v === 'string' && (STICKER_IDS as readonly string[]).includes(v);
