"""阶段二：编码。从无损母版（render.mjs 出的 FFV1 分段）读帧，numpy 做 RGB -> BT.709 有限范围 YUV 4:2:0 + 确定性 TPDF 抖动，管给 ffmpeg 的 x265 / x264。
每次调参只重做这一段，不重渲染。

  python -I encode.py --codec hevc --out OUT.mp4 [--master DIR] [--dither 2.0] [--crf 17] [--preset slow] [--trc bt709|srgb]
  python -I encode.py --codec avc  --out OUT.mp4 [--dither 0.75] [--crf 18]
    --frames N        只编前 N 帧（调参 / 试编）；--first K 从第 K 帧起（配合 --frames 编一小段）
    --maxrate / --bufsize   覆盖 vbv（kbit/s）；--x265-extra "k=v:k=v" 追加 x265 参数
    --chroma center|left    色度下采样位置（默认 left = MPEG-2 / H.273 type 0，Chromium 与硬解的假设；center 是 2x2 平均）

做法（见 media-toolchain 记忆）：抖动必须加在 YUV 域、量化之前（RGB 里加会在 swscale 量化时丢掉，编码器随后把暗部渐变压平成色带）。
  HEVC：10 位（yuv420p10le），幅度 --dither 以 10 位最低位为单位（默认 2.0 ≈ 0.5 个 8 位台阶）；H.264：8 位，幅度以 8 位台阶为单位（默认 0.75）。
  抖动是 TPDF（两个均匀分布之差，范围 ±幅度），种子 = 帧号 *3 + 平面号，可复现。
  色彩：BT.709 系数、有限范围；矩阵标记默认留空（none709，原因见 calibrate 结果与 README）；传递函数标记 --trc（默认 srgb = iec61966-2-1；bt709 与 srgb 在这台机器的硬解路径上实测相同），写进 VUI。
  帧与时刻：第 i 帧 = 场景时刻 i/120 s。全程不做任何帧间操作（不缩放、不插帧）。
低优先级（BELOW_NORMAL）、ffmpeg -threads 4、x265 pools=4。重任务：持 perf-work/av/.heavy-lock（--no-lock 跳过，仅限已由调用方持锁时）。"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import numpy as np  # noqa: E402

FFMPEG = r"G:/Claude Code Workplace/tools/ffmpeg/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
WORK = r"G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo"
LOCK = r"G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock"
import json as _json
_G = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geometry.json'), encoding='utf-8'))
W, H, FPS = _G['width'], _G['height'], _G['fps']

ap = argparse.ArgumentParser()
ap.add_argument("--codec", choices=["hevc", "avc"], required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--master", default=os.path.join(WORK, "master"))
ap.add_argument("--dither", type=float, default=None)
ap.add_argument("--crf", type=float, default=None)
ap.add_argument("--preset", default="slow")
ap.add_argument("--trc", default="srgb", choices=["bt709", "srgb"])
ap.add_argument("--frames", type=int, default=None)
ap.add_argument("--first", type=int, default=0)
ap.add_argument("--maxrate", type=int, default=None)
ap.add_argument("--bufsize", type=int, default=None)
ap.add_argument("--x265-extra", default="")
ap.add_argument("--x264-extra", default="")
ap.add_argument("--chroma", default="left", choices=["left", "center"])
ap.add_argument("--step", type=int, default=1, help="隔 N 帧取 1 帧（2 = 60 fps：第 0、2、4 … 888 帧，时刻仍是 i/120 s，最后一帧恰是 T_END）")
ap.add_argument("--gop", type=int, default=None, help="关键帧间隔（帧）；默认 = 帧率（每秒一个）")
ap.add_argument("--offset", default="0,0,0", help="RGB 各通道加这么多个 8 位色阶（浮点，在转 YUV 之前；校准用：真窗口里视频比实时整体暗约 1 级，就在这里补回）")
ap.add_argument("--gain", default="1,1,1", help="RGB 各通道乘的系数（在加偏置之前；校准用）")
ap.add_argument("--crop-w", type=int, default=None, help="只编码左边这么宽（右侧裁掉；左对齐，几何不变；调大小 / 覆盖的窗口比例用）")
ap.add_argument("--corr", default=None, help="颜色校准图 .npz（r4/calmap.py 出的）：按帧时刻 t = i / 帧率 线性插值、双线性放大到帧尺寸，加到母版 RGB 上（单位 8 位色阶）")
ap.add_argument("--no-lock", action="store_true")
ap.add_argument("--tag", default="")
ap.add_argument("--matrix", default="none709", choices=["709", "601", "none709"], help="none709（默认，calibrate.py 实测胜出）= BT.709 系数、矩阵标记留空（Chromium 对 HD 默认按 709 解）；709 = 709 系数 + 显式标 bt709；601 = BT.601 系数 + 标 smpte170m。显式标 709 / 601 在这台机器（Intel 集显硬解 + DWM）上红 / 青 / 品红偏 20-40 级，见 README")
ap.add_argument("--colr", action="store_true", help="容器里写 colr(nclx) 盒（-movflags +write_colr）")
a = ap.parse_args()
FPS = FPS // a.step
CROP_W = a.crop_w or W
OFFSET = np.array([float(v) for v in a.offset.split(",")], dtype=np.float32) / np.float32(255.0)
GAIN = np.array([float(v) for v in a.gain.split(",")], dtype=np.float32)

HEVC = a.codec == "hevc"
BITS = 10 if HEVC else 8
DITHER = a.dither if a.dither is not None else (2.0 if HEVC else 0.75)
CRF = a.crf if a.crf is not None else (17 if HEVC else 18)
MAXRATE = a.maxrate or (18000 if HEVC else 48000)
BUFSIZE = a.bufsize or (36000 if HEVC else 96000)
TRC_NAME = {"bt709": "bt709", "srgb": "iec61966-2-1"}[a.trc]
SC = 1 << (BITS - 8)
KR, KB = (0.299, 0.114) if a.matrix == "601" else (0.2126, 0.0722)
KG = 1.0 - KR - KB
MATRIX_TAG = {"709": "bt709", "601": "smpte170m", "none709": "unknown"}[a.matrix]


CORR = None
if a.corr:
    _c = np.load(a.corr)
    CORR = {"t": _c["t"].astype(np.float64), "maps": _c["maps"].astype(np.float32), "bs": int(_c["bs"])}


def corr_for(t, h, w):
    """t 时刻的校准量 (h, w, 3)（8 位色阶）：在相邻两个关键时刻之间线性插值；块图铺满后向右 / 向下用边缘延伸到帧尺寸."""
    ts = CORR["t"]; ms = CORR["maps"]; bs = CORR["bs"]
    if t <= ts[0]:
        m = ms[0]
    elif t >= ts[-1]:
        m = ms[-1]
    else:
        j = int(np.searchsorted(ts, t) - 1)
        f = np.float32((t - ts[j]) / (ts[j + 1] - ts[j]))
        m = ms[j] * (1 - f) + ms[j + 1] * f
    import cv2
    gh, gw = m.shape[:2]
    up = cv2.resize(m, (gw * bs, gh * bs), interpolation=cv2.INTER_LINEAR)
    pad_r, pad_b = max(0, w - gw * bs), max(0, h - gh * bs)
    if pad_r or pad_b:
        up = np.pad(up, ((0, pad_b), (0, pad_r), (0, 0)), mode="edge")
    return up[:h, :w]


def lower_priority():
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)   # BELOW_NORMAL
    except Exception:
        pass


def take_lock():
    while True:
        try:
            os.makedirs(os.path.dirname(LOCK), exist_ok=True)
            os.mkdir(LOCK)
            return
        except FileExistsError:
            print("heavy-lock held, waiting", flush=True)
            time.sleep(15)


def release_lock():
    try:
        os.rmdir(LOCK)
    except OSError:
        pass


def master_list():
    segs = sorted(f for f in os.listdir(a.master) if f.startswith("seg_") and f.endswith(".mkv") and ".part" not in f)
    if not segs:
        raise SystemExit("母版为空：先跑 render.mjs")
    lst = os.path.join(WORK, "master-concat.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            f.write("file '%s'\n" % os.path.join(a.master, s).replace("\\", "/"))
    return lst


def planes(rgb_u8, frame_idx):
    """rgb uint8 (H, W, 3) -> (Y, Cb, Cr) uint8 / uint16（BT.709 limited，TPDF 抖动，4:2:0）."""
    x = rgb_u8.astype(np.float32)
    x *= np.float32(1.0 / 255.0)
    if a.crop_w:
        x = x[:, :CROP_W]
    if np.any(GAIN != 1.0) or np.any(OFFSET != 0.0):
        x = np.clip(x * GAIN + OFFSET, 0.0, 1.0)
    if CORR is not None:
        x = np.clip(x + corr_for(frame_idx / float(_G["fps"]), x.shape[0], x.shape[1]) * np.float32(1.0 / 255.0), 0.0, 1.0)
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    y = np.float32(KR) * r + np.float32(KG) * g + np.float32(KB) * b
    cb = (b - y) * np.float32(1.0 / (2 * (1 - KB)))
    cr = (r - y) * np.float32(1.0 / (2 * (1 - KR)))
    Y = (np.float32(16.0) + np.float32(219.0) * y) * np.float32(SC)
    out = []
    for k, c in enumerate((cb, cr)):
        C = (np.float32(128.0) + np.float32(224.0) * c) * np.float32(SC)
        if a.chroma == "left":
            # 水平：偶数列处 [1 2 1]/4（左对齐 = 与偶数列亮度同位）；垂直：相邻两行平均
            p = np.pad(C, ((0, 0), (1, 1)), mode="edge")
            Ch = (p[:, 0:-2:2] + np.float32(2.0) * p[:, 1:-1:2] + p[:, 2::2]) * np.float32(0.25)
            Cs = (Ch[0::2] + Ch[1::2]) * np.float32(0.5)
        else:
            Cs = (C[0::2, 0::2] + C[0::2, 1::2] + C[1::2, 0::2] + C[1::2, 1::2]) * np.float32(0.25)
        out.append(Cs)
    rng = np.random.default_rng([frame_idx, 7])

    def tpdf(shape):
        return (rng.random(shape, dtype=np.float32) - rng.random(shape, dtype=np.float32)) * np.float32(DITHER)

    lo, hiY, hiC = 16 * SC, 235 * SC, 240 * SC
    dt = np.uint16 if BITS > 8 else np.uint8
    Yq = np.clip(np.floor(Y + np.float32(0.5) + tpdf(Y.shape)), lo, hiY).astype(dt)
    Cbq = np.clip(np.floor(out[0] + np.float32(0.5) + tpdf(out[0].shape)), lo, hiC).astype(dt)
    Crq = np.clip(np.floor(out[1] + np.float32(0.5) + tpdf(out[1].shape)), lo, hiC).astype(dt)
    return Yq, Cbq, Crq


def encoder_cmd():
    common = ["-r", str(FPS), "-fps_mode", "cfr", "-g", str(a.gop or FPS), "-keyint_min", str(a.gop or FPS), "-threads", "4",
              "-color_primaries", "bt709", "-color_trc", TRC_NAME, "-color_range", "tv", "-movflags", "+faststart" + ("+write_colr" if a.colr else "")]
    if a.matrix != "none709":
        common += ["-colorspace", MATRIX_TAG]
    if HEVC:
        xp = (f"pools=4:frame-threads=2:level-idc=5.1:profile=main10:scenecut=0:aq-mode=3:psy-rd=1.0:vbv-maxrate={MAXRATE}:vbv-bufsize={BUFSIZE}"
              f":colorprim=bt709:transfer={TRC_NAME}:colormatrix={MATRIX_TAG if a.matrix != "none709" else "undef"}:range=limited:chromaloc={0 if a.chroma == 'left' else 1}:repeat-headers=0:log-level=error")
        if a.x265_extra:
            xp += ":" + a.x265_extra
        codec = ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", a.preset, "-crf", str(CRF), "-tag:v", "hvc1", "-x265-params", xp]
    else:
        xp = (f"colorprim=bt709:transfer={TRC_NAME}:colormatrix={MATRIX_TAG if a.matrix != "none709" else "undef"}:range=tv:chromaloc={0 if a.chroma == 'left' else 1}:aq-mode=3:aq-strength=1.1:deadzone-inter=6:deadzone-intra=6:no-dct-decimate=1")
        if a.x264_extra:
            xp += ":" + a.x264_extra
        codec = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "5.2", "-preset", a.preset, "-crf", str(CRF),
                 "-sc_threshold", "0", "-maxrate", f"{MAXRATE}k", "-bufsize", f"{BUFSIZE}k", "-x264-params", xp]
    return [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p10le" if HEVC else "yuv420p", "-s", f"{CROP_W}x{H}", "-r", str(FPS), "-i", "-"] + codec + common + [a.out]


def main():
    lower_priority()
    lst = master_list()
    n_want = a.frames
    dec = [FFMPEG, "-hide_banner", "-loglevel", "error", "-threads", "4", "-f", "concat", "-safe", "0", "-i", lst]
    if a.first:
        dec += ["-vf", f"select=gte(n\\,{a.first})", "-fps_mode", "passthrough"]
    elif a.step > 1:
        dec += ["-vf", f"select=not(mod(n\\,{a.step}))", "-fps_mode", "passthrough"]
    if n_want:
        dec += ["-frames:v", str(n_want)]
    dec += ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    if not a.no_lock:
        take_lock()
    try:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        reader = subprocess.Popen(dec, stdout=subprocess.PIPE, bufsize=W * H * 3 * 2)
        enc = subprocess.Popen(encoder_cmd(), stdin=subprocess.PIPE)
        fsz = W * H * 3
        i = a.first
        t0 = time.time()
        while True:
            buf = reader.stdout.read(fsz)
            if len(buf) < fsz:
                break
            rgb = np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3)
            Y, Cb, Cr = planes(rgb, i * a.step)
            enc.stdin.write(Y.tobytes() + Cb.tobytes() + Cr.tobytes())
            i += 1
            if (i - a.first) % 60 == 0:
                print(f"fed {i - a.first} frames, {(time.time() - t0) / (i - a.first):.2f} s/frame", flush=True)
        enc.stdin.close()
        rc = enc.wait()
        reader.wait()
        if rc != 0:
            raise SystemExit(f"encoder exit {rc}")
        nfed = i - a.first
        size = os.path.getsize(a.out)
        info = {"out": a.out, "codec": a.codec, "frames": nfed, "bytes": size, "mbps": round(size * 8 / (nfed / FPS) / 1e6, 2), "dither": DITHER, "crf": CRF,
                "preset": a.preset, "trc": TRC_NAME, "matrix": a.matrix, "colr": a.colr, "chroma": a.chroma, "maxrate": MAXRATE, "bufsize": BUFSIZE, "x265Extra": a.x265_extra, "x264Extra": a.x264_extra, "secs": round(time.time() - t0)}
        print(json.dumps(info), flush=True)
        if a.tag:
            with open(os.path.join(WORK, f"encode-{a.tag}.json"), "w", encoding="utf-8") as fh:
                json.dump(info, fh, indent=1)
    finally:
        if not a.no_lock:
            release_lock()


if __name__ == "__main__":
    main()
