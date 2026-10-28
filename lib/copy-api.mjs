/**
 * 文案·评论采集与 AI 加工的 API 处理器（由 server.mjs 挂载）
 */
import {
  createCopyJob, updateCopyJob, listCopyJobs, getCopyJob,
  upsertCopy, queryCopies,
  upsertComment, queryComments, commentTargetGroups,
  saveAiResult, listAiResults,
} from './db-copies.mjs';
import { runCopyCollect } from './copy-engine.mjs';
import { PLATFORM_META } from './adapters/base.mjs';
import { getAdapter } from './collector.mjs';

const NEED_LOGIN = { douyin: true, xhs: true, kuaishou: true, bilibili: false };

/** AI 提示词模板；{content} 会被替换为素材 */
const AI_ACTIONS = {
  rewrite: {
    label: '改写文案',
    kind: 'copy',
    prompt: `你是一个爆款短视频文案操盘手。下面是原始文案，请在保留它钩子结构和情绪节奏的前提下，改写成 3 个不同的版本：口语化、有网感、去掉平台腔和 AI 味。每个版本独立成段，前面用【版本1】【版本2】【版本3】标注。

原始文案：
{content}`,
  },
  imitate: {
    label: '仿写同款',
    kind: 'copy',
    prompt: `先分析下面这条文案的结构（钩子/痛点/转折/行动指令），然后用同样的结构仿写 3 条新文案，主题是：{theme}。只输出仿写结果，每条前面用【1】【2】【3】标注。

参考文案：
{content}`,
  },
  hooks: {
    label: '提炼钩子',
    kind: 'copy',
    prompt: `下面是若干条同主题的爆款文案。请提炼出它们共用的钩子公式和开头套路，输出：1. 钩子公式清单（每条给公式+一句原文佐证）；2. 可直接套用的 5 个开头句式。

文案列表：
{content}`,
  },
  commentSummary: {
    label: '总结评论',
    kind: 'comments',
    prompt: `下面是一条视频的评论区内容。请输出：
1. 高频需求/痛点 TOP5（按出现强度排序，附原文引用）
2. 用户情绪倾向
3. 3 个可以马上做的选题方向（每个附一句理由）

评论列表（按点赞排序）：
{content}`,
  },
  script: {
    label: '生成混剪脚本',
    kind: 'copy',
    prompt: `根据下面的文案和热评，写一个 30-45 秒的混剪口播脚本。格式：
【开头钩子】（0-3秒）
【主体】（分 3-4 段，每段标建议画面类型）
【结尾引导】（点赞/关注/评论引导）

原始文案：
{content}`,
  },
  speechPoints: {
    label: '提炼口播要点',
    kind: 'transcript',
    prompt: `下面是一条视频的口播转写文本。请输出：
1. 这条视频在讲什么（2 句话概括）
2. 核心要点 TOP5（每条一句话，按重要性排序）
3. 3 条可直接复用的钩子或金句（附原文佐证）

转写文本：
{content}`,
  },
  speechScript: {
    label: '口播转混剪脚本',
    kind: 'transcript',
    prompt: `根据下面的视频口播转写文本，写一个 30-45 秒的混剪口播脚本。格式：
【开头钩子】（0-3秒）
【主体】（分 3-4 段，每段标建议画面类型）
【结尾引导】（点赞/关注/评论引导）

原始口播：
{content}`,
  },
  custom: {
    label: '自定义',
    kind: 'both',
    prompt: '',
  },
};

