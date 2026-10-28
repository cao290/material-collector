#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
字幕检测：抽帧 → 每帧找「底部对齐的白色文字行」→ 跨帧位置一致性判定。

关键设计：烧录字幕在多帧里 y 位置固定；地面反光/灯光每帧位置乱跳。
所以最终判定 = 某个 y 位置的文字行出现在 ≥40% 的帧里。

用法：
    python subtitle_detect.py <视频文件> [--frames 12] [--json]
输出 JSON：{ok, hasSubtitle, confidence, frames, ratio, ...}
"""
import sys, os, json, glob, time, tempfile, shutil, subprocess, shutil

import cv2
import numpy as np

# ---------- ffmpeg ----------
def find_ffmpeg():
    cands = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     r"Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
                     r"\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe"),
        "ffmpeg.exe", "ffmpeg",
    ]
    for c in cands:
        if c and (os.path.isfile(c) or c in ("ffmpeg", "ffmpeg.exe")):
            return c
    return "ffmpeg"


def imread_cn(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def find_text_rows(img):
    """在一帧里找疑似字幕行。返回行列表 [{yCenter(帧坐标), nLetters, spanRatio}]"""
    h, w = img.shape[:2]
    y0, y1 = int(h * 0.68), int(h * 0.98)
    band = img[y0:y1, int(w * 0.03):int(w * 0.97)]
    if band.size == 0:
        return []
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    _, bright = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(bright, 8)
    letters = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < 30:
            continue
        if bw > band.shape[1] * 0.09:      # 单字母不会太宽（排除大灯牌）
            continue
        if bh < 6 or bh > band.shape[0] * 0.30:
            continue
        letters.append((x, y, bw, bh, area, cent[i][1]))
    if len(letters) < 5:
        return []
    # 按 y 中心聚类成行
    letters.sort(key=lambda t: t[5])
    rows, cur = [], [letters[0]]
    for L in letters[1:]:
        if abs(L[5] - cur[-1][5]) <= 6:
            cur.append(L)
        else:
            rows.append(cur)
            cur = [L]
    rows.append(cur)
    out = []
    for row in rows:
        if len(row) < 6:                    # 一行字幕至少 6 个字符块
            continue
        xs = [t[0] for t in row]
        xe = [t[0] + t[2] for t in row]
        span = max(xe) - min(xs)
        hs = [t[3] for t in row]
        if span < band.shape[1] * 0.15:     # 整行宽度 ≥ 25%
            continue
        if max(hs) > 2.2 * min(hs) + 4:     # 字母高度整齐
            continue
        y_center_frame = y0 + sum(t[5] for t in row) / len(row)
        out.append({
            "yCenter": y_center_frame,
            "yRatio": y_center_frame / h,   # 0~1，帧内相对位置
            "nLetters": len(row),
            "spanRatio": span / band.shape[1],
        })
    return out


def get_duration(video):
    ffmpeg = find_ffmpeg()
    ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe.exe")
    if not os.path.isfile(ffprobe):
        ffprobe = "ffprobe"
    try:
        r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", video],
                           capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def sample_frames(video, n_frames=12, workdir=None):
    ffmpeg = find_ffmpeg()
    outdir = workdir or os.path.join(tempfile.gettempdir(), "_subframes")
    os.makedirs(outdir, exist_ok=True)
    for f in glob.glob(os.path.join(outdir, "*.jpg")):
        try:
            os.remove(f)
        except OSError:
            pass
    # 抽帧节奏按视频时长自适应：目标均匀抽 n_frames 帧，但至少间隔 2 秒
    dur = get_duration(video)
    interval = max(2.0, (dur or n_frames * 8) / n_frames)
    cmd = [ffmpeg, "-y", "-loglevel", "error",
           "-fflags", "+genpts+igndts", "-err_detect", "ignore_err",
           "-i", video,
           "-vf", f"fps=1/{interval},scale=960:-1", "-frames:v", str(n_frames),
           os.path.join(outdir, "f_%03d.jpg")]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    frames = sorted(glob.glob(os.path.join(outdir, "*.jpg")))
    return frames, r.returncode, (r.stderr or "")


def detect_video(video, n_frames=12):
    t0 = time.time()
    frames, rc, err = sample_frames(video, n_frames)
    if not frames:
        return {"ok": False, "error": "抽帧失败(rc=%s) %s" % (rc, err[:200]), "video": video}

    # 跨帧统计：每个 y 位置（±1.5% 高度）出现在多少帧
    y_votes = []          # [ {yRatio, nLetters, ...} ]
    frames_with_text = 0
    for f in frames:
        try:
            img = imread_cn(f)
        except Exception:
            continue
        if img is None:
            continue
        rows = find_text_rows(img)
        if rows:
            frames_with_text += 1
            y_votes.extend(rows)

    # 聚类 y 位置：互相差 <3% 视为一处
    clusters = []
    for v in sorted(y_votes, key=lambda t: t["yRatio"]):
        placed = False
        for cl in clusters:
            if abs(v["yRatio"] - cl["yRatio"]) < 0.03:
                cl["count"] += 1
                cl["nLetters"] = max(cl["nLetters"], v["nLetters"])
                cl["yRatio"] = (cl["yRatio"] * (cl["count"] - 1) + v["yRatio"]) / cl["count"]
                placed = True
                break
        if not placed:
            clusters.append({"yRatio": v["yRatio"], "count": 1, "nLetters": v["nLetters"]})

    n_valid = max(len(frames), 1)
    best = max(clusters, key=lambda c: c["count"], default=None)
    ratio = (best["count"] / n_valid) if best else 0.0
    has = bool(best) and ratio >= 0.4 and best["nLetters"] >= 8
    return {
        "ok": True,
        "hasSubtitle": has,
        "confidence": round(ratio, 2),
        "hitFrames": best["count"] if best else 0,
        "frames": len(frames),
        "ratio": round(ratio, 2),
        "yPosition": round(best["yRatio"], 3) if best else None,
        "elapsed": round(time.time() - t0, 2),
        "video": video,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--frames", type=int, default=12)
    a = ap.parse_args()
    if not os.path.isfile(a.video):
        print(json.dumps({"ok": False, "error": "文件不存在: " + a.video}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(detect_video(a.video, a.frames), ensure_ascii=False))
