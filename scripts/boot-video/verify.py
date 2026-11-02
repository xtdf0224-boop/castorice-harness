"""校验：把编好的 mp4 解码回来，与无损母版逐帧比（编码损失 + 色彩管线），出交接帧 / 首帧的差异图、条带指数、解码哈希。

  python -I verify.py --codec hevc --mp4 OUT.mp4 --json OUT.json [--dump DIR] [--every 1]
指标（每帧；BT.709 亮度，8 位 RGB 域）：
  mad      亮度平均绝对差（A 层阈值 <= 0.6 / 255）        p999   亮度绝对差的 99.9 分位（<= 6）
  blk      任意 8x8 块的亮度**带符号**均值差的最大绝对值（<= 2）   maxdiff  RGB 最大像素差       psnr  RGB PSNR
  解码用 numpy 自己做 YUV -> RGB（色度双线性上采样，左对齐），独立于 swscale，量的是编码损失，不含显示端的颜色管线（那是 B 层 / calibrate.py 的事）。
条带指数（band）：在几块大面积平滑渐变区域（右侧白渐变、左侧雾、第 600 帧的雾），统计亮度 8 位台阶的平均游程长度（沿行 / 列各一遍）。
  解码后游程比母版长 = 出现了母版里没有的色带。ratio = 解码 / 母版，目标 <= 1.0（抖动会让它 < 1）。
哈希（BOOT-VIDEO 5.2 的定义）：源 = 母版该帧 RGB 字节的 sha256；解码 = ffmpeg select 取出的原始平面（HEVC yuv420p10le / H.264 yuv420p）的 sha256。
母版的第 0 / 最后一帧 PNG 另存为 <母版目录>/frame0.png、frame<最后一帧序号>.png（--dump 目录里还有解码帧与 16 倍放大的差值图）。"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

FFMPEG = r"G:/Claude Code Workplace/tools/ffmpeg/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
WORK = r"G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo"
LOCK = r"G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock"
import json as _json
_G = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geometry.json'), encoding='utf-8'))
W, H = _G['width'], _G['height']
LAST = _G['frames'] - 1          # 最后一帧 = T_END（60 fps 时是第 444 帧）

ap = argparse.ArgumentParser()
ap.add_argument("--codec", choices=["hevc", "avc"], required=True)
ap.add_argument("--mp4", required=True)
ap.add_argument("--json", required=True)
ap.add_argument("--master", default=os.path.join(WORK, "master"))
ap.add_argument("--dump", default=None)
ap.add_argument("--every", type=int, default=1)
ap.add_argument("--chroma", default="left")
ap.add_argument("--matrix", default="709", choices=["709", "601"])
ap.add_argument("--corr", default=None, help="编码时用的颜色校准图 .npz：对拍前也加到母版帧上（比的是「编码损失」，校准量是有意加的，不算损失）")
ap.add_argument("--no-lock", action="store_true")
a = ap.parse_args()
BITS = 10 if a.codec == "hevc" else 8
SC = 1 << (BITS - 8)
KR, KB = (0.299, 0.114) if a.matrix == "601" else (0.2126, 0.0722)
KG = 1.0 - KR - KB
DUMP = [0, LAST]
_B = {LAST: {"right-fade": (0.789, 0.990, 0.159, 0.794), "left-haze": (0.010, 0.237, 0.318, 0.742)}, LAST * 600 // 888: {"left-haze": (0.010, 0.237, 0.318, 0.742)}, LAST * 150 // 888: {"right-fade": (0.789, 0.990, 0.159, 0.794)}}
# 平滑渐变区（相对帧宽高的比例，按 1980x944 的第 888 / 600 / 150 帧选的）：右侧白渐变、左侧雾
BAND_FRAMES = {f: {n: (int(x0 * W), int(x1 * W), int(y0 * H), int(y1 * H)) for n, (x0, x1, y0, y1) in d.items()} for f, d in _B.items()}


CORR = None
if a.corr:
    _c = np.load(a.corr)
    CORR = (_c["t"].astype(np.float64), _c["maps"].astype(np.float32), int(_c["bs"]))


def corr_src(src, i):
    """母版帧加上编码时的校准量（与 encode.py 的 corr_for 同一套插值）；返回 uint8."""
    import cv2
    ts, ms, bs = CORR
    t = i / float(_G["fps"])
    if t <= ts[0]: m = ms[0]
    elif t >= ts[-1]: m = ms[-1]
    else:
        j = int(np.searchsorted(ts, t) - 1); f = np.float32((t - ts[j]) / (ts[j + 1] - ts[j])); m = ms[j] * (1 - f) + ms[j + 1] * f
    gh, gw = m.shape[:2]
    up = cv2.resize(m, (gw * bs, gh * bs), interpolation=cv2.INTER_LINEAR)
    pr, pb = max(0, W - gw * bs), max(0, H - gh * bs)
    if pr or pb: up = np.pad(up, ((0, pb), (0, pr), (0, 0)), mode="edge")
    return np.clip(np.floor(src.astype(np.float32) + up[:H, :W] + np.float32(0.5)), 0, 255).astype(np.uint8)


def lower_priority():
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
    except Exception:
        pass


def yuv_to_rgb(raw):
    dt = np.uint16 if BITS > 8 else np.uint8
    ysz, csz = W * H, (W // 2) * (H // 2)
    arr = np.frombuffer(raw, dtype=dt)
    Y = arr[:ysz].reshape(H, W).astype(np.float32)
    cb = arr[ysz:ysz + csz].reshape(H // 2, W // 2).astype(np.float32)
    cr = arr[ysz + csz:ysz + 2 * csz].reshape(H // 2, W // 2).astype(np.float32)

    def up(c):
        # 水平：偶数列 = 样本，奇数列 = 相邻平均（左对齐）；垂直：双线性（0.75 / 0.25）
        p = np.pad(c, ((0, 0), (0, 1)), mode="edge")
        h = np.empty((c.shape[0], W), np.float32)
        h[:, 0::2] = c
        h[:, 1::2] = (p[:, :-1] + p[:, 1:]) * np.float32(0.5)
        pv = np.pad(h, ((1, 1), (0, 0)), mode="edge")
        v = np.empty((H, W), np.float32)
        v[0::2] = np.float32(0.75) * h + np.float32(0.25) * pv[0:-2]
        v[1::2] = np.float32(0.75) * h + np.float32(0.25) * pv[2:]
        return v

    y = (Y - np.float32(16 * SC)) * np.float32(1.0 / (219 * SC))
    cbf = (up(cb) - np.float32(128 * SC)) * np.float32(1.0 / (224 * SC))
    crf = (up(cr) - np.float32(128 * SC)) * np.float32(1.0 / (224 * SC))
    r = y + np.float32(2 * (1 - KR)) * crf
    b = y + np.float32(2 * (1 - KB)) * cbf
    g = (y - np.float32(KR) * r - np.float32(KB) * b) * np.float32(1.0 / KG)
    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(np.floor(rgb * np.float32(255.0) + np.float32(0.5)), 0, 255).astype(np.uint8)


def luma(rgb):
    x = rgb.astype(np.float32)
    return np.float32(0.2126) * x[..., 0] + np.float32(0.7152) * x[..., 1] + np.float32(0.0722) * x[..., 2]


def metrics(src, dec):
    d = dec.astype(np.int16) - src.astype(np.int16)
    ly = luma(dec) - luma(src)
    ad = np.abs(ly)
    h8, w8 = (H // 8) * 8, (W // 8) * 8
    blk = ly[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8).mean(axis=(1, 3))
    mse = float(np.mean(d.astype(np.float32) ** 2))
    return {"mad": float(ad.mean()), "p999": float(np.percentile(ad, 99.9)), "blk": float(np.abs(blk).max()), "maxdiff": int(np.abs(d).max()),
            "psnr": float(10 * np.log10(255.0 ** 2 / max(mse, 1e-9)))}


def runlen(l8):
    """8 位亮度的平均游程长度（沿行与列各数一遍）。"""
    tot, cnt = 0, 0
    for arr in (l8, l8.T):
        ch = (np.diff(arr.astype(np.int16), axis=1) != 0)
        runs = arr.shape[0] * 1 + int(ch.sum())          # 每行的游程数 = 1 + 变化次数
        tot += arr.shape[0] * arr.shape[1]
        cnt += runs
    return tot / cnt


def band(src, dec, box):
    x0, x1, y0, y1 = box
    ls = np.clip(np.round(luma(src[y0:y1, x0:x1])), 0, 255).astype(np.uint8)
    ld = np.clip(np.round(luma(dec[y0:y1, x0:x1])), 0, 255).astype(np.uint8)
    rs, rd = runlen(ls), runlen(ld)
    return {"srcRun": round(rs, 3), "decRun": round(rd, 3), "ratio": round(rd / rs, 3)}


def main():
    lower_priority()
    segs = sorted(f for f in os.listdir(a.master) if f.startswith("seg_") and f.endswith(".mkv") and ".part" not in f)
    lst = os.path.join(WORK, "master-concat.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            f.write("file '%s'\n" % os.path.join(a.master, s).replace("\\", "/"))
    if not a.no_lock:
        while True:
            try:
                os.mkdir(LOCK)
                break
            except FileExistsError:
                print("heavy-lock held, waiting", flush=True)
                time.sleep(15)
    try:
        pix = "yuv420p10le" if BITS == 10 else "yuv420p"
        rd = subprocess.Popen([FFMPEG, "-hide_banner", "-loglevel", "error", "-threads", "4", "-f", "concat", "-safe", "0", "-i", lst, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, bufsize=W * H * 6)
        dd = subprocess.Popen([FFMPEG, "-hide_banner", "-loglevel", "error", "-threads", "4", "-i", a.mp4, "-f", "rawvideo", "-pix_fmt", pix, "-"], stdout=subprocess.PIPE, bufsize=W * H * 6)
        rsz = W * H * 3
        dsz = W * H * 3 // 2 * (2 if BITS > 8 else 1)
        per, bands, src_hash, dec_raw_hash = [], {}, {}, {}
        i = 0
        if a.dump:
            os.makedirs(a.dump, exist_ok=True)
        t0 = time.time()
        while True:
            sb = rd.stdout.read(rsz)
            db = dd.stdout.read(dsz)
            if len(sb) < rsz or len(db) < dsz:
                break
            if i in DUMP:
                src_hash[i] = hashlib.sha256(sb).hexdigest()
                dec_raw_hash[i] = hashlib.sha256(db).hexdigest()
            if i % a.every == 0 or i in DUMP or i in BAND_FRAMES:
                src_raw = np.frombuffer(sb, np.uint8).reshape(H, W, 3)
                src = corr_src(src_raw, i) if CORR is not None else src_raw
                dec = yuv_to_rgb(db)
                m = metrics(src, dec)
                m["i"] = i
                per.append(m)
                if i in BAND_FRAMES:
                    bands[str(i)] = {k: band(src, dec, v) for k, v in BAND_FRAMES[i].items()}
                if i in DUMP:
                    Image.fromarray(src_raw).save(os.path.join(a.master, f"frame{i}.png"))
                    if a.dump:
                        Image.fromarray(dec).save(os.path.join(a.dump, f"{a.codec}-decoded-f{i}.png"))
                        df = np.clip(128 + 16 * (dec.astype(np.int16) - src.astype(np.int16)), 0, 255).astype(np.uint8)
                        Image.fromarray(df).save(os.path.join(a.dump, f"{a.codec}-diff16x-f{i}.png"))
                        # 平滑区放大对比（对比度拉伸 8 倍）：条带一眼可见
                        for nm, (x0, x1, y0, y1) in BAND_FRAMES.get(i, {}).items():
                            def stretch(img):
                                l = luma(img[y0:y1, x0:x1])
                                return np.clip((l - l.mean()) * 8 + 128, 0, 255).astype(np.uint8)
                            pair = np.concatenate([stretch(src), np.full((y1 - y0, 8), 255, np.uint8), stretch(dec)], axis=1)
                            Image.fromarray(pair).save(os.path.join(a.dump, f"{a.codec}-band8x-{nm}-f{i}-src-vs-dec.png"))
            i += 1
            if i % 200 == 0:
                print(f"verified {i} frames ({(time.time() - t0) / i:.2f} s/frame)", flush=True)
        rd.terminate()
        dd.terminate()
        n = i
        pm = per
        agg = {k: {"mean": float(np.mean([m[k] for m in pm])), "max": float(np.max([m[k] for m in pm])), "worstFrame": int(pm[int(np.argmax([m[k] for m in pm]))]["i"])} for k in ("mad", "p999", "blk", "maxdiff")}
        agg["psnr"] = {"mean": float(np.mean([m["psnr"] for m in pm])), "min": float(np.min([m["psnr"] for m in pm])), "worstFrame": int(pm[int(np.argmin([m["psnr"] for m in pm]))]["i"])}
        out = {"codec": a.codec, "mp4": a.mp4, "frames": n, "checked": len(pm), "agg": agg, "frame0": next(m for m in pm if m["i"] == 0), "frameLast": next((m for m in pm if m["i"] == LAST), None),
               "bands": bands, "sourceRgbSha256": src_hash, "decodedSha256": dec_raw_hash, "perFrame": pm}
        # 解码哈希的另一口径（spec 的 select 命令）：与上面的流式读取应一致，这里再用 select 现算一次最后一帧做交叉检查
        sel = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-threads", "4", "-i", a.mp4, "-vf", "select=eq(n\\," + str(LAST) + ")", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", pix, "-"], capture_output=True)
        out["decodedSha256SelectLast"] = hashlib.sha256(sel.stdout).hexdigest()
        out["decodedHashesAgree"] = out["decodedSha256SelectLast"] == dec_raw_hash.get(LAST)
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
        thr = {"mad": 0.6, "p999": 6.0, "blk": 2.0}
        f8 = out["frameLast"] or {}
        print(json.dumps({"frames": n, "agg": agg, "frame0": {k: round(v, 3) for k, v in out["frame0"].items()}, "frameLast": {k: round(v, 3) for k, v in f8.items()}, "bands": bands,
                          "hashesAgree": out["decodedHashesAgree"], "thresholdsA": thr}, ensure_ascii=False))
    finally:
        if not a.no_lock:
            try:
                os.rmdir(LOCK)
            except OSError:
                pass


if __name__ == "__main__":
    main()
