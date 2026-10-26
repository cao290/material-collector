/**
 * ============================================================================
 *  视频转写 · 唯一入口模块（数据层 / 服务客户端 / 取音频 / 批量任务 / HTTP API）
 * ============================================================================
 *
 *  这是「视频转写」功能的**全部后端代码**，按下面五节组织，改功能只改这里，
 *  不要把逻辑拆回 server.mjs 或新建文件——历史上就是因为散在 4 个文件里
 *  才出现「改一处忘一处」的 bug。
 *
 *  §1 数据层       transcriptions 表结构 + 增删查
 *  §2 服务客户端   拉起/重启本地 Python 转写服务（scripts/transcribe_server.py，端口 8355）
 *  §3 取音频       只取音频（不存视频）——转写的输入来源
 *  §4 批量任务     一次转写任务的状态机
 *  §5 HTTP API     /api/transcribe* 与 /api/transcriptions* 路由
 *
 *  服务端接入（server.mjs 里只需两步）：
 *      import { ensureTranscribeSchema, mountTranscribe } from './lib/transcribe.mjs';
 *      ensureTranscribeSchema(db);                       // 启动时建表
 *      mountTranscribe({ app: {...}, db, settings, ... }); // 挂路由
 *
 *  Python 引擎（scripts/transcribe_server.py）不在本文件内——它是独立进程，
 *  通过 HTTP 调用，本文件 §2 负责把它按需拉起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadAudioOnly } from './downloader.mjs';

/* ==========================================================================
 * §1 数据层：transcriptions 表
 * ========================================================================== */

export function ensureTranscribeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id          TEXT PRIMARY KEY,
      item_id     TEXT DEFAULT '',
      platform    TEXT DEFAULT '',
      title       TEXT DEFAULT '',
      file_path   TEXT NOT NULL,
      language    TEXT DEFAULT '',
      duration    REAL DEFAULT 0,
      char_count  INTEGER DEFAULT 0,
      segment_count INTEGER DEFAULT 0,
      text        TEXT DEFAULT '',
      segments    TEXT DEFAULT '',
      model       TEXT DEFAULT '',
      device      TEXT DEFAULT '',
      elapsed     REAL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'done',
      error       TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_tr_item ON transcriptions(item_id);
    CREATE INDEX IF NOT EXISTS idx_tr_platform ON transcriptions(platform);
  `);
}

const nowMs = () => Date.now();

/** 写入/更新一条转写结果（按 file_path 幂等） */
export function upsertTranscription(db, t) {
  const ts = nowMs();
  const existing = db.prepare('SELECT id FROM transcriptions WHERE file_path = ?').get(t.file_path);
  if (existing) {
    db.prepare(
      `UPDATE transcriptions SET text = ?, segments = ?, language = ?, duration = ?,
         char_count = ?, segment_count = ?, model = ?, device = ?, elapsed = ?,
         status = ?, error = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      t.text || '', JSON.stringify(t.segments || []), t.language || '', t.duration || 0,
      t.char_count || 0, t.segment_count || 0, t.model || '', t.device || '', t.elapsed || 0,
      t.status || 'done', t.error || '', ts, existing.id
    );
    return { id: existing.id, inserted: false };
  }
  const id = `tr-${ts}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO transcriptions (id, item_id, platform, title, file_path, language, duration,
       char_count, segment_count, text, segments, model, device, elapsed, status, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, t.item_id || '', t.platform || '', t.title || '', t.file_path, t.language || '',
    t.duration || 0, t.char_count || 0, t.segment_count || 0, t.text || '',
    JSON.stringify(t.segments || []), t.model || '', t.device || '', t.elapsed || 0,
    t.status || 'done', t.error || '', ts, ts
  );
  return { id, inserted: true };
}

export function queryTranscriptions(db, { platform, q, limit = 100, offset = 0, onlyEmpty } = {}) {
  const where = [];
  const params = [];
  if (platform) {
    where.push('platform = ?');
    params.push(platform);
  }
  if (q) {
    where.push('(text LIKE ? OR title LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (onlyEmpty) where.push('char_count = 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db
    .prepare(
      `SELECT id, item_id, platform, title, file_path, language, duration, char_count, segment_count,
              model, device, elapsed, status, error, created_at, substr(text,1,400) AS preview
       FROM transcriptions ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) n FROM transcriptions ${w}`).get(...params).n;
  return { rows, total };
}

export function getTranscription(db, id) {
  const row = db.prepare('SELECT * FROM transcriptions WHERE id = ?').get(id);
  if (row && row.segments) {
    try {
      row.segments = JSON.parse(row.segments);
    } catch {
      row.segments = [];
    }
  }
  return row;
}

export function transcriptionStats(db) {
  return db
    .prepare(
      'SELECT COUNT(*) n, COALESCE(SUM(char_count),0) chars, SUM(CASE WHEN char_count>0 THEN 1 ELSE 0 END) withSpeech FROM transcriptions'
    )
    .get();
}

/** 待转写素材数：audioOnly=true 时把「还没下载」的也算进来 */
export function countPendingTranscribe(db, { platform = '', audioOnly = false } = {}) {
  const where = [];
  const params = [];
  if (!audioOnly) where.push("local_path != ''", 'local_path IS NOT NULL');
  if (platform) {
    where.push('platform = ?');
    params.push(platform);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) n FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ${where.length ? 'AND' : 'WHERE'} id NOT IN
           (SELECT item_id FROM transcriptions WHERE item_id != '' AND status = 'done')`
    )
    .get(...params);
  return row.n;
}

