/**
 * 文案采集任务主体
 * - search 模式：打开搜索页，拦截搜索接口 + DOM 解析拿文案
 * - withComments：对每条文案进详情页采评论
 */
import { jitter, autoScroll, detectBlock, PLATFORM_META } from './adapters/base.mjs';
import { collectComments } from './copy-collector.mjs';

/**
 * @param {object} opts
 * @param {function} opts.createSession
 * @param {string} opts.platform
 * @param {string} opts.keyword
 * @param {number} opts.target 文案条数
 * @param {boolean} opts.withComments 是否采评论
 * @param {number} opts.commentTarget 每条内容最多采多少条评论
 */
export async function runCopyCollect({ createSession, platform, keyword, target = 30, withComments = false, commentTarget = 50, onProgress, onCopies, onComments, signal, checkLogin, onCaptcha, cautious = false }) {
  const meta = PLATFORM_META[platform];
  if (!meta) throw new Error(`不支持的平台：${platform}`);
  const { getAdapter } = await import('./collector.mjs');
  const adapter = getAdapter(platform);
  if (!adapter) throw new Error(`不支持的平台：${platform}`);

  const report = (patch) => onProgress && onProgress(patch);
  const seen = new Map();
  const absorb = (items) => {
    if (!items) return 0;
    let added = 0;
    for (const item of items) {
      if (!item?.platform_id) continue;
      if (seen.has(item.platform_id)) {
        const prev = seen.get(item.platform_id);
        for (const [k, v] of Object.entries(item)) {
          if (v && !prev[k]) prev[k] = v;
        }
        continue;
      }
      seen.set(item.platform_id, item);
      added += 1;
    }
    if (added && onCopies) onCopies([...seen.values()].slice(-added));
    return added;
  };

  const session = await createSession();

  try {
    report({ status: 'running', message: `打开 ${meta.label} 搜索页` });
    await session.navigate(meta.searchUrl(keyword), 35000);
    await jitter(cautious ? 2600 : 1200, cautious ? 4800 : 2200);

    // 登录墙 / 验证检测（与视频采集同规则）
    // 先查风控中间页：抖音连续访问会跳「验证码中间页」，body 只有几个字节
    const riskProbe = await session.evaluate(
      `JSON.stringify({
        title: document.title || '',
        bodyLen: (document.body && document.body.innerText || '').length,
        cards: document.querySelectorAll('[class*=search-result], .search-result-card, li').length,
        url: location.href
      })`
    ).catch(() => '');
    let riskPage = null;
    try {
      const rp = JSON.parse(riskProbe || '{}');
      if (/验证码|安全验证|访问过于频繁|请稍后再试/.test(rp.title) || rp.bodyLen < 60) {
        riskPage = rp;
      }
    } catch {
      /* ignore */
    }
    if (riskPage) {
      const pageUrl = await session.evaluate('location.href').catch(() => '');
      if (onCaptcha) await onCaptcha({ reason: riskPage.title || '验证码页', platform, url: pageUrl }).catch(() => {});
      report({
        status: 'need_human',
        message: `${meta.label} 触发风控（${riskPage.title || '页面异常'}）：验证窗口已自动弹出，完成验证后点「继续」`,
      });
      return {
        copies: [...seen.values()],
        needHuman: true,
        message: `${meta.label} 触发风控：验证页面已显示在「内置浏览器」里，完成验证后点「继续」`,
      };
    }

    const block = await detectBlock(session, meta);
    let logged;
    if (checkLogin) {
      try { logged = !!(await checkLogin())?.[platform]; } catch { logged = await adapter.isLoggedIn(session); }
    } else {
      logged = await adapter.isLoggedIn(session);
    }
    if ((block.loginWall || (!logged && platform !== 'bilibili'))) {
      report({ status: 'need_human', message: `${meta.label} 需要登录：请到「内置浏览器」扫码登录后点「继续」` });
      return { copies: [...seen.values()], needHuman: true };
    }
    if (block.verifyWall || block.captchaDom) {
      const pageUrl = await session.evaluate('location.href').catch(() => '');
      if (onCaptcha) await onCaptcha({ reason: '验证码弹窗', platform, url: pageUrl }).catch(() => {});
      report({ status: 'need_human', message: `${meta.label} 出现验证码：验证页面已显示在「内置浏览器」里，完成后点「继续」` });
      return {
        copies: [...seen.values()],
        needHuman: true,
        message: `${meta.label} 出现验证码：验证页面已显示在「内置浏览器」里，完成验证后点「继续」`,
      };
    }

    report({ status: 'running', message: '滚动采集中' });

    // 搜索页：拦 XHR + DOM 双通道（与视频采集同一套）
    const bodies = new Map();
    session.onEvent((msg) => {
      if (msg.method === 'Network.responseReceived') {
        const { requestId, response } = msg.params || {};
        if (!requestId || !response || !/json/i.test(response.mimeType || '')) return;
        const u = response.url || '';
        if (adapter.matchResponse?.(u) || adapter.matchList?.(u)) bodies.set(requestId, u);
      }
      if (msg.method === 'Network.loadingFinished') {
        const rid = msg.params?.requestId;
        if (!bodies.has(rid)) return;
        bodies.delete(rid);
        session
          .send('Network.getResponseBody', { requestId: rid })
          .then((res) => {
            if (!res?.body) return;
            const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
            const items = adapter.parseBody ? adapter.parseBody(text, keyword) : [];
            absorb(items);
            report({ found: seen.size });
          })
          .catch(() => {});
      }
    });

    await autoScroll(session, {
      rounds: 30,
      idleStop: 4,
      stopAt: (n) => n >= target,
      onRound: async () => {
        if (signal?.aborted) throw new Error('已取消');
        const fromDom = await adapter.collect(session, keyword);
        absorb(fromDom);
        report({ found: seen.size });
        return seen.size;
      },
    });

    // 详情补全：搜索页拿不到正文的平台（B站/小红书）逐条进详情拿完整文案
    const needDetail = [...seen.values()].filter((c) => !c.content && c.page_url).slice(0, Math.min(target, 30));
    if (needDetail.length) {
      report({ message: `补全 ${needDetail.length} 条正文` });
      for (const copy of needDetail) {
        if (signal?.aborted) break;
        try {
          if (adapter.detail) {
            const d = await adapter.detail(session, { ...copy, page_url: copy.page_url });
            if (d) {
              copy.content = d.desc || copy.title || '';
              if (d.likes) copy.likes = d.likes;
              if (d.collects) copy.collects = d.collects;
              if (d.duration) copy.duration = d.duration;
              if (d.published) copy.published = d.published;
              if (d.music) copy.music = d.music;
            }
          } else if (platform === 'xhs') {
            const { collectOne } = await import('./detail.mjs');
            const d = await collectOne({ tab: session, adapter, item: { ...copy, page_url: copy.page_url }, signal });
            if (d?.desc) copy.content = d.desc;
            if (d?.duration) copy.duration = d.duration;
          }
          if (onCopies) onCopies([copy]);
        } catch {
          /* 单条失败继续 */
        }
        await jitter(cautious ? 1800 : 800, cautious ? 3500 : 1600);
        report({ found: seen.size });
      }
    }

    // 评论文案一体：进详情页逐条采评论
    if (withComments) {
      const targets = [...seen.values()].slice(0, Math.min(target, 20));
      if (targets.length) {
        report({ message: `采 ${targets.length} 条的评论` });
        for (const copy of targets) {
          if (signal?.aborted) break;
          try {
            const comments = await collectComments({
              session,
              platform,
              targetId: copy.platform_id,
              pageUrl: copy.page_url,
              keyword,
              maxScrolls: 12,
              limit: commentTarget,
              signal,
              onProgress: ({ found, error }) => report({ message: `评 ${copy.platform_id}：${found} 条${error ? '（' + error.slice(0, 40) + '）' : ''}` }),
            });
            if (comments.length && onComments) onComments(comments);
          } catch {
            /* 单条失败不影响整体 */
          }
          await jitter(cautious ? 2000 : 900, cautious ? 4000 : 1800);
          report({ found: seen.size });
        }
      }
    }

    // 一条都没采到：再查一次是不是被风控/登录墙拦了，给出明确原因
    if (seen.size === 0) {
      const again = await session.evaluate(
        `JSON.stringify({
          title: document.title || '',
          bodyLen: (document.body && document.body.innerText || '').length,
          url: location.href
        })`
      ).catch(() => '');
      let why = '';
      try {
        const a = JSON.parse(again || '{}');
        if (/验证码|安全验证|频繁/.test(a.title) || a.bodyLen < 60) {
          why = `${meta.label} 触发风控（${a.title || '页面无内容'}），请到「内置浏览器」手动过验证后点「继续」`;
        } else {
          why = `${meta.label} 没有采到结果（可能关键词无匹配，或被风控限制）`;
        }
      } catch {
        why = `${meta.label} 没有采到结果`;
      }
      report({ status: 'need_human', message: why });
      return { copies: [...seen.values()], needHuman: true };
    }

    report({ status: 'done', message: `完成，文案 ${seen.size} 条` });
    return { copies: [...seen.values()], needHuman: false };
  } finally {
    await session.closeTab().catch(() => {});
  }
}
