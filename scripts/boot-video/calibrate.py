"""色彩标定（BOOT-VIDEO 2.5）：决定写进 day-boot.json 的 trc（视频的传递函数标记：bt709 还是 iec61966-2-1 / sRGB）。

做法：造一帧标定图（0-255 灰阶块 + 灰阶斜坡 + 底板 #d4c8e4 / 光晕 / 墙纸色等块 + 饱和色块），静止 60 帧，用与正片同一条编码路径（encode.py，抖动 0）
编成 4 个片：{hevc, avc} x {trc=bt709, trc=srgb}（内容完全相同，只有色彩标记不同）。然后在**屏外真窗口**（realwin 的安全层，永远在所有显示器之外，
走 Intel 集显 + 硬解）里用 <video> 播放，两种方式取回窗口像素：
  ① webContents.capturePage()（合成器读回）；② ffmpeg gfxcapture（Windows Graphics Capture：DWM 合成后的窗口像素，最接近用户看到的）。
再与「想要的 sRGB 值」逐块比对（页面里同色的 DOM 色块作为抓屏链路自身的对照）。误差最小的标记胜出。

  python -I calibrate.py [--only hevc] [--skip-encode]
输出：perf-work/bootvideo/calib/result.json、calib/<clip>/*.png；最后一行打印结论。
前置：插电；重任务（编码 + 真窗口），持 .heavy-lock。"""
import argparse
import json
import os
import subprocess
import sys
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", ".."))
WORK = r"G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo"
CAL = os.path.join(WORK, "calib")
LOCK = r"G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock"
FFMPEG = r"G:/Claude Code Workplace/tools/ffmpeg/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
EXE = os.path.join(APP, "node_modules", "electron", "dist", "electron.exe")
import json as _json
_G = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geometry.json'), encoding='utf-8'))
W, H = _G['width'], _G['height']

ap = argparse.ArgumentParser()
ap.add_argument("--variants", default=None, help="空格分隔的 codec:matrix:trc:colr:sw，如 hevc:709:bt709:0:0 hevc:601:bt709:0:0；matrix = 709|601|none709；colr=1 写 colr 盒；sw=1 关硬解")
ap.add_argument("--framecheck", default=None, help="mp4 路径：在屏外真窗口里把视频停在 --seek 秒，抓窗口像素，与 --ref 的母版帧 PNG 比")
ap.add_argument("--ref", default=None)
ap.add_argument("--seek", default=None)
ap.add_argument("--name", default="framecheck")
ap.add_argument("--only", default=None, help="hevc | avc")
ap.add_argument("--skip-encode", action="store_true")
ap.add_argument("--no-lock", action="store_true")
args = ap.parse_args()

GRAYS = [0, 4, 8, 12, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 232, 240, 248, 252, 255]
COLORS = {
    "plate #d4c8e4": (212, 200, 228), "glow": (243, 238, 250), "fog": (236, 230, 246), "wall": (219, 212, 231), "lav": (183, 166, 214),
    "purple": (118, 84, 170), "deep": (60, 40, 95), "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255), "skin": (240, 200, 180),
    "grass": (60, 110, 50), "sky": (110, 170, 220), "pink": (240, 160, 200), "bfly": (30, 100, 230), "yellow": (250, 230, 90),
    "orange": (240, 140, 40), "cyan": (60, 220, 220), "magenta": (220, 50, 200), "mid-lav": (150, 130, 190),
}


