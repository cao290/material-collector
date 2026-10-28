#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
视频转写服务（faster-whisper + CUDA）

用法：
    python transcribe_server.py                    # 常驻 HTTP 服务，端口 8355
    python transcribe_server.py --once <file>      # 单次转写，结果打到 stdout（调试用）

HTTP 接口（只监听 127.0.0.1）：
    GET  /health                    服务与模型状态
    POST /transcribe                 {path, language?, model?, vad?} → {ok, text, segments, duration}
    POST /transcribe/batch           {paths[], ...} → 逐个转写
"""
import argparse
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 默认模型：medium（本机已缓存）；GPU 不可用时自动回退 CPU
DEFAULT_MODEL = os.environ.get("TRANSCRIBE_MODEL", "medium")
DEVICE = os.environ.get("TRANSCRIBE_DEVICE", "cuda")
COMPUTE = os.environ.get("TRANSCRIBE_COMPUTE", "float16")
PORT = int(os.environ.get("TRANSCRIBE_PORT", "8355"))

_model_cache = {}


def _prepare_cuda_paths():
    """把 pip 安装的 nvidia CUDA 库目录加进 DLL 搜索路径（cublas/cudnn）"""
    if os.name != "nt":
        return
    try:
        import importlib.util

        for mod in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime", "nvidia.cuda_nvrtc"):
            spec = importlib.util.find_spec(mod)
            if not spec or not spec.submodule_search_locations:
                continue
            base = list(spec.submodule_search_locations)[0]
            for sub in ("bin", "lib", ""):
                d = os.path.join(base, sub) if sub else base
                if os.path.isdir(d):
                    try:
                        os.add_dll_directory(d)
                    except Exception:
                        pass
                    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def _cuda_usable() -> bool:
    """探测 CUDA 是否真能用（cublas 缺失时提前返回 False，避免加载崩）"""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() < 1:
            return False
    except Exception:
        return False
    import glob

    try:
        for p in os.environ.get("PATH", "").split(os.pathsep):
            if p and glob.glob(os.path.join(p, "cublas64_12.dll")):
                return True
    except Exception:
        pass
    return False


def load_model(name: str):
    """按需加载并缓存模型；CUDA 不可用时自动降级 CPU"""
    if name in _model_cache:
        return _model_cache[name]
    from faster_whisper import WhisperModel

    _prepare_cuda_paths()
    device, compute = DEVICE, COMPUTE

    if device == "cuda" and not _cuda_usable():
        sys.stderr.write("[warn] CUDA 运行时库不可用（缺 cublas/cudnn），本次用 CPU/int8\n")
        device, compute = "cpu", "int8"

    if device == "cuda":
        try:
            m = WhisperModel(name, device="cuda", compute_type=compute)
        except Exception as e:
            sys.stderr.write(f"[warn] CUDA 加载失败（{e}），回退 CPU/int8\n")
            m = WhisperModel(name, device="cpu", compute_type="int8")
            device, compute = "cpu", "int8"
    else:
        m = WhisperModel(name, device="cpu", compute_type="int8")

    _model_cache[name] = (m, device, compute)
    return _model_cache[name]


def _t2s_converter():
    """繁→简转换器；opencc 没装时返回 None（跳过转换）"""
    try:
        from opencc import OpenCC
        return OpenCC("t2s")
    except Exception:
        return None


def transcribe_one(path: str, language: str = "", model: str = "", vad: bool = True):
    """转写单个音视频文件，返回文本 + 分段（带时间轴）"""
    if not os.path.isfile(path):
        return {"ok": False, "error": f"文件不存在：{path}"}
    t0 = time.time()
    try:
        m, device, compute = load_model(model or DEFAULT_MODEL)
        # 中文任务用简体示例引导（whisper 训练语料繁体多，默认常输出繁体）
        prompt = ""
        if language == "zh" or (not language):
            prompt = "以下是普通话的句子，使用简体中文书写。"
        segments, info = m.transcribe(
            path,
            language=(language or None),
            vad_filter=bool(vad),
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            word_timestamps=False,
            initial_prompt=prompt or None,
        )
        cc = _t2s_converter()  # 兜底：无论模型输出什么，繁体一律转简体
        segs = []
        parts = []
        for s in segments:
            text = (s.text or "").strip()
            if not text:
                continue
            if cc is not None:
                text = cc.convert(text)
            segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
            parts.append(text)
        full = "".join(parts)
        return {
            "ok": True,
            "path": path,
            "text": full,
            "segments": segs,
            "duration": round(getattr(info, "duration", 0) or 0, 2),
            "language": getattr(info, "language", "") or "",
            "language_probability": round(getattr(info, "language_probability", 0) or 0, 3),
            "elapsed": round(time.time() - t0, 2),
            "device": device,
            "compute": compute,
            "model": model or DEFAULT_MODEL,
            "segmentCount": len(segs),
            "charCount": len(full),
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "trace": traceback.format_exc()[-800:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[transcribe] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        if self.path.startswith("/health"):
            try:
                import faster_whisper
                import ctranslate2

                # 探测前先把 nvidia DLL 目录加进搜索路径，否则误报 CUDA 不可用
                _prepare_cuda_paths()

                # 有效设备：已加载模型时以实际加载为准，否则以 CUDA 可用性探测
                eff_device, eff_compute = DEVICE, COMPUTE
                if _model_cache:
                    _m, eff_device, eff_compute = next(iter(_model_cache.values()))
                elif DEVICE == "cuda" and not _cuda_usable():
                    eff_device, eff_compute = "cpu", "int8"

                return self._json(200, {
                    "ok": True,
                    "service": "transcribe",
                    "model": DEFAULT_MODEL,
                    "device": eff_device,
                    "compute": eff_compute,
                    "wantDevice": DEVICE,
                    "cudaUsable": _cuda_usable(),
                    "cudaDevices": ctranslate2.get_cuda_device_count(),
                    "fasterWhisper": getattr(faster_whisper, "__version__", ""),
                    "loaded": list(_model_cache.keys()),
                })
            except Exception as e:
                return self._json(200, {"ok": False, "error": str(e)})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/shutdown"):
            self._json(200, {"ok": True, "bye": True})
            import threading

            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        if self.path.startswith("/transcribe/batch"):
            body = self._read()
            paths = body.get("paths") or []
            out = []
            for p in paths:
                out.append(transcribe_one(p, body.get("language", ""), body.get("model", ""), body.get("vad", True)))
            return self._json(200, {"ok": True, "results": out})

        if self.path.startswith("/transcribe"):
            body = self._read()
            path = body.get("path") or ""
            if not path:
                return self._json(400, {"ok": False, "error": "缺少 path"})
            r = transcribe_one(path, body.get("language", ""), body.get("model", ""), body.get("vad", True))
            return self._json(200 if r.get("ok") else 500, r)

        return self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", help="单次转写该文件后退出")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--language", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--no-vad", action="store_true")
    args = ap.parse_args()

    # 启动即把 pip 装的 nvidia CUDA 库目录加进 DLL 搜索路径
    _prepare_cuda_paths()

    if args.once:
        r = transcribe_one(args.once, args.language, args.model, not args.no_vad)
        sys.stdout.write(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r.get("ok") else 1)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    sys.stderr.write(f"[transcribe] 就绪 http://127.0.0.1:{args.port}  model={DEFAULT_MODEL} device={DEVICE}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