export function mountCopyApi({ app, db, settings, saveSettings, browserHostRef, runningCopy, getBrowserHost, pushWebhook, onCaptchaAlert }) {
  const sendJson = app.sendJson;
  const readBody = app.readBody;

  /* ---------- 文案任务 ---------- */

  app.route('POST', '/api/copy/jobs', async (req, res) => {
    const body = await readBody(req);
    const platform = String(body.platform || '');
    const host = getBrowserHost();
    if (!host) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    if (!PLATFORM_META[platform]) return sendJson(res, 400, { error: '未知平台' });
    const keywords = (Array.isArray(body.keywords) ? body.keywords : String(body.keyword || '').split('\n'))
      .map((k) => String(k).trim()).filter(Boolean);
    if (!keywords.length) return sendJson(res, 400, { error: '关键词不能为空' });

    // 先做去重检查（重复提交应直接告知「已有任务」，而不是报内核忙）
    const dupCheck = keywords
      .map((kw) => ({
        keyword: kw,
        dup: db
          .prepare(
            "SELECT id, status FROM copy_jobs WHERE platform = ? AND keyword = ? AND status IN ('pending','running','need_human') ORDER BY created_at DESC LIMIT 1"
          )
          .get(platform, kw),
      }))
      .filter((x) => x.dup);
    if (dupCheck.length === keywords.length) {
      return sendJson(res, 409, {
        error: 'DUPLICATE',
        message: `${keywords.length} 个关键词都已有进行中的任务（状态：${dupCheck[0].dup.status}），请先点「继续」或「清理卡住的任务」`,
        existing: dupCheck,
      });
    }

    if (host.isBusy?.()) return sendJson(res, 409, { error: 'BUSY', message: '内核被占用，稍后再试' });

    const target = Math.min(Number(body.target) || 30, 200);
    const withComments = !!body.withComments;
    if (body.commentsPerVideo !== undefined) {
      settings.copyCommentTarget = Math.min(Number(body.commentsPerVideo) || 50, 300);
      saveSettings();
    }
    const ids = [];
    const skipped = [];
    for (const keyword of keywords) {
      // 去重：同平台+同关键词已有未结束任务，就跳过（避免重复堆积）
      const dup = db
        .prepare(
          "SELECT id FROM copy_jobs WHERE platform = ? AND keyword = ? AND status IN ('pending','running','need_human') ORDER BY created_at DESC LIMIT 1"
        )
        .get(platform, keyword);
      if (dup) {
        skipped.push({ keyword, jobId: dup.id, reason: '已有进行中任务' });
        continue;
      }
      const jobId = createCopyJob(db, { platform, keyword, mode: 'search', target, withComments });
      ids.push(jobId);
      startCopyJob({ jobId, platform, keyword, target, withComments });
    }
    return sendJson(res, 200, {
      ok: true,
      jobIds: ids,
      skipped,
      message: skipped.length ? `${skipped.length} 个关键词已有进行中任务，已跳过（可先点「清理卡住的任务」）` : '',
    });
  });

  function startCopyJob({ jobId, platform, keyword, target, withComments, resume = false }) {
    const host = getBrowserHost();
    const controller = new AbortController();
    runningCopy.set(jobId, { controller });

    const commentTarget = Math.min(settings.copyCommentTarget || 50, 100);

    (async () => {
      updateCopyJob(db, jobId, { status: 'running' });

      // 登录预检
      if (NEED_LOGIN[platform]) {
        try {
          const map = await host.getLoginStatus();
          if (!map[platform]) {
            updateCopyJob(db, jobId, {
              status: 'need_human',
              message: `${PLATFORM_META[platform].label} 未登录：请到「内置浏览器」扫码登录后点「继续」`,
            });
            runningCopy.delete(jobId);
            return;
          }
        } catch {
          /* 交给运行中检测 */
        }
      }

      try {
        const result = await runCopyCollect({
          cautious: resume,
          createSession: () => host.createCollectSession(),
          platform,
          keyword,
          target,
          withComments,
          commentTarget,
          signal: controller.signal,
          checkLogin: () => host.getLoginStatus(),
          onCaptcha: async ({ reason, url }) => {
            const r = await host.bringCaptchaFront(url).catch(() => null);
            if (typeof onCaptchaAlert === 'function') {
              onCaptchaAlert({
                platform,
                jobId,
                reason,
                url,
                shownInPane: !!(r && r.ok),
                hint: r && r.ok
                  ? '验证码已显示在「内置浏览器」面板里，完成后点下面按钮'
                  : '验证码没能自动显示，请到「内置浏览器」手动打开该平台',
              });
            }
          },
          onProgress: ({ status, message, found }) => {
            const patch = {};
            if (status) patch.status = status;
            if (message) patch.message = message;
            if (typeof found === 'number') patch.found = found;
            updateCopyJob(db, jobId, patch);
          },
          onCopies: (items) => {
            for (const item of items) upsertCopy(db, item);
          },
          onComments: (comments) => {
            for (const c of comments) upsertComment(db, c);
          },
        });
        for (const item of result.copies) upsertCopy(db, item);
        pushWebhook?.('copy.done', { jobId, platform, keyword, found: result.copies.length, status: result.needHuman ? 'need_human' : 'done' });
        updateCopyJob(db, jobId, {
          status: result.needHuman ? 'need_human' : 'done',
          found: result.copies.length,
          message: result.needHuman
            ? (result.message || '等待浏览器里完成登录/验证')
            : `完成，文案 ${result.copies.length} 条`,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          updateCopyJob(db, jobId, { status: 'cancelled', message: '已取消' });
        } else if (error.code === 'BUSY') {
          updateCopyJob(db, jobId, { status: 'error', message: '内核忙，稍后重试' });
        } else {
          updateCopyJob(db, jobId, { status: 'error', message: error.message || String(error) });
          pushWebhook?.('copy.error', { jobId, platform, keyword, error: error.message });
        }
      } finally {
        runningCopy.delete(jobId);
      }
    })();
  }

  app.route('GET', '/api/copy/jobs', async (_req, res) => {
    return sendJson(res, 200, { jobs: listCopyJobs(db) });
  });

  app.route('POST', '/api/copy/jobs/resume', async (req, res) => {
    const body = await readBody(req);
    const job = getCopyJob(db, String(body.jobId || ''));
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    const host = getBrowserHost();
    if (host.isBusy?.()) return sendJson(res, 409, { error: 'BUSY', message: '内核忙，稍后再试' });
    // 复用原任务记录继续跑（不新建），保留已采数量
    updateCopyJob(db, job.id, { status: 'running', message: '继续采集中' });
    startCopyJob({
      jobId: job.id,
      platform: job.platform,
      keyword: job.keyword,
      target: job.target,
      withComments: !!job.with_comments,
      resume: true,
    });
    return sendJson(res, 200, { ok: true, jobId: job.id });
  });

  // 清理卡住的任务（批量取消 need_human / running）
  app.route('POST', '/api/copy/jobs/clear-stuck', async (_req, res) => {
    const rows = db.prepare("SELECT id FROM copy_jobs WHERE status IN ('need_human','running','pending')").all();
    for (const r of rows) {
      const rec = runningCopy.get(r.id);
      if (rec) rec.controller.abort();
      updateCopyJob(db, r.id, { status: 'cancelled', message: '手动清理' });
    }
    return sendJson(res, 200, { ok: true, cleared: rows.length });
  });

  app.route('POST', '/api/copy/jobs/cancel', async (req, res) => {
    const body = await readBody(req);
    const rec = runningCopy.get(String(body.jobId || ''));
    if (rec) rec.controller.abort();
    return sendJson(res, 200, { ok: true });
  });

  /* ---------- 文案 / 评论列表 ---------- */

  app.route('GET', '/api/copies', async (req, res, url) => {
    const q = url.searchParams;
    const result = queryCopies(db, {
      platform: q.get('platform') || '',
      keyword: q.get('keyword') || '',
      q: q.get('q') || '',
      sort: q.get('sort') || 'likes',
      limit: Math.min(Number(q.get('limit')) || 100, 500),
      offset: Number(q.get('offset')) || 0,
    });
    return sendJson(res, 200, result);
  });

  app.route('GET', '/api/comments', async (req, res, url) => {
    const q = url.searchParams;
    const result = queryComments(db, {
      platform: q.get('platform') || '',
      targetId: q.get('targetId') || '',
      q: q.get('q') || '',
      minLikes: Number(q.get('minLikes')) || 0,
      sort: q.get('sort') || 'likes',
      limit: Math.min(Number(q.get('limit')) || 200, 1000),
      offset: Number(q.get('offset')) || 0,
    });
    return sendJson(res, 200, result);
  });

  app.route('GET', '/api/comments/groups', async (req, res, url) => {
    const platform = url.searchParams.get('platform') || '';
    return sendJson(res, 200, { groups: commentTargetGroups(db, { platform }) });
  });

  app.route('GET', '/api/copy/keywords', async (_req, res) => {
    const rows = db.prepare(
      `SELECT keyword, platform, COUNT(*) n FROM copies WHERE keyword != '' GROUP BY keyword, platform ORDER BY MAX(created_at) DESC LIMIT 100`
    ).all();
    return sendJson(res, 200, { keywords: rows });
  });

  /* ---------- AI 加工 ---------- */

  app.route('GET', '/api/ai/actions', async (_req, res) => {
    return sendJson(res, 200, {
      actions: Object.entries(AI_ACTIONS).map(([id, a]) => ({ id, label: a.label, kind: a.kind, hasTemplate: !!a.prompt })),
    });
  });

  app.route('GET', '/api/ai/config', async (_req, res) => {
    return sendJson(res, 200, {
      aiBaseUrl: settings.aiBaseUrl || '',
      aiApiKey: settings.aiApiKey ? '••••已保存' : '',
      aiModel: settings.aiModel || '',
      hasKey: !!settings.aiApiKey,
    });
  });

  app.route('POST', '/api/ai/config', async (req, res) => {
    const body = await readBody(req);
    if (body.aiBaseUrl !== undefined) settings.aiBaseUrl = String(body.aiBaseUrl).replace(/\/+$/, '');
    if (body.aiModel !== undefined) settings.aiModel = String(body.aiModel);
    if (body.aiApiKey !== undefined && body.aiApiKey && !String(body.aiApiKey).startsWith('••••')) {
      settings.aiApiKey = String(body.aiApiKey);
    }
    saveSettings();
    return sendJson(res, 200, { ok: true });
  });

  app.route('POST', '/api/ai/test', async (req, res) => {
    const body = await readBody(req);
    const base = (body.aiBaseUrl || settings.aiBaseUrl || '').replace(/\/+$/, '');
    const key = body.aiApiKey && !String(body.aiApiKey).startsWith('••••') ? body.aiApiKey : settings.aiApiKey;
    const model = body.aiModel || settings.aiModel;
    if (!base) return sendJson(res, 400, { error: '先填接口地址' });
    try {
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: '回复"连接成功"四个字' }],
          max_tokens: 20,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return sendJson(res, 200, { ok: false, error: `HTTP ${response.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}` });
      }
      const text = data.choices?.[0]?.message?.content || '';
      return sendJson(res, 200, { ok: true, reply: text.slice(0, 100) });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message });
    }
  });

  app.route('GET', '/api/ai/models', async (_req, res) => {
    const base = (settings.aiBaseUrl || '').replace(/\/+$/, '');
    if (!base) return sendJson(res, 400, { error: '先配置接口地址' });
    try {
      const response = await fetch(base + '/models', {
        headers: settings.aiApiKey ? { authorization: `Bearer ${settings.aiApiKey}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json().catch(() => ({}));
      const models = (data.data || []).map((m) => m.id).filter(Boolean);
      return sendJson(res, 200, { ok: true, models });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message, models: [] });
    }
  });

  app.route('POST', '/api/ai/run', async (req, res) => {
    const body = await readBody(req);
    const action = String(body.action || '');
    const tpl = AI_ACTIONS[action];
    if (!tpl) return sendJson(res, 400, { error: '未知动作' });
    const base = (settings.aiBaseUrl || '').replace(/\/+$/, '');
    if (!base) return sendJson(res, 400, { error: '先在设置里配置模型接口' });
    if (!settings.aiModel) return sendJson(res, 400, { error: '先在设置里填模型名' });

    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length && !body.targetId && !body.transcriptIds?.length) {
      return sendJson(res, 400, { error: '没有选中内容' });
    }

    // 取素材拼上下文
    let parts = [];
    let kind = tpl.kind;
    if (body.transcriptIds?.length) {
      // 口播转写文本作为素材
      const trIds = body.transcriptIds;
      for (const id of trIds) {
        const row = db.prepare(`SELECT title, platform, duration, text FROM transcriptions WHERE id = ?`).get(id);
        if (row && row.text) {
          parts.push(`【${row.title || '(无标题)'}】(${row.platform || ''} ${Math.round(row.duration || 0)}s)\n${row.text}`);
        }
      }
      kind = 'transcript';
    } else if (kind === 'comments' || body.targetId) {
      const result = queryComments(db, {
        targetId: body.targetId || '',
        limit: 300,
        sort: 'likes',
      });
      parts = result.rows.map((c) => `[赞${c.likes}] ${c.content}`);
      kind = 'comments';
    } else {
      for (const id of ids) {
        const row = db.prepare(`SELECT * FROM copies WHERE id = ?`).get(id);
        if (row) {
          parts.push(
            `【${row.title || '(无标题)'}】\n${row.content || ''}${row.tags ? `\n话题：${row.tags}` : ''}\n(赞${row.likes}/藏${row.collects}/评${row.comments})`
          );
        }
      }
    }
    if (!parts.length) return sendJson(res, 400, { error: '素材内容为空' });

    const content = parts.join('\n---\n').slice(0, 24000);
    let prompt = (body.customPrompt && body.customPrompt.trim())
      ? body.customPrompt.trim().replaceAll('{content}', content)
      : tpl.prompt.replace('{content}', content).replace('{theme}', body.theme || '同一主题');
    try {
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.aiApiKey ? { authorization: `Bearer ${settings.aiApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.aiModel,
          messages: [
            { role: 'system', content: '你是短视频内容操盘助手，输出简洁、直接可用的中文结果，不要客套和复述要求。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return sendJson(res, 200, { ok: false, error: `HTTP ${response.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}` });
      }
      const output = data.choices?.[0]?.message?.content || '';
      if (!output) return sendJson(res, 200, { ok: false, error: '模型返回为空' });

      saveAiResult(db, {
        kind,
        action,
        model: settings.aiModel,
        inputIds: ids.length ? ids : [body.targetId],
        inputText: content.slice(0, 2000),
        output,
      });
      return sendJson(res, 200, { ok: true, output, action, label: tpl.label });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message });
    }
  });

  app.route('GET', '/api/ai/results', async (_req, res) => {
    return sendJson(res, 200, { results: listAiResults(db) });
  });
}
