/* 聊天框和消息里的头像：从她的母版图（public/pet/rig/fallback.png，984×1413）里把脸裁成一小张圆图。
   裁一次、存成 data: 地址（页面的 CSP 允许 img-src data:），聊天框里每个头像都用它，不必每次从大图缩。
   显示尺寸（设备像素）不超过裁下来的像素，更不超过源图。 */
import { FALLBACK_SRC } from './rig';

/** 脸在母版图里的位置：边长 360 的正方形，左上角 (315, 300)——刚好是整张脸和一点头发，不带头冠尖。 */
export const AVATAR_CROP = { x: 315, y: 300, size: 360 } as const;
/** 裁出的边长（像素）：聊天框头像最大 32 页面像素 × 缩放 1.6 × 屏幕 1.5 ≈ 77，留余量。 */
export const AVATAR_PX = 96;

let cached: Promise<string | null> | null = null;

/** 取头像的 data: 地址；图没放进来或解不开时是 null（调用方用底色圆代替）。 */
export function loadAvatar(): Promise<string | null> {
  cached ??= (async () => {
    try {
      const img = new Image();
      img.src = FALLBACK_SRC;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = AVATAR_PX;
      const g = c.getContext('2d');
      if (!g) return null;
      g.imageSmoothingQuality = 'high';
      // 源图比裁块大，分两步缩（先到 2 倍再到目标），比一步缩得干净
      const mid = document.createElement('canvas');
      mid.width = mid.height = AVATAR_PX * 2;
      const m = mid.getContext('2d');
      if (!m) return null;
      m.imageSmoothingQuality = 'high';
      m.drawImage(img, AVATAR_CROP.x, AVATAR_CROP.y, AVATAR_CROP.size, AVATAR_CROP.size, 0, 0, mid.width, mid.height);
      g.drawImage(mid, 0, 0, AVATAR_PX, AVATAR_PX);
      return c.toDataURL('image/png');
    } catch {
      return null;
    }
  })();
  return cached;
}