/* ==========================================================================
 * §2 服务客户端：本地 Python 转写服务（faster-whisper）
 * ========================================================================== */

const PORT = Number(process.env.TRANSCRIBE_PORT) || 8355;
const BASE = `http://127.0.0.1:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_CANDIDATES = [
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python311/python.exe`,
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python312/python.exe`,
  'python',
  'python3',
];

let child = null;
let starting = null;

function findPython() {
  for (const p of PY_CANDIDATES) {
    if (p === 'python' || p === 'python3') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return 'python';
}

/** 服务是否在跑（连同 /health 的模型/设备信息） */
export async function isUp(timeoutMs = 2000) {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return { up: true, ...j };
  } catch {
    return { up: false };
  }
}

/** 确保服务在跑（首次拉起要加载模型，较慢） */
export async function ensureService({ waitMs = 90000 } = {}) {
  const cur = await isUp(800);
  if (cur.up) return { ok: true, reused: true, ...cur };
  if (starting) return starting;

  starting = (async () => {
    const py = findPython();
    const script = path.join(__dirname, '..', 'scripts', 'transcribe_server.py');
    child = spawn(py, [script], { cwd: path.dirname(script), detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    child.on('exit', () => {
      child = null;
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const st = await isUp(1500);
      if (st.up) return { ok: true, reused: false, ...st };
      await new Promise((r) => setTimeout(r, 1200));
    }
    return { ok: false, error: `转写服务启动超时（${waitMs}ms），请检查 Python 环境与 faster-whisper 安装` };
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** 强制重启服务（改了 .py 或换模型后调用） */
export async function restartService({ waitMs = 120000 } = {}) {
  try {
    const r = await fetch(`${BASE}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (r) await r.text().catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    const { execSync } = await import('node:child_process');
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', timeout: 8000 }
    );
  } catch {
    /* ignore */
  }
  child = null;
  await new Promise((r) => setTimeout(r, 800));
  return ensureService({ waitMs });
}

