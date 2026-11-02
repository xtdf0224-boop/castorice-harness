# -*- coding: utf-8 -*-
"""栖枝 · Alight 安装器位图（方向 C「落蝶」，第一期全静态）。

    python scripts/gen-installer-art.py                 全部终稿
    python scripts/gen-installer-art.py --placeholder   同名同尺寸的纯色占位（先给 NSIS 编译用）
    PYTHONIOENCODING=utf-8

契约：design/installer/IMPL.md §2。全部 24 位 BMP（BI_RGB、自底向上、无 alpha、无色彩空间块），
母版 2 倍（1 DIP = 2 px）。来源只有三类：
  官方  public/art/figure-official.webp、splash-official.webp、her/face-gentle.webp（整幅，显示尺寸不超过原图，不改色）
  AI 辅助同人夜景  public/wallpapers/night-2560.webp（只取不含她的左下景 u < 0.43；暗纱 / 渐隐只加在夜景上）
  自绘  蝶、枝、火种五笔、冥河细线、字标、警示三角（不用官方蝶翼 / 贴纸 / Q 版 / 光锥）
每张图出完做自检，写 build/installer/manifest.json；任何一条不过就 assert 失败。
"""
import hashlib, json, math, os, random, shutil, struct, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # APP
OUT = os.path.join(ROOT, 'build', 'installer')
S = 2                                                                   # 母版倍数

# ---------- 令牌（冥河夜） ----------
BG = (0x0A, 0x09, 0x13)       # AL_BG
PAGE = (0x0E, 0x0C, 0x19)     # AL_PAGE
FIELD = (0x1B, 0x17, 0x30)    # AL_FIELD
PAPER = (0xF1, 0xED, 0xF0)    # AL_PAPER
TEXT = (0xF4, 0xF0, 0xF7)
TEXT2 = (0xD8, 0xCF, 0xE0)
TEXT3 = (0xC0, 0xB4, 0xCF)
TITLE = (0xEF, 0xE3, 0xF3)
ACCENT = (0xD6, 0xC1, 0xE0)
BLUE = (0x7C, 0xC8, 0xF7)
GOLD = (0xE6, 0xC8, 0x8A)
GOLD_INK = (0x6E, 0x42, 0x00)
RAISED = (0x26, 0x20, 0x40)
STYX = [(0x86, 0x5C, 0x98), (0xC6, 0xAE, 0xD3), (0x7C, 0xC8, 0xF7)]

# 文件名 -> (宽 px, 高 px, 占位色, 约字节)  —— IMPL §2.1，一字不改
SPEC = {
    'welcome.bmp': (1440, 864, BG, 3732534), 'finish.bmp': (1440, 864, BG, 3732534),
    'header.bmp': (1440, 128, BG, 553014), 'band.bmp': (1440, 320, PAGE, 1382454),
    'un_welcome.bmp': (1440, 864, BG, 3732534), 'un_done_keep.bmp': (1440, 864, BG, 3732534),
    'un_done_drop.bmp': (1440, 864, BG, 3732534), 'choose_keep.bmp': (432, 560, PAGE, 725814),
    'choose_drop.bmp': (432, 560, PAGE, 725814), 'twig.bmp': (120, 380, PAGE, 136854),
    'warn_gold.bmp': (36, 36, FIELD, 3942), 'warn_ink.bmp': (24, 24, PAPER, 1782),
    'stub.bmp': (16, 16, BG, 822), 'portable-splash.bmp': (900, 600, BG, 1620054),
}

SRC = {
    'figure': os.path.join(ROOT, 'public/art/figure-official.webp'),
    'splash': os.path.join(ROOT, 'public/art/splash-official.webp'),
    'face': os.path.join(ROOT, 'public/art/her/face-gentle.webp'),
    'night': os.path.join(ROOT, 'public/wallpapers/night-2560.webp'),
}
FONT_SERIF = 'C:/Windows/Fonts/NotoSerifSC-VF.ttf'
FONT_SANS = 'C:/Windows/Fonts/msyh.ttc'
FONT_CINZEL_WOFF = os.path.abspath(os.path.join(ROOT, '..', 'design', 'boot', 'assets', 'fonts', 'cinzel-latin.woff'))

CW, CH = 720 * S, 432 * S


def save_bmp(im, name):
    assert im.mode == 'RGB'
    w, h, _, _ = SPEC[name]
    assert im.size == (w, h), (name, im.size, (w, h))
    im.save(os.path.join(OUT, name), format='BMP')


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()


def readback(name):
    """回读 BMP 头：24 位、BI_RGB、40 字节信息头（无色彩空间块）、自底向上、体积与清单一致。"""
    p = os.path.join(OUT, name)
    with open(p, 'rb') as f:
        d = f.read(54)
    assert d[:2] == b'BM'
    off = struct.unpack('<I', d[10:14])[0]
    hsz, w, h, planes, bpp, comp, isz = struct.unpack('<IiiHHII', d[14:38])
    assert hsz == 40 and bpp == 24 and comp == 0 and planes == 1 and off == 54, (name, hsz, bpp, comp, off)
    assert h > 0, 'must be bottom-up'
    ew, eh, _, eb = SPEC[name]
    assert (w, h) == (ew, eh), (name, w, h)
    assert os.path.getsize(p) == ((w * 3 + 3) & ~3) * h + 54
    return {'px': [w, h], 'bytes': os.path.getsize(p), 'expected_bytes': eb, 'bpp': bpp, 'compression': 'BI_RGB',
            'header_bytes': hsz, 'bottom_up': True, 'sha256': sha(p)}


