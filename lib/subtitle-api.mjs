/**
 * 字幕检测 API（挂载到 server.mjs）
 *
 * POST /api/subtitle/detect   {ids[]|scope:'pending'|'all', limit?} → {taskId}
 * GET  /api/subtitle/task?id=                    任务进度
 * POST /api/subtitle/cancel  {taskId}            取消任务
 *
 * 检测结果写 items.subtitle（none=无字幕 / hard=有硬字幕 / unknown=失败），
 * items.subtitle_ratio 存「字幕行出现在多少比例的抽帧里」。
 */
import { detectBatch } from './subtitle.mjs';

export function mountSubtitleApi({ app, db, settings, pushWebhook, tasks, aborts, getItem, updateItem, getFreshDetail, getCookies }) {
  const { sendJson, readBody, route } = app;

  route('POST', '/api/subtitle/detect', async (req, res) => {
    const body = await readBody(req);
    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) {
      // scope: 'pending'（未检测过的）或 'all'
      const where = ["video_url != ''"];
      if (body.scope !== 'all') where.push("(subtitle IS NULL OR subtitle = '')");
      if (body.platform) {
        where.push('platform = ?');
        ids = db
          .prepare(`SELECT id FROM items WHERE ${where.join(' AND ')} AND platform = ? ORDER BY created_at DESC LIMIT ?`)
          .all(...[body.platform, Math.min(Number(body.limit) || 20, 100)])
          .map((r) => r.id);
      } else {
        ids = db
          .prepare(`SELECT id FROM items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
          .all(Math.min(Number(body.limit) || 20, 100))
          .map((r) => r.id);
      }
    }
    ids = ids.filter(Boolean);
    if (!ids.length) return sendJson(res, 400, { error: '没有可检测的素材' });

    const taskId = `sub-${Date.now().toString(36)}`;
    const controller = new AbortController();
    aborts.set(taskId, controller);
    const task = {
      id: taskId,
      total: ids.length,
      done: 0,
      ok: 0,
      none: 0,
      hard: 0,
      failed: 0,
      status: 'running',
      current: '',
      sampleBytes: 0,
      results: [],
      startedAt: Date.now(),
    };
    tasks.set(taskId, task);

    const deps = {
      getItem,
      updateItem,
      getFreshDetail,
      getCookies,
    };

    (async () => {
      try {
        const results = await detectBatch(deps, ids, {
          signal: controller.signal,
          onProgress: (p) => {
            task.done = p.done;
            task.current = `检测：${(p.id || '').slice(-14)}`;
            if (p.ok) {
              task.ok += 1;
              task[p.hasSubtitle ? 'hard' : 'none'] += 1;
              task.sampleBytes += p.sampleBytes || 0;
            } else {
              task.failed += 1;
            }
            task.results.push({ id: p.id, ok: p.ok, hasSubtitle: p.hasSubtitle, error: p.error });
          },
        });
        task.status = 'done';
        task.current = '';
        task.finishedAt = Date.now();
        pushWebhook?.('subtitle.detect.done', {
          taskId,
          total: task.total,
          none: task.none,
          hard: task.hard,
          failed: task.failed,
          sampleBytes: task.sampleBytes,
        });
      } catch (error) {
        task.status = 'error';
        task.error = error.message;
      }
    })();

    return sendJson(res, 200, { ok: true, taskId, total: ids.length });
  });

  route('GET', '/api/subtitle/task', async (_req, res, url) => {
    const id = url.searchParams.get('id') || '';
    // 无 id 时前端是在轮询「有没有任务」，不该报 404（会污染控制台并让调用方以为是错误）
    if (!id) return sendJson(res, 200, { id: '', status: 'none', total: 0, current: '' });
    const t = tasks.get(id);
    if (!t) return sendJson(res, 404, { error: '任务不存在' });
    return sendJson(res, 200, t);
  });

  route('POST', '/api/subtitle/cancel', async (req, res) => {
    const body = await readBody(req);
    const c = aborts.get(body.taskId || '');
    if (!c) return sendJson(res, 404, { error: '任务不存在' });
    c.abort();
    return sendJson(res, 200, { ok: true });
  });
}
