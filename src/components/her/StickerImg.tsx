/* 官方贴纸（施工图 §3.5、§4.7）。
   整张、原比例、不裁、不动画、不套气泡；显示边长 ≤ 120（源 510²）；只能出现在 [data-her] 内（D-02）——调用方负责这一点.
   含贴纸的消息不画 136² 角标、头像保持 gentle（D19）；Agent 页不出现贴纸. */
import { ART_MAX, STICKER_SRC } from '../../lib/expr';
import type { StickerId } from '../../lib/types';
import '../../styles/her.css';

const NAME: Record<StickerId, string> = {
  butterfly: '蝴蝶', blushing: '脸红', create: '创作', dontthink: '不去想', like: '喜欢', bewildered: '茫然',
};

export function StickerImg({ id, size = ART_MAX.sticker }: { id: StickerId; size?: number }) {
  const px = Math.min(Math.max(1, Math.round(size)), ART_MAX.sticker);
  return <img data-sticker={id} className="hsticker" src={STICKER_SRC(id)} alt={`贴纸：${NAME[id]}`} width={px} height={px} draggable={false} style={{ width: px, height: px }} />;
}