if '--placeholder' in sys.argv:
    os.makedirs(OUT, exist_ok=True)
    for n, (w, h, c, _) in SPEC.items():
        save_bmp(Image.new('RGB', (w, h), c), n)
    print('placeholders', len(SPEC))
    sys.exit(0)

# =====================================================================================
#                                      工具
# =====================================================================================
_tmp = tempfile.mkdtemp(prefix='alight-art-')
FONT_CINZEL_TTF = os.path.join(_tmp, 'cinzel.ttf')
from fontTools.ttLib import TTFont  # noqa: E402
_f = TTFont(FONT_CINZEL_WOFF)
_f.flavor = None
_f.save(FONT_CINZEL_TTF)


def serif(size, wght=600):
    f = ImageFont.truetype(FONT_SERIF, size)
    f.set_variation_by_axes([wght])
    return f


def cinzel(size, wght=500):
    f = ImageFont.truetype(FONT_CINZEL_TTF, size)
    try:
        f.set_variation_by_axes([wght])
    except Exception:
        pass
    return f


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def styx_color(t):
    return lerp(STYX[0], STYX[1], t * 2) if t < .5 else lerp(STYX[1], STYX[2], (t - .5) * 2)


def solid(w, h, c):
    return Image.new('RGB', (w, h), c)


def paste_alpha(base_rgb, over_rgba, xy):
    base = base_rgb.convert('RGBA')
    base.alpha_composite(over_rgba, dest=xy)
    return base.convert('RGB')


def text_spaced(draw, xy, s, font, fill, spacing=0.0):
    x, y = xy
    for ch in s:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing
    return x


def lum(rgb):
    def f(c):
        c = c / 255
        return c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
    r, g, b = [f(x) for x in rgb]
    return .2126 * r + .7152 * g + .0722 * b


def contrast(a, b):
    la, lb = lum(a), lum(b)
    if la < lb:
        la, lb = lb, la
    return (la + .05) / (lb + .05)


def bez(p0, p1, p2, p3, n=24):
    pts = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


# ---------- 自绘：蝶 / 火种 / 花 / 枝 ----------
def butterfly(px, openness=1.0, color=BLUE):
    SSx = 8
    N = px * SSx
    im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = N / 2, N / 2

    def wing(sign):
        k = sign * openness
        up = bez((cx, cy - .02 * N), (cx + k * .10 * N, cy - .46 * N), (cx + k * .52 * N, cy - .46 * N), (cx + k * .46 * N, cy - .10 * N))
        up += bez((cx + k * .46 * N, cy - .10 * N), (cx + k * .36 * N, cy + .02 * N), (cx + k * .12 * N, cy + .02 * N), (cx, cy + .02 * N))
        lo = bez((cx, cy + .02 * N), (cx + k * .34 * N, cy + .00 * N), (cx + k * .44 * N, cy + .30 * N), (cx + k * .24 * N, cy + .40 * N))
        lo += bez((cx + k * .24 * N, cy + .40 * N), (cx + k * .10 * N, cy + .44 * N), (cx, cy + .22 * N), (cx, cy + .02 * N))
        return up, lo

    light = lerp(color, (255, 255, 255), .55)
    deep = (0x2E, 0x54, 0xB8)
    for sign in (-1, 1):
        up, lo = wing(sign)
        d.polygon(up, fill=lerp(color, deep, .45) + (250,))
        d.polygon(lo, fill=lerp(color, (0x86, 0x5C, 0xB0), .55) + (245,))
        d.line(up + [up[0]], fill=deep + (255,), width=int(.022 * N), joint='curve')
        d.line(lo + [lo[0]], fill=deep + (255,), width=int(.018 * N), joint='curve')
        inner = [(cx + (x - cx) * .62, cy + (y - cy) * .62) for x, y in up]
        d.polygon(inner, fill=color + (150,))
        d.line([(cx, cy), (cx + sign * openness * .36 * N, cy - .22 * N)], fill=light + (170,), width=int(.008 * N))
        r = .035 * N
        ex, ey = cx + sign * openness * .30 * N, cy - .16 * N
        d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=(235, 248, 255, 230))
    d.line([(cx, cy - .12 * N), (cx, cy + .20 * N)], fill=(40, 30, 70, 255), width=int(.030 * N))
    d.line([(cx, cy - .12 * N), (cx - .09 * N, cy - .26 * N)], fill=(200, 230, 250, 220), width=int(.008 * N))
    d.line([(cx, cy - .12 * N), (cx + .09 * N, cy - .26 * N)], fill=(200, 230, 250, 220), width=int(.008 * N))
    return im.resize((px, px), Image.LANCZOS)