/** 转写单个音视频文件 */
export async function transcribeFile({ file, language = 'zh', model = '', vad = true, timeoutMs = 30 * 60 * 1000 }) {
  const st = await ensureService();
  if (!st.ok) return { ok: false, error: st.error };
  try {
    const r = await fetch(`${BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file, language, model, vad }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await r.json();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ==========================================================================
 * §3 取音频：转写的输入来源（只取音频，不保存视频）
 * ========================================================================== */

/**
 * 为一条素材取得可转写的音频文件。
 * - 已有本地视频 → 直接抽音频
 * - 未下载 → 现取新鲜直链（B站签名带 deadline），只拉独立音频流；无独立音频流的平台
 *   才下整片抽音频并立刻删视频（downloadAudioOnly 内部处理，见 lib/downloader.mjs）
 *
 * 依赖（由 server.mjs 注入）：
 *   getItem(id)                         → items 行
 *   updateItem(id, patch)               → 回写新鲜直链
 *   getFreshDetail(item, signal)        → 浏览器里补一次详情（fetchDetailForItem）
 *   getCookies()                        → 浏览器 cookie
 *   getOutDir()                         → 下载根目录
 */
async function acquireAudio(deps, { itemId, platform }) {
  const item = deps.getItem(itemId);
  if (!item) throw new Error('素材不存在');

  const controller = new AbortController();
  let ctx = null;
  let finalItem = item;
  try {
    // B站/抖音直链会过期；没有本地文件就必须现取一个新鲜直链
    if (!item.audio_url || (platform === 'bilibili' && item.video_url)) {
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
        deps.updateItem(itemId, { audio_url: finalItem.audio_url || '', video_url: finalItem.video_url || '' });
      }
    }

    const inPageFetch = ctx?.tab
      ? async (url) => ctx.tab.fetchBinaryInPage(url, { onProgress: () => {} })
      : null;

    return await downloadAudioOnly({
      item: finalItem,
      outDir: deps.getOutDir(),
      cookies: await deps.getCookies(),
      signal: controller.signal,
      inPageFetch,
    });
  } finally {
    if (ctx) {
      await ctx.tab.closeTab().catch(() => {});
      await ctx.base.destroy?.().catch(() => {});
    }
  }
}

/* ==========================================================================
 * §4 批量任务：一次转写任务的状态机
 * ========================================================================== */

const tasks = new Map(); // taskId -> {total, done, ok, failed, status, current, audioBytes, results[]}

/** 把「要转写的素材」解析成一个列表（有本地文件直接用；audioOnly 时可现取音频） */
function resolveFiles(db, deps, body, audioOnly, limit) {
  const files = [];

  if (Array.isArray(body.paths) && body.paths.length) {
    for (const p of body.paths) files.push({ file: String(p), itemId: '', platform: '', title: '', temp: false });
    return files;
  }

  const platform = body.platform || '';
  const ids = Array.isArray(body.ids) && body.ids.length
    ? body.ids
    : db
        .prepare(
          `SELECT id FROM items
           ${audioOnly ? 'WHERE' : "WHERE local_path != '' AND local_path IS NOT NULL AND"}
             ${platform ? 'platform = ? AND' : ''}
             id NOT IN (SELECT item_id FROM transcriptions WHERE item_id != '' AND status = 'done')
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(...(platform ? [platform] : []), limit)
        .map((r) => r.id);

  for (const id of ids) {
    const item = deps.getItem(id);
    if (!item) continue;
    if (item.local_path && fs.existsSync(item.local_path)) {
      files.push({ file: item.local_path, itemId: item.id, platform: item.platform, title: item.title || '', temp: false });
    } else if (audioOnly) {
      files.push({ file: '', itemId: item.id, platform: item.platform, title: item.title || '', temp: true, needAudio: true });
    }
  }
  return files;
}

/* ==========================================================================
 * §5 HTTP API
 * ========================================================================== */

/**
 * 挂载转写相关路由。
 *
 * ⚠️ 注入的函数签名（别传 db 版原函数，这里不带 db 参数）：
 *     getItem(id) → items 行          （server 里写 getItem: (id) => getItem(db, id)）
 *     updateItem(id, patch)
 *     getFreshDetail(item, signal) → {detail, tab, base} | null
 *     getCookies() → cookie 数组
 *     getOutDir() → 下载根目录
 *
 * @param {object} opts
 * @param {object} opts.app      { sendJson, readBody, route(method, path, handler) }
 * @param {object} opts.db       SQLite 实例（本模块自用）
 * @param {object} opts.settings 设置对象（可变引用）
 * @param {Function} [opts.pushWebhook]
 */
export function mountTranscribe(opts) {
  const { app, db, settings, getItem, updateItem, getFreshDetail, getCookies, getOutDir, pushWebhook } = opts;
  const { sendJson, readBody, route } = app;
  const deps = { getItem, updateItem, getFreshDetail, getCookies, getOutDir };

  /* --- 状态 --- */
  route('GET', '/api/transcribe/status', async (_req, res) => {
    const st = await isUp(2500);
    return sendJson(res, 200, {
      ...st,
      stats: transcriptionStats(db),
      settings: {
        model: settings.transcribeModel || 'medium',
        language: settings.transcribeLanguage || 'zh',
      },
    });
  });

  /* --- 重启服务 --- */
  route('POST', '/api/transcribe/restart', async (_req, res) => {
    const st = await restartService();
    return sendJson(res, st.ok ? 200 : 500, st);
  });

  /* --- 待转写数量 --- */
  route('GET', '/api/transcribe/pending', async (_req, res, url) => {
    const audioOnly = url.searchParams.get('audioOnly') === '1';
    return sendJson(res, 200, {
      pending: countPendingTranscribe(db, { platform: url.searchParams.get('platform') || '', audioOnly }),
      audioOnly,
    });
  });

  /* --- 发起转写 --- */
  route('POST', '/api/transcribe', async (req, res) => {
    const body = await readBody(req);
    const audioOnly = !!body.audioOnly;
    const dropAfter = !!body.dropAfter;
    const limit = Math.min(Number(body.limit) || 5, 50);

    const files = resolveFiles(db, deps, body, audioOnly, limit);
    if (!files.length) {
      return sendJson(res, 400, {
        error: audioOnly
          ? '没有可转写的素材（该平台可能拿不到音频流；试试先下载）'
          : '没有可转写的文件（素材需要先下载到本地，或勾选「仅取音频」）',
      });
    }

    const st = await ensureService();
    if (!st.ok) return sendJson(res, 500, { error: st.error || '转写服务不可用' });

    const taskId = `tr-${Date.now().toString(36)}`;
    const task = { id: taskId, total: files.length, done: 0, ok: 0, failed: 0, status: 'running', audioOnly, current: '', audioBytes: 0, results: [], startedAt: Date.now() };
    tasks.set(taskId, task);

    const language = body.language ?? settings.transcribeLanguage ?? 'zh';
    const model = body.model || settings.transcribeModel || 'medium';
    runTranscribeTask({ db, deps, task, files, language, model, dropAfter, pushWebhook });

    return sendJson(res, 200, { ok: true, taskId, total: files.length, audioOnly });
  });

  /* --- 任务进度 --- */
  route('GET', '/api/transcribe/task', async (_req, res, url) => {
    const t = tasks.get(url.searchParams.get('id') || '');
    if (!t) return sendJson(res, 404, { error: '任务不存在' });
    return sendJson(res, 200, t);
  });

  /* --- 结果列表 / 详情 / 导出 --- */
  route('GET', '/api/transcriptions', async (_req, res, url) => {
    const q = url.searchParams;
    return sendJson(res, 200, queryTranscriptions(db, {
      platform: q.get('platform') || '',
      q: q.get('q') || '',
      onlyEmpty: q.get('onlyEmpty') === '1',
      limit: Math.min(Number(q.get('limit')) || 100, 500),
      offset: Number(q.get('offset')) || 0,
    }));
  });

  route('GET', '/api/transcriptions/get', async (_req, res, url) => {
    const row = getTranscription(db, url.searchParams.get('id') || '');
    return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: '不存在' });
  });

  route('GET', '/api/transcriptions/srt', async (_req, res, url) => {
    const row = getTranscription(db, url.searchParams.get('id') || '');
    if (!row) return res.writeHead(404).end('not found');
    const segs = Array.isArray(row.segments) ? row.segments : [];
    const fmt = (t) => {
      const h = String(Math.floor(t / 3600)).padStart(2, '0');
      const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
      const s = String(Math.floor(t % 60)).padStart(2, '0');
      const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
      return `${h}:${m}:${s},${ms}`;
    };
    const srt = segs.map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`).join('\n');
    const name = encodeURIComponent((row.title || 'transcript').slice(0, 40) + '.srt');
    res.writeHead(200, {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    });
    res.end('\ufeff' + srt);
  });

  route('GET', '/api/transcriptions/txt', async (_req, res, url) => {
    const row = getTranscription(db, url.searchParams.get('id') || '');
    if (!row) return res.writeHead(404).end('not found');
    const name = encodeURIComponent((row.title || 'transcript').slice(0, 40) + '.txt');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    });
    res.end(row.text || '');
  });
}

/** 后台跑一个转写任务（逐条：取音频 → 转写 → 落库 → 清理） */
async function runTranscribeTask({ db, deps, task, files, language, model, dropAfter, pushWebhook }) {
  for (const f of files) {
    let acquired = null; // 本次为「仅取音频」临时取到的音频
    try {
      let filePath = f.file;
      if (f.needAudio) {
        task.current = `取音频：${(f.title || f.itemId).slice(0, 24)}`;
        acquired = await acquireAudio(deps, { itemId: f.itemId, platform: f.platform });
        filePath = acquired.path;
        task.audioBytes += acquired.size || 0;
      }
      if (!filePath || !fs.existsSync(filePath)) throw new Error('音频文件不存在');

      task.current = `转写：${(f.title || path.basename(filePath)).slice(0, 24)}`;
      const r = await transcribeFile({ file: filePath, language, model: model === 'medium' ? '' : model });
      if (r.ok) {
        upsertTranscription(db, {
          item_id: f.itemId, platform: f.platform, title: f.title, file_path: filePath,
          language: r.language, duration: r.duration, char_count: r.charCount || 0,
          segment_count: r.segmentCount || 0, text: r.text || '', segments: r.segments || [],
          model: r.model, device: r.device, elapsed: r.elapsed, status: 'done',
        });
        task.ok += 1;
        task.results.push({ file: filePath, ok: true, chars: r.charCount || 0, elapsed: r.elapsed, audio: !!acquired });
      } else {
        upsertTranscription(db, {
          item_id: f.itemId, platform: f.platform, title: f.title, file_path: filePath,
          status: 'error', error: r.error || '未知错误',
        });
        task.failed += 1;
        task.results.push({ file: filePath, ok: false, error: r.error });
      }
    } catch (error) {
      task.failed += 1;
      task.results.push({ file: f.file || f.itemId, ok: false, error: error.message });
    } finally {
      // 仅取音频的临时文件，或用户勾了「转完删音频」→ 删掉，只留文字
      if (acquired?.path && (f.temp || dropAfter)) {
        fs.promises.unlink(acquired.path).catch(() => {});
      }
    }
    task.done += 1;
  }
  task.status = 'done';
  task.current = '';
  task.finishedAt = Date.now();
  pushWebhook?.('transcribe.done', { taskId: task.id, total: task.total, ok: task.ok, failed: task.failed });
}