def layout():
    """每块的 (名字, 目标 rgb, 中心 x, 中心 y)，像素坐标（视频帧内）。灰阶两行，色块两行."""
    out = []
    pw, ph, gx, gy = 150, 100, 8, 8
    x0, y0 = 14, 120
    per = 10
    for i, g in enumerate(GRAYS):
        r, c = divmod(i, per)
        out.append(("gray%d" % g, (g, g, g), x0 + c * (pw + gx), y0 + r * (ph + gy), pw, ph, "gray"))
    nrows = -(-len(GRAYS) // per)
    y1 = y0 + nrows * (ph + gy) + 20
    for i, (n, rgb) in enumerate(COLORS.items()):
        r, c = divmod(i, per)
        out.append((n, rgb, x0 + c * (pw + gx), y1 + r * (ph + gy), pw, ph, "color"))
    return out


def make_frame():
    f = np.full((H, W, 3), 128, np.uint8)
    ramp = np.linspace(0, 255, W)
    f[0:100, :, :] = np.round(ramp)[None, :, None].astype(np.uint8)
    for n, rgb, x, y, pw, ph, kind in layout():
        f[y:y + ph, x:x + pw] = rgb
    return f


def lower_priority():
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
    except Exception:
        pass


def run(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise SystemExit("failed: " + " ".join(str(c) for c in cmd[:6]))


def build_master():
    d = os.path.join(CAL, "master")
    os.makedirs(d, exist_ok=True)
    f = make_frame()
    Image.fromarray(f).save(os.path.join(CAL, "frame.png"))
    p = subprocess.Popen([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "120", "-i", "-",
                          "-vf", "format=bgr0", "-c:v", "ffv1", "-g", "1", "-threads", "4", os.path.join(d, "seg_000.mkv")], stdin=subprocess.PIPE)
    for _ in range(60):
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    return d


def vname(v):
    codec, matrix, trc, colr, sw = v
    return f"{codec}-m{matrix}-{trc}-c{colr}-s{sw}"


def encode(v, master):
    codec, matrix, trc, colr, sw = v
    out = os.path.join(CAL, f"{codec}-m{matrix}-{trc}-c{colr}.mp4")
    if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(os.path.join(master, "seg_000.mkv")) and os.path.getmtime(out) > os.path.getmtime(os.path.join(HERE, "encode.py")):
        return out
    cmd = [sys.executable, "-I", os.path.join(HERE, "encode.py"), "--no-lock", "--codec", codec, "--trc", trc, "--matrix", matrix, "--master", master, "--frames", "60",
           "--dither", "0", "--preset", "veryfast", "--crf", "10" if codec == "hevc" else "12", "--out", out] + (["--colr"] if colr == "1" else [])
    run(cmd)
    return out


def page_html(name, clip, seek=None):
    items = [{"n": n, "rgb": rgb} for n, rgb, *_ in layout()]
    html = """<!doctype html><meta charset=utf-8><title>calib</title>
<body style="margin:0;background:#000;overflow:hidden">
<video id=v src="%s" muted %s playsinline style="position:absolute;left:0;top:0"></video>
<script>
const dpr = devicePixelRatio, v = document.getElementById('v');
v.style.width = (%d / dpr) + 'px'; v.style.height = (%d / dpr) + 'px';
const items = %s;
items.forEach((it, i) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;background:rgb(' + it.rgb.join(',') + ');left:' + ((8 + i * 56) / dpr) + 'px;top:' + ((%d + 16) / dpr) + 'px;width:' + (48 / dpr) + 'px;height:' + (48 / dpr) + 'px'; document.body.appendChild(d); });
%s
</script>""" % (("file:///" + clip.replace("\\", "/").replace(" ", "%20")) if seek is not None else os.path.basename(clip), "" if seek is not None else "autoplay loop", W, H, json.dumps(items), H,
               ("v.addEventListener('loadeddata', () => { %s }); if (%s) { const b = document.createElement('div'); b.style.cssText = 'position:absolute;right:0;bottom:0;width:6px;height:6px'; document.body.appendChild(b); let k = 0; (function f() { b.style.background = (k++ & 1) ? '#fff' : '#000'; requestAnimationFrame(f); })(); }" % (("v.play()" if seek in ("end", "endclean") else "v.pause(); v.currentTime = %s;" % seek), "false" if seek == "endclean" else "true")) if seek is not None else "v.play().catch(() => {});")
    p = os.path.join(CAL, f"{name}.html")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(html)
    return p


def play_and_capture(name, clip, codecs, flags='', seek=None, wait_ms=1800):
    html = page_html(name, clip, seek)
    od = os.path.join(CAL, name)
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        os.remove(os.path.join(od, f))
    quit_f = os.path.join(od, "quit.flag")
    ud = os.path.join(CAL, "ud-" + name)
    env = dict(os.environ, CAL_URL="file:///" + html.replace("\\", "/").replace(" ", "%20"), CAL_OUT=od, CAL_QUIT=quit_f, CAL_CODEC=codecs, CAL_FLAGS=flags, CAL_WAIT_MS=str(wait_ms))
    child = subprocess.Popen([EXE, os.path.join(HERE, "calib-entry.cjs"), f"--user-data-dir={ud}"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    info = None
    try:
        t0 = time.time()
        while time.time() - t0 < 60:
            p = os.path.join(od, "info.json")
            if os.path.exists(p):
                time.sleep(0.3)
                info = json.load(open(p, encoding="utf-8"))
                break
            if child.poll() is not None:
                raise SystemExit("electron exited early (offwin assertion?) code %s" % child.returncode)
            time.sleep(0.3)
        if not info:
            raise SystemExit("electron did not report")
        time.sleep(1.0)
        # WGC：DWM 合成后的窗口像素
        try:
            r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_complex",
                            f"gfxcapture=hwnd={info['hwnd']}:max_framerate=60:capture_cursor=0,hwdownload,format=bgra", "-frames:v", "6", "-fps_mode", "passthrough",
                            os.path.join(od, "wgc_%d.png")], capture_output=True, text=True, timeout=25)
        except subprocess.TimeoutExpired:
            r = subprocess.CompletedProcess([], -999, '', 'wgc timeout')
        
        info["wgcRc"] = r.returncode
        info["wgcErr"] = r.stderr[-400:]
    finally:
        open(quit_f, "w").close()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True)
    return od, info


def med(img, cx, cy, half=22):
    h, w = img.shape[:2]
    x0, x1, y0, y1 = max(cx - half, 0), min(cx + half, w), max(cy - half, 0), min(cy + half, h)
    return np.median(img[y0:y1, x0:x1].reshape(-1, img.shape[2])[:, :3], axis=0)


def analyse(od, info, dpr):
    res = {}
    cands = []
    for k in range(6, 0, -1):
        p = os.path.join(od, f"wgc_{k}.png")
        if os.path.exists(p):
            cands.append(("wgc", p))
            break
    cands.append(("capturePage", os.path.join(od, "capturePage.png")))
    for kind, p in cands:
        if not os.path.exists(p):
            continue
        img = np.asarray(Image.open(p).convert("RGB"))
        rect = info["page"]["rect"]
        ox, oy = int(round(rect[0] * dpr)), int(round(rect[1] * dpr))
        # capturePage 的尺寸可能是 DIP；按 PNG 实际宽度换算比例
        sc = img.shape[1] / (info["bounds"]["width"] * dpr) if kind == "capturePage" else 1.0
        rows = []
        for n, rgb, x, y, pw, ph, grp in layout():
            m = med(img, int((ox + x + pw / 2) * sc), int((oy + y + ph / 2) * sc), int(22 * sc))
            rows.append({"n": n, "grp": grp, "want": list(rgb), "got": [int(v) for v in m], "err": [int(m[i] - rgb[i]) for i in range(3)]})
        # DOM 对照块（抓屏链路自身）
        dom = []
        for i, (n, rgb, *_r) in enumerate(layout()):
            cx = int((8 + i * 56 + 24) * sc)
            cy = int((H + 16 + 24) * sc)
            m = med(img, cx, cy, int(14 * sc))
            dom.append([int(m[j] - rgb[j]) for j in range(3)])
        ga = [abs(e) for r in rows if r["grp"] == "gray" for e in r["err"]]
        co = [abs(e) for r in rows if r["grp"] == "color" for e in r["err"]]
        da = [abs(e) for d in dom for e in d]
        res[kind] = {"size": [int(img.shape[1]), int(img.shape[0])], "grayMeanAbs": round(float(np.mean(ga)), 3), "grayMax": int(max(ga)),
                     "colorMeanAbs": round(float(np.mean(co)), 3), "colorMax": int(max(co)), "domMeanAbs": round(float(np.mean(da)), 3), "domMax": int(max(da)), "rows": rows}
    return res


def framecheck():
    lower_priority()
    os.makedirs(CAL, exist_ok=True)
    if not args.no_lock:
        while True:
            try:
                os.mkdir(LOCK)
                break
            except FileExistsError:
                print("heavy-lock held, waiting", flush=True)
                time.sleep(15)
    try:
        codec = "hevc" if "hevc" in os.path.basename(args.framecheck) else "avc"
        codecs = "hvc1.2.4.L153.90" if codec == "hevc" else "avc1.640034"
        od, info = play_and_capture(args.name, os.path.abspath(args.framecheck), codecs, "", seek=args.seek, wait_ms=(10000 if args.seek in ("end", "endclean") else 3500))
        ref = np.asarray(Image.open(args.ref).convert("RGB")).astype(np.int16)
        out = {"page": info["page"], "wgcRc": info.get("wgcRc")}
        for kind, pat in (("wgc", "wgc_6.png"), ("capturePage", "capturePage.png")):
            p = os.path.join(od, pat)
            if not os.path.exists(p):
                continue
            img = np.asarray(Image.open(p).convert("RGB")).astype(np.int16)
            rect = info["page"]["rect"]
            dpr = info["page"]["dpr"]
            sc = img.shape[1] / (info["bounds"]["width"] * dpr) if kind == "capturePage" else 1.0
            ox, oy = int(round(rect[0] * dpr * sc)), int(round(rect[1] * dpr * sc))
            crop = img[oy:oy + H, ox:ox + W]
            if crop.shape != ref.shape:
                out[kind] = {"error": f"crop {crop.shape} != ref {ref.shape}, capture {img.shape}"}
                continue
            d = crop - ref
            lum = (0.2126 * d[..., 0] + 0.7152 * d[..., 1] + 0.0722 * d[..., 2])
            h8, w8 = (H // 8) * 8, (W // 8) * 8
            blk = lum[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8).mean(axis=(1, 3))
            out[kind] = {"meanSignedRGB": [round(float(d[..., i].mean()), 3) for i in range(3)], "mad": round(float(np.abs(lum).mean()), 3), "p999": round(float(np.percentile(np.abs(lum), 99.9)), 2),
                         "blkMax": round(float(np.abs(blk).max()), 2), "maxdiff": int(np.abs(d).max())}
            Image.fromarray(np.clip(crop, 0, 255).astype(np.uint8)).save(os.path.join(od, f"{kind}-crop.png"))
        with open(os.path.join(CAL, args.name + ".json"), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
        print(json.dumps(out, ensure_ascii=False))
    finally:
        if not args.no_lock:
            try:
                os.rmdir(LOCK)
            except OSError:
                pass


def main():
    lower_priority()
    os.makedirs(CAL, exist_ok=True)
    if args.variants:
        variants = [tuple(x.split(":")) for x in args.variants.split()]
    else:
        variants = [(c, "709", t, "0", "0") for c in (["hevc", "avc"] if not args.only else [args.only]) for t in ("bt709", "srgb")]
    if not args.no_lock:
        while True:
            try:
                os.mkdir(LOCK)
                break
            except FileExistsError:
                print("heavy-lock held, waiting", flush=True)
                time.sleep(15)
    try:
        master = os.path.join(CAL, "master") if args.skip_encode else build_master()
        rpath = os.path.join(CAL, "result.json")
        results = json.load(open(rpath, encoding="utf-8")) if os.path.exists(rpath) else {}
        table = []
        for v in variants:
            codec, matrix, trc, colr, sw = v
            clip = encode(v, master)
            codecs = "hvc1.2.4.L153.90" if codec == "hevc" else "avc1.640034"
            name = vname(v)
            od, info = play_and_capture(name, clip, codecs, "disable-accelerated-video-decode" if sw == "1" else "")
            dpr = info["page"]["dpr"]
            an = analyse(od, info, dpr)
            results[name] = {"variant": list(v), "page": info["page"], "wgcRc": info.get("wgcRc"), "analysis": an}
            kind = "wgc" if "wgc" in an else "capturePage"
            for kk, x in an.items():
                print(f"{name:34s} {kk:12s} gray mean|err| {x['grayMeanAbs']:.2f} max {x['grayMax']:3d}   color mean|err| {x['colorMeanAbs']:.2f} max {x['colorMax']:3d}   DOM ref {x['domMeanAbs']:.2f}", flush=True)
            x = an[kind]
            table.append((x["grayMeanAbs"] + x["colorMeanAbs"], name))
        with open(rpath, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=1)
        print("ranking (grayMean+colorMean, lower = better):")
        for sc, name in sorted(table):
            print(f"  {sc:6.2f}  {name}")
    finally:
        if not args.no_lock:
            try:
                os.rmdir(LOCK)
            except OSError:
                pass


if __name__ == "__main__":
    framecheck() if args.framecheck else main()