def spark(px, color=ACCENT):
    SSx = 8
    N = px * SSx
    im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = N / 2, N / 2
    for k in range(5):
        a = math.radians(-90 + 72 * k)
        r0, r1 = .10 * N, (.46 if k % 2 == 0 else .36) * N
        p0 = (cx + r0 * math.cos(a), cy + r0 * math.sin(a))
        p1 = (cx + r1 * math.cos(a), cy + r1 * math.sin(a))
        d.line([p0, p1], fill=color + (255,), width=int(.075 * N))
        for p in (p0, p1):
            rr = .0375 * N
            d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=color + (255,))
    return im.resize((px, px), Image.LANCZOS)


def blossom(d, x, y, r, petal=(0xE9, 0xE1, 0xF4), core=(0xF6, 0xD7, 0x8A), a=255):
    for k in range(5):
        ang = math.radians(-90 + 72 * k)
        px_, py_ = x + r * .62 * math.cos(ang), y + r * .62 * math.sin(ang)
        rr = r * .5
        d.ellipse([px_ - rr, py_ - rr, px_ + rr, py_ + rr], fill=petal + (a,))
    rr = r * .28
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=core + (a,))


def styx_line(im, x0, x1, y, alpha=.55, thick=2):
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    n = x1 - x0
    for i in range(0, n, 2):
        c = styx_color(i / n)
        e = min(1, i / 60, (n - i) / 60)
        d.line([(x0 + i, y), (x0 + i + 2, y)], fill=c + (int(255 * alpha * e),), width=thick)
    return paste_alpha(im, ov, (0, 0))


def wordmark(end='spark', big=True, sub_px=None, tail_px=None):
    """字标：栖枝 / ALIGHT / 细线 + 火种（或落定的蝶）/ 遐蝶的 Agent 工作台。RGBA。"""
    k = 1.0 if big else .62
    W, H = int(520 * k), int(300 * k)
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    text_spaced(d, (0, 0), '栖枝', serif(int(112 * k), 600), TITLE + (255,), spacing=int(10 * k))
    text_spaced(d, (int(6 * k), int(150 * k)), 'ALIGHT', cinzel(int(28 * k), 500), ACCENT + (255,), spacing=.42 * 28 * k)
    ly, n = int(206 * k), int(250 * k)
    for i in range(n):
        c = styx_color(i / n)
        e = min(1, i / 30)
        d.line([(int(6 * k) + i, ly), (int(6 * k) + i + 1, ly)], fill=c + (int(255 * .7 * e),), width=max(2, int(3 * k)))
    tip = (int(6 * k) + n, ly)
    if end == 'spark':
        im.alpha_composite(spark(int(30 * k)), dest=(tip[0] - int(2 * k), tip[1] - int(15 * k)))
    else:
        tp = tail_px or int(54 * k)
        # 线尾落定的蝶：以线尾为落点，翅展在 tp 的 0.5 倍左右（整页 2 倍母版，显示约 tp/4 DIP 的翅展）
        im.alpha_composite(butterfly(tp, .62), dest=(tip[0] - int(tp * .62), tip[1] - int(tp * .84)))
    sp = sub_px or int(22 * k)
    text_spaced(d, (int(6 * k), int(228 * k)), '遐蝶的 Agent 工作台', serif(sp, 500 if sub_px else 400), TEXT3 + (255,), spacing=int(2 * k))
    return im


# ---------- 夜景（AI 辅助同人图，只取不含她的左下景） ----------
import cv2  # noqa: E402

_night = np.array(Image.open(SRC['night']).convert('RGB'))
NH, NW = _night.shape[:2]
assert (NW, NH) == (2560, 1440)


def _ellipse_soft(shape, cx, cy, rx, ry, power=2.0):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    return np.clip(1 - r, 0, 1) ** (1 / power)


