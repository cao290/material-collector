/**
 * 字幕检测编排：对素材「只取小样」→ 抽帧检测 → 标注 → 清理小样。
 *
 * 流程（每条素材）：
 *   1. 取新鲜直链（B站签名会过期）
 *   2. downloadSample 只拉前 ~6MB（对比整片 50-300MB，省 95%+）
 *   3. Python 抽帧 + OpenCV 检测（跨帧位置一致性判定，抗反光误报）
 *   4. 结果写 items.subtitle（none=无字幕 / hard=有字幕 / unknown=检测失败），删小样
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadSample } from './downloader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'subtitle_detect.py');

const PY_CANDIDATES = [
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python311/python.exe`,
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python312/python.exe`,
  'python',
];

function findPython() {
  for (const p of PY_CANDIDATES) {
    if (p === 'python') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'python';
}

/**
 * 对单条素材做字幕检测。
 * @param {object} deps {getItem, updateItem, getFreshDetail, getCookies, fetchDetailSignal}
 * @returns {{ok, hasSubtitle, confidence, sampleBytes, error?}}
 */
export async function detectItemSubtitle(deps, itemId) {
  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: '素材不存在' };

  const controller = new AbortController();
  let ctx = null;
  let finalItem = item;
  try {
    // B站/抖音直链会过期：现取新鲜直链
    if (!item.video_url || item.platform === 'bilibili') {
      ctx = await deps.getFreshDetail(item, controller.signal);
      if (ctx?.detail) {
        const d = ctx.detail;
        finalItem = {
          ...item,
          video_url: d.video_url || item.video_url,
          video_backups: d.video_backups || [],
          audio_url: d.audio_url || item.audio_url,
          audio_backups: d.audio_backups || [],
        };
        deps.updateItem(itemId, { video_url: finalItem.video_url || '', audio_url: finalItem.audio_url || '' });
      }
    }
    if (!finalItem.video_url) {
      deps.updateItem(itemId, { subtitle: 'unknown' });
      return { ok: false, error: '没有视频直链' };
    }

    const inPageFetch = ctx?.tab
      ? async (url) => ctx.tab.fetchBinaryInPage(url, { onProgress: () => {} })
      : null;

    // 1) 小样：只拉前 6MB（失败自动加倍到 12MB 重试一次）
    let sample = null;
    let result = null;
    for (const cap of [6, 12, 20]) {
      sample = await downloadSample({
        item: finalItem,
        tmpDir: path.join(os.tmpdir(), 'collector-subsample'),
        maxBytes: cap * 1024 * 1024,
        cookies: await deps.getCookies(),
        signal: controller.signal,
        inPageFetch,
      });
      result = await runPythonDetect(sample.path);
      if (result.ok) break;
    }

    // 3) 清理小样（无论成败都删）
    await fsp.unlink(sample.path).catch(() => {});

    if (result.ok) {
      const sub = result.hasSubtitle ? 'hard' : 'none';
      deps.updateItem(itemId, {
        subtitle: sub,
        subtitle_ratio: result.ratio ?? 0,
      });
      return { ok: true, hasSubtitle: result.hasSubtitle, confidence: result.ratio, sampleBytes: sample.size };
    }
    deps.updateItem(itemId, { subtitle: 'unknown' });
    return { ok: false, error: result.error || '检测失败', sampleBytes: sample.size };
  } catch (error) {
    deps.updateItem(itemId, { subtitle: item.subtitle || 'unknown' });
    return { ok: false, error: error.message };
  } finally {
    if (ctx) {
      await ctx.tab.closeTab().catch(() => {});
      await ctx.base.destroy?.().catch(() => {});
    }
  }
}

/** 调 Python 检测脚本 */
function runPythonDetect(videoPath, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const py = findPython();
    const proc = spawn(py, [SCRIPT, videoPath], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: '检测超时' });
    }, timeoutMs);
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop() || '{}');
        resolve(j);
      } catch {
        resolve({ ok: false, error: `解析失败(code=${code}) ${(err || out).slice(-200)}` });
      }
    });
  });
}

/** 批量检测（串行，每条之间歇一下别触发风控） */
export async function detectBatch(deps, ids, { onProgress, signal, pauseMs = 800 } = {}) {
  const results = [];
  for (const id of ids) {
    if (signal?.aborted) break;
    const r = await detectItemSubtitle(deps, id);
    results.push({ id, ...r });
    onProgress?.({ id, ...r, done: results.length, total: ids.length });
    if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
  }
  return results;
}