def make_night(drop):
    """keep：原图。drop：蝶离枝（枝上的蝶与花环旁的小蝶抹掉）、落一片瓣、一盏花环熄灭。只改夜景，不碰官方图。"""
    a = _night.copy()
    if not drop:
        return a
    # 1 枝上的蝶（源图约 577..652, 1105..1190）和花环旁的小蝶（720..742, 880..910）：
    #   用正上方一块干净的水面羽化覆盖（保留水纹质感，比修补不留糊斑）
    f0 = a.astype(np.float32)
    for (x0, y0, x1, y1, dy) in ((574, 1100, 660, 1188, -100), (698, 866, 768, 932, -76)):
        m = np.zeros((NH, NW), np.float32)
        m[y0:y1, x0:x1] = 1
        m = cv2.GaussianBlur(m, (0, 0), 5)
        m[y0 + 14:y1 - 14, x0 + 14:x1 - 14] = 1
        shifted = np.roll(f0, -dy, axis=0)          # shifted[y] = f0[y + dy]
        f0 = f0 * (1 - m[..., None]) + shifted * m[..., None]
    a = np.clip(f0, 0, 255).astype(np.uint8)
    # 2 花环熄一盏：中间那只花环（约 565..810, 905..975）压暗并降饱和
    f = a.astype(np.float32)
    w = _ellipse_soft((NH, NW), 688, 940, 190, 100, power=1.2)[..., None]
    gray = f.mean(axis=2, keepdims=True)
    dim = (f * .30 + gray * .10)
    f = f * (1 - w * .9) + dim * (w * .9)
    a = np.clip(f, 0, 255).astype(np.uint8)
    im = Image.fromarray(a).convert('RGBA')
    # 2b 蝶身压过的那一段枝补画（枝从左下伸向右上，蝶停在它上面；枝梢在抹除框之外原样保留）
    SSx = 4
    lay = Image.new('RGBA', (140 * SSx, 90 * SSx), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    ox, oy = 560, 1120
    pts = [(572, 1203), (596, 1196), (616, 1186), (640, 1171), (662, 1157), (686, 1140)]
    for (x0, y0), (x1, y1), wdt in zip(pts, pts[1:], (9, 8, 7, 6, 5)):
        ld.line([((x0 - ox) * SSx, (y0 - oy) * SSx), ((x1 - ox) * SSx, (y1 - oy) * SSx)], fill=(58, 40, 62, 255), width=wdt * SSx)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):                     # 枝背上一线冷色高光
        ld.line([((x0 - ox) * SSx, (y0 - oy - 2) * SSx), ((x1 - ox) * SSx, (y1 - oy - 2) * SSx)], fill=(120, 104, 150, 150), width=2 * SSx)
    lay = lay.resize((140, 90), Image.LANCZOS)
    im.alpha_composite(lay, dest=(ox, oy))
    # 3 一片落瓣（叶形，单色渐变，不描边），落在原来蝶的位置上方
    SSx = 8
    pw, ph = 46 * SSx, 24 * SSx
    petal = Image.new('RGBA', (pw, ph), (0, 0, 0, 0))
    pd = ImageDraw.Draw(petal)
    top = bez((0, ph * .55), (pw * .25, 0), (pw * .75, ph * .05), (pw, ph * .5), 30)
    bot = bez((pw, ph * .5), (pw * .72, ph * 1.0), (pw * .25, ph * 1.0), (0, ph * .55), 30)
    pd.polygon(top + bot, fill=(0xE4, 0xCC, 0xEC, 240))
    pd.polygon([(x * .8 + pw * .1, y * .55 + ph * .22) for x, y in top + bot], fill=(0xF2, 0xE2, 0xF6, 150))
    petal = petal.rotate(28, expand=True, resample=Image.BICUBIC)
    petal = petal.resize((petal.width // SSx, petal.height // SSx), Image.LANCZOS)
    im.alpha_composite(petal, dest=(604, 1112))
    return np.array(im.convert('RGB'))


NIGHT_KEEP = Image.fromarray(make_night(False))
NIGHT_DROP = Image.fromarray(make_night(True))


def night_crop(u0, v0, u1, v1, size, src=None):
    """夜景裁切并缩放到 size。硬规则：只取不含她的部分（u1 <= 0.43）。"""
    assert u1 <= .43 + 1e-9 and u0 >= 0, ('crop includes her', u0, u1)
    im = NIGHT_KEEP if src is None else src
    c = im.crop((round(u0 * NW), round(v0 * NH), round(u1 * NW), round(v1 * NH)))
    ca, ta = c.size[0] / c.size[1], size[0] / size[1]
    assert abs(ca - ta) / ta < .012, ('crop aspect', name_of(size), ca, ta)
    return c.resize(size, Image.LANCZOS), c.size


def name_of(size):
    return '%dx%d' % size


def veil(im, k=.55, tint=BG, top_dark=.0):
    base = solid(*im.size, tint)
    out = Image.blend(base, im, k)
    if top_dark:
        w, h = im.size
        g = np.linspace(top_dark, 0, int(h * .45))
        a = np.zeros(h)
        a[:len(g)] = g
        mask = Image.fromarray((np.tile(a[:, None], (1, w)) * 255).astype('uint8'), 'L')
        out = Image.composite(base, out, mask)
    return out


def fade_v(im, y0, y1, bg, down=True):
    w, h = im.size
    t = np.clip((np.arange(h) - y0) / max(1, (y1 - y0)), 0, 1)
    t = t * t * (3 - 2 * t)
    a = t if down else 1 - t
    mask = Image.fromarray((np.tile(a[:, None], (1, w)) * 255).astype('uint8'), 'L')
    return Image.composite(solid(w, h, bg), im, mask)


def board_over(scene, solid_to_dip, fade_dip, color=BG):
    """左板：x < solid_to_dip 逐值等于 color，其后 fade_dip 平滑渐入 scene。"""
    w, h = scene.size
    x0, x1 = solid_to_dip * S, (solid_to_dip + fade_dip) * S
    t = np.clip((np.arange(w) - x0) / max(1, (x1 - x0)), 0, 1)
    t = t * t * (3 - 2 * t)
    a = 1 - t
    a[:x0 + 1] = 1.0
    mask = Image.fromarray((np.tile(a[None, :], (h, 1)) * 255).round().astype('uint8'), 'L')
    return Image.composite(solid(w, h, color), scene, mask)


def rounded_on(im, radius, bg):
    w, h = im.size
    m = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=radius * 4, fill=255)
    m = m.resize((w, h), Image.LANCZOS)
    return Image.composite(im, solid(w, h, bg), m)


# ---------- 官方素材 ----------
FACE = Image.open(SRC['face']).convert('RGB')
FIGURE = Image.open(SRC['figure']).convert('RGBA')
SPLASH = Image.open(SRC['splash']).convert('RGBA')
FACE_CROP = (70, 0, 460, 390)     # 取景框：x70-460, y0-390（文件本身不动）
placements = []                   # 官方图落点登记，用于回读


def face_chip(size_px, radius_frac=.14):
    assert size_px <= 390, 'face enlarged'
    im = FACE.crop(FACE_CROP).resize((size_px, size_px), Image.LANCZOS).convert('RGBA')
    m = Image.new('L', (size_px * 4, size_px * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size_px * 4 - 1, size_px * 4 - 1], radius=int(size_px * 4 * radius_frac), fill=255)
    im.putalpha(m.resize((size_px, size_px), Image.LANCZOS))
    return im


def place_face(page, base, size_px, xy):
    chip = face_chip(size_px)
    placements.append({'page': page, 'kind': 'face', 'size_px': size_px, 'xy_px': list(xy), 'natural_crop_px': 390})
    return paste_alpha(base, chip, xy)


def place_official(page, base, img, kind, w, h, xy):
    assert w <= img.width and h <= img.height, (kind, 'enlarged')
    assert abs(w / h - img.width / img.height) < .002, (kind, 'distorted')
    assert xy[0] >= 0 and xy[1] >= 0 and xy[0] + w <= base.width and xy[1] + h <= base.height, (kind, 'cropped by canvas')
    r = img.resize((w, h), Image.LANCZOS)
    placements.append({'page': page, 'kind': kind, 'size_px': [w, h], 'xy_px': list(xy), 'natural_px': list(img.size),
                       'scale': round(w / img.width, 4), 'resized': r})
    return paste_alpha(base, r, xy)


def rect_px(rect_dip):
    x, y, w, h = rect_dip
    return (round(x * S), round(y * S), round((x + w) * S), round((y + h) * S))


def assert_solid(page, im, rect_dip, color, label):
    x0, y0, x1, y1 = rect_px(rect_dip)
    a = np.array(im)[y0:y1, x0:x1].reshape(-1, 3)
    bad = int((a != np.array(color)).any(axis=1).sum())
    assert bad == 0, ('%s %s 板内有 %d 个像素不是板色' % (page, label, bad))


manifest = {'generated_by': 'scripts/gen-installer-art.py', 'scale': S, 'sources': {}, 'outputs': {}, 'official': [], 'checks': {}}
for k, p in SRC.items():
    im0 = Image.open(p)
    manifest['sources'][k] = {'path': os.path.relpath(p, ROOT).replace('\\', '/'), 'px': list(im0.size), 'mode': im0.mode, 'sha256': sha(p)}

os.makedirs(OUT, exist_ok=True)
pages = {}

# =====================================================================================
# 1 header.bmp  1440x128  整幅 BG，只有官方表情片（无字标，无底线）
# =====================================================================================
hdr = solid(1440, 128, BG)
hdr = place_face('header', hdr, 112, (16 * S, 4 * S))
pages['header.bmp'] = hdr
# 板：除头像外整幅纯色
a = np.array(hdr)
a_mask = np.ones(a.shape[:2], bool)
a_mask[4 * S:4 * S + 112, 16 * S:16 * S + 112] = False
assert (a[a_mask] == np.array(BG)).all(), 'header not solid outside chip'

# =====================================================================================
# 2 welcome.bmp  左板 0..336 DIP 纯 BG（含所有文字控件，IMPL 里署名矩形伸到 336），之后 24 DIP 渐入夜景
# =====================================================================================
scene, _ = night_crop(0.0, 0.46, 0.43, 0.918, (CW, CH))
scene = veil(scene, .52, BG, top_dark=.55)
scene = fade_v(scene, int(CH * .82), CH, BG)
# 夜景底边不再画冥河细线：它只横跨图宽，与按钮栏分隔线挨得太近，像残线（评审意见）
w_ = board_over(scene, 336, 24)
w_ = place_official('welcome', w_, FIGURE, 'figure', 567, 768, (396 * S, 20 * S))
w_ = paste_alpha(w_, wordmark('spark', True), (36 * S, 28 * S))
pages['welcome.bmp'] = w_
for label, r in (('title', (36, 196, 280, 28)), ('facts', (36, 232, 296, 64)), ('her', (36, 306, 290, 40)),
                 ('sign1', (36, 384, 300, 14)), ('sign2', (36, 398, 300, 14))):
    assert_solid('welcome', w_, r, BG, label)
for c_name, c in (('TEXT2', TEXT2), ('ACCENT', ACCENT), ('TITLE', TITLE), ('TEXT3', TEXT3)):
    assert contrast(c, BG) >= 7, ('contrast', c_name)

# =====================================================================================
# 3 finish.bmp  整页 BG，官方 splash 800x800 放 (320,16) DIP，左上小字标（线尾停蝶）
# =====================================================================================
fin = solid(CW, CH, BG)
fin = place_official('finish', fin, SPLASH, 'splash', 800, 800, (320 * S, 16 * S))
# 副标 24 px 母版 = 12 DIP（100% 下 12 px），线尾的蝶翅展约 14 DIP
fin = paste_alpha(fin, wordmark('butterfly', False, sub_px=24, tail_px=52), (28 * S, 24 * S))
pages['finish.bmp'] = fin
for label, r in (('title', (28, 128, 288, 28)), ('receipt', (24, 168, 288, 148)), ('her', (28, 332, 288, 40)),
                 ('run', (28, 380, 288, 20))):
    assert_solid('finish', fin, r, BG, label)
# 署名行 (28,404,300,14) 伸到 x=328 DIP，比 splash 左缘 320 DIP 多 8 DIP：只允许落在 splash 的透明区
sx0, sy0, sx1, sy1 = rect_px((28, 404, 300, 14))
sp_r = [p for p in placements if p['page'] == 'finish'][0]['resized']
sub = np.array(sp_r)[max(0, sy0 - 16 * S):sy1 - 16 * S, 0:max(0, sx1 - 320 * S), 3]
assert sub.size == 0 or int(sub.max()) == 0, 'finish signature rect overlaps opaque splash pixels'

# =====================================================================================
# 4 band.bmp  1440x320  夜景横带 + 花环上一只静止的自绘蝶；下沿渐入 PAGE
# =====================================================================================
band, _ = night_crop(0.0, 0.565, 0.43, 0.734, (1440, 320))
band = veil(band, .62, PAGE)
# 左侧光斑压暗：源图左侧约 1/4 有几团大虚化光斑，像屏幕上的脏点。整块左缘向 PAGE 渐暗（左缘约 95%，到 x=520 px 归零），
# 再对左 1/3 里仍然偏亮的像素做软削顶，保证光斑不再比周围水面亮
f = np.array(band).astype(np.float32)
H_, W_ = f.shape[:2]
xs = np.arange(W_, dtype=np.float32)
t = np.clip(xs / 520.0, 0, 1)
t = t * t * (3 - 2 * t)
wl = (.95 * (1 - t))[None, :, None]
f = f * (1 - wl) + np.array(PAGE, np.float32) * wl
cap = 40.0 + 140.0 * np.clip(xs / 520.0, 0, 1)             # 左缘亮度上限 40，渐放到 180（右侧基本不动）
lum_ = f.mean(axis=2, keepdims=True)
over = np.clip(lum_ - cap[None, :, None], 0, None)
f = f - over * np.clip(1 - xs / 560.0, 0, 1)[None, :, None] * .95
# 虚化光斑本身（低频亮斑）：比周围水面亮出一截的大块，逐块按超出量继续压向 PAGE（只在左 700 px 内）
g_ = f.mean(axis=2)
lo_ = cv2.GaussianBlur(g_, (0, 0), 22)
bg_ = cv2.GaussianBlur(g_, (0, 0), 140)
exc_ = np.clip(lo_ - bg_ - 2.0, 0, None)
zone_ = np.clip(1 - xs / 700.0, 0, 1)[None, :]
w2_ = np.clip(exc_ / 10.0, 0, 1) * zone_ * .85
f = f * (1 - w2_[..., None]) + np.array(PAGE, np.float32) * w2_[..., None]
band = Image.fromarray(np.clip(f, 0, 255).astype(np.uint8))
band = fade_v(band, 320 - 70, 320 - 6, PAGE)              # 下沿 35 DIP 渐入，最后 3 DIP 恰为 PAGE
band = fade_v(band, 0, 12, BG, down=False)                # 上沿 6 DIP 接页眉色
band = paste_alpha(band, butterfly(60, .5), (850, 80))     # 停在花环上，半合翅，静止
pages['band.bmp'] = band
assert (np.array(band)[-6:] == np.array(PAGE)).all(), 'band bottom not PAGE'

# =====================================================================================
# 5 un_welcome.bmp  左板 0..330 BG（头像在板内），右侧夜景面板 (344,26,360,380) 圆角 8
# =====================================================================================
uw = solid(CW, CH, BG)
pn, _ = night_crop(0.06, 0.40, 0.36, 0.40 + 0.30 * 2560 / 1440 * (380 / 360), (720, 760))
pn = veil(pn, .62, BG, top_dark=.30)
uw.paste(rounded_on(pn, 8 * S, BG), (344 * S, 26 * S))
uw = place_face('un_welcome', uw, 224, (36 * S, 36 * S))
pages['un_welcome.bmp'] = uw
for label, r in (('title', (36, 168, 280, 28)), ('facts', (36, 206, 284, 96)), ('sign1', (36, 382, 300, 14)), ('sign2', (36, 396, 300, 14))):
    assert_solid('un_welcome', uw, r, BG, label)


# =====================================================================================
# 6 un_done_keep / un_done_drop  左板 0..330 BG，右侧夜景大图（左缘 24 DIP 渐入），同构图
# =====================================================================================
def un_done(drop):
    pw = 390 * S
    u0, u1 = 0.0825, 0.4125
    v1 = 1.0
    v0 = v1 - (u1 - u0) * 2560 / 1440 * (CH / pw)
    big, _ = night_crop(u0, v0, u1, v1, (pw, CH), NIGHT_DROP if drop else NIGHT_KEEP)
    big = veil(big, .66, BG, top_dark=.55)
    scene = solid(CW, CH, BG)
    scene.paste(big, (CW - pw, 0))
    im = board_over(scene, 330, 24)
    name = 'un_done_drop' if drop else 'un_done_keep'
    im = place_face(name, im, 112, (28 * S, 24 * S))
    mm = wordmark('spark', False)
    im = paste_alpha(im, mm.crop((0, 0, mm.width, 140)), (96 * S, 20 * S))
    for label, r in (('title', (28, 100, 296, 36)), ('receipt', (28, 142, 296, 130)), ('her', (28, 342, 296, 24)),
                     ('readme', (28, 372, 296, 22)), ('sign1', (28, 396, 300, 14)), ('sign2', (28, 410, 300, 14))):
        # 标题行与字标之间留给标题控件：字标最低到 y≈20+133/2 = 86 DIP，所以 title 区从 100 起
        assert_solid(name, im, r, BG, label)
    return im


pages['un_done_keep.bmp'] = un_done(False)
pages['un_done_drop.bmp'] = un_done(True)

# =====================================================================================
# 7 choose_keep / choose_drop  432x560  同裁景，drop 蝶离枝、落瓣、花环熄一盏
# =====================================================================================
for drop in (False, True):
    u0, u1 = 0.10, 0.40
    v1 = 1.0
    v0 = v1 - (u1 - u0) * 2560 / 1440 * (560 / 432)
    c, _ = night_crop(u0, v0, u1, v1, (432, 560), NIGHT_DROP if drop else NIGHT_KEEP)
    c = veil(c, .70, PAGE, top_dark=.25)
    pages['choose_drop.bmp' if drop else 'choose_keep.bmp'] = rounded_on(c, 8 * S, PAGE)

# =====================================================================================
# 8 twig.bmp  120x380  PAGE 底、自绘枝与静止的蝶
# =====================================================================================
def twig_img(w, h):
    SSx = 4
    im = Image.new('RGBA', (w * SSx, h * SSx), PAGE + (255,))
    d = ImageDraw.Draw(im)
    rnd = random.Random(7)
    ink = (0x9A, 0x84, 0xB4)
    x = w * SSx * .5
    pts = [(x, 0)]
    for i in range(1, 41):
        pts.append((x + math.sin(i * .5) * 5 * SSx * .5 + rnd.uniform(-1, 1) * SSx, i * h * SSx / 40))
    d.line(pts, fill=ink + (255,), width=int(3.4 * SSx), joint='curve')
    buds = [60, 190, 300]
    tips = []
    for by in buds:
        j = min(range(len(pts)), key=lambda i: abs(pts[i][1] - by * SSx))
        bx, byy = pts[j]
        d.line([(bx, byy), (bx + 22 * SSx, byy - 9 * SSx)], fill=ink + (255,), width=int(2.4 * SSx))
        d.line([(bx, byy + 10 * SSx), (bx - 18 * SSx, byy + 20 * SSx)], fill=ink + (220,), width=int(2.0 * SSx))
        tips.append((bx + 22 * SSx, byy - 9 * SSx))
    for _ in range(26):
        px_, py_ = pts[rnd.randrange(len(pts))]
        r = rnd.uniform(.9, 1.7) * SSx
        d.ellipse([px_ - r + 2 * SSx, py_ - r - 1.6 * SSx, px_ + r + 2 * SSx, py_ + r - 1.6 * SSx], fill=(232, 224, 244, 210))
    for tx, ty in tips[1:]:
        blossom(d, tx, ty, 7 * SSx)
    out = im.resize((w, h), Image.LANCZOS)
    tx, ty = tips[0]
    bf = butterfly(46, .5)
    out.alpha_composite(bf, dest=(int(tx / SSx) - 28, int(ty / SSx) - 36))     # 停在最上面的枝头，静止
    return out.convert('RGB')


pages['twig.bmp'] = twig_img(120, 380)

# =====================================================================================
# 9 警示三角（自绘）、stub
# =====================================================================================
def warn_icon(px, bg, stroke, lw):
    SSx = 8
    N = px * SSx
    im = Image.new('RGB', (N, N), bg)
    d = ImageDraw.Draw(im)
    m = N * .08
    tri = [(N / 2, m + N * .02), (N - m, N - m - N * .04), (m, N - m - N * .04)]
    d.line(tri + [tri[0], tri[1]], fill=stroke, width=int(lw * SSx), joint='curve')
    for p in tri:
        r = lw * SSx / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=stroke)
    d.line([(N / 2, N * .38), (N / 2, N * .62)], fill=stroke, width=int(lw * SSx))
    r = lw * SSx * .62
    d.ellipse([N / 2 - r, N * .745 - r, N / 2 + r, N * .745 + r], fill=stroke)
    return im.resize((px, px), Image.LANCZOS)


pages['warn_gold.bmp'] = warn_icon(36, FIELD, GOLD, 2.6)
pages['warn_ink.bmp'] = warn_icon(24, PAPER, GOLD_INK, 2.0)
pages['stub.bmp'] = solid(16, 16, BG)

# =====================================================================================
# 10 portable-splash.bmp  900x600  BgImage 原样像素；署名烘在图里
# =====================================================================================
ps, _ = night_crop(0.0, 0.44, 0.43, 0.44 + .43 * 2560 / 1440 * (600 / 900), (900, 600))
ps = veil(ps, .55, BG, top_dark=.50)
ps = fade_v(ps, 380, 600, BG)
# 顶部不再画冥河细线：它没有横贯全幅，像残线（评审意见）
ps = place_official('portable', ps, FIGURE, 'figure', 399, 540, (900 - 399 - 56, 30))
ps = paste_alpha(ps, wordmark('spark', False, sub_px=16), (36, 44))
d = ImageDraw.Draw(ps)
sans = ImageFont.truetype(FONT_SANS, 14)
d.text((36, 534), '立绘：官方 © miHoYo', font=sans, fill=TEXT3)
d.text((36, 558), '画面：AI 辅助同人图 · 非官方同人', font=sans, fill=TEXT3)
pages['portable-splash.bmp'] = ps
assert sans.size >= 13

# =====================================================================================
#                                       写出与自检
# =====================================================================================
for n, im in pages.items():
    save_bmp(im, n)

# 回读：官方图不改色、落点未被后绘盖掉、未放大
for p in placements:
    page_bmp = {'header': 'header.bmp', 'welcome': 'welcome.bmp', 'finish': 'finish.bmp', 'portable': 'portable-splash.bmp',
                'un_welcome': 'un_welcome.bmp', 'un_done_keep': 'un_done_keep.bmp', 'un_done_drop': 'un_done_drop.bmp'}[p['page']]
    out = np.array(Image.open(os.path.join(OUT, page_bmp)).convert('RGB'))
    rec = {'page': page_bmp, 'kind': p['kind'], 'displayed_px': p['size_px'], 'placed_at_px': p['xy_px']}
    if p['kind'] in ('figure', 'splash'):
        w, h = p['size_px']
        x, y = p['xy_px']
        r = np.array(p['resized'])
        opaque = r[..., 3] == 255
        region = out[y:y + h, x:x + w]
        diff = np.abs(region[opaque].astype(int) - r[..., :3][opaque].astype(int))
        assert diff.max() == 0, ('official pixels were modified after placement', page_bmp, int(diff.max()))
        src = np.array(FIGURE if p['kind'] == 'figure' else SPLASH)
        sop = src[..., 3] == 255

        def wmean(arr):
            al = arr[..., 3:4].astype(np.float64)
            return (arr[..., :3] * al).sum(axis=(0, 1)) / al.sum()
        m_src = wmean(src)
        m_out = wmean(r)
        md = float(np.abs(m_src - m_out).max())
        assert md < 2, ('colour drift (alpha-weighted mean, source vs resized)', page_bmp, md)
        m_src_op = src[..., :3][sop].mean(axis=0)
        m_out_op = region[opaque].mean(axis=0)
        # 荆棘冠完整：整幅放入（上沿 y0>=0 且落点在画布内），源图第 0 行 alpha 与输出一致
        top_src = src[0, :, 3].max()
        rec.update({'natural_px': p['natural_px'], 'scale': p['scale'], 'alpha_weighted_mean_rgb_src': [round(float(v), 2) for v in m_src],
                    'alpha_weighted_mean_rgb_out': [round(float(v), 2) for v in m_out], 'max_mean_diff': round(md, 3),
                    'opaque_only_mean_rgb_src': [round(float(v), 2) for v in m_src_op],
                    'opaque_only_mean_rgb_out': [round(float(v), 2) for v in m_out_op],
                    'opaque_pixels_identical_to_resized_source': True, 'whole_image_placed': True,
                    'src_top_row_max_alpha': int(top_src)})
    else:
        s = p['size_px']
        assert s <= 390
        rec['natural_crop_px'] = 390
        rec['note'] = '显示像素 %d 来自 390 px 取景框，未放大' % s
    manifest['official'].append(rec)

for n in SPEC:
    manifest['outputs'][n] = readback(n)
    assert manifest['outputs'][n]['bytes'] == manifest['outputs'][n]['expected_bytes'], n

manifest['checks'] = {
    'night_crops_only_u_lt_0.43': True,
    'text_panel_solid_asserts': 'welcome / finish / un_welcome / un_done_keep / un_done_drop 的文字控件矩形逐值等于板色（脚本内 assert）',
    'band_bottom_equals_PAGE': True,
    'header_solid_outside_chip': True,
    'contrast_vs_AL_BG': {k: round(contrast(v, BG), 2) for k, v in (('TEXT2', TEXT2), ('ACCENT', ACCENT), ('TITLE', TITLE), ('TEXT3', TEXT3))},
    'portable_baked_text_px': 14,
    'total_bmp_bytes': sum(v['bytes'] for v in manifest['outputs'].values()),
}
with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
shutil.rmtree(_tmp, ignore_errors=True)
print(json.dumps({'outputs': {k: v['bytes'] for k, v in manifest['outputs'].items()}, 'checks': manifest['checks']}, ensure_ascii=False, indent=1))
