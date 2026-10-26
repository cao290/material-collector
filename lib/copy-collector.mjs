/**
 * 文案 / 评论采集引擎
 *
 * 两种模式：
 * - search：按关键词打开搜索页，拦截搜索接口拿文案（标题/正文/标签/数据），不下载
 * - comments：进每条内容的详情页，自动滚动评论区，拦评论接口
 *
 * 全部走任务窗口（隐藏），签名由页面 JS 生成，我们只拦响应。
 */
import { autoScroll, jitter } from './adapters/base.mjs';
import fs from 'node:fs';

/* ---------- 各平台评论接口匹配与解析 ---------- */

const COMMENT_PARSERS = {
  douyin: {
    match: (url) => /\/aweme\/v1\/web\/comment\/list/.test(url),
    parse: (json, targetId, pageUrl, keyword, url) => {
      // /comment/list/reply/ 是二级评论接口，comment_id 参数即父评论
      const replyMatch = /comment\/list\/reply\/.*[?&]comment_id=(\d+)/.exec(url || '');
      const parentId = replyMatch ? replyMatch[1] : '';
      return (json.comments || []).map((c) => ({
        platform: 'douyin',
        target_id: targetId,
        comment_id: String(c.cid || ''),
        parent_id: parentId || (c.reply_id && c.reply_id !== '0' ? String(c.reply_id) : ''),
        author: c.user?.nickname || '',
        content: c.text || '',
        likes: Number(c.digg_count || 0),
        replies: Number(c.reply_comment_total || 0),
        location: c.ip_label || '',
        page_url: pageUrl,
        keyword,
      })).filter((c) => c.comment_id && c.content);
    },
    hasMore: (json) => !!json.has_more,
  },
  xhs: {
    match: (url) => /\/api\/sns\/web\/v2\/comment\/page/.test(url),
    parse: (json, targetId, pageUrl, keyword) => {
      const out = [];
      for (const c of json.data?.comments || []) {
        out.push({
          platform: 'xhs',
          target_id: targetId,
          comment_id: String(c.id || ''),
          parent_id: '',
          author: c.user_info?.nickname || '',
          content: c.content?.description || '',
          likes: Number(c.like_count || 0),
          replies: Number(c.sub_comment_count || 0),
          location: (c.ip_location || '').replace('IP属地：', ''),
          page_url: pageUrl,
          keyword,
        });
        for (const sc of c.sub_comments || []) {
          out.push({
            platform: 'xhs',
            target_id: targetId,
            comment_id: String(sc.id || ''),
            parent_id: String(c.id || ''),
            author: sc.user_info?.nickname || '',
            content: sc.content?.description || '',
            likes: Number(sc.like_count || 0),
            replies: 0,
            location: (sc.ip_location || '').replace('IP属地：', ''),
            page_url: pageUrl,
            keyword,
          });
        }
      }
      return out.filter((c) => c.comment_id && c.content);
    },
    hasMore: (json) => !!json.data?.has_more,
  },
  bilibili: {
    match: (url) => /\/x\/v2\/reply\/(main|wbi\/main)|\/x\/v2\/reply\/reload/.test(url),
    parse: (json, targetId, pageUrl, keyword) => {
      const list = json.data?.replies || json.data?.top_replies || [];
      return list.map((c) => ({
        platform: 'bilibili',
        target_id: targetId,
        comment_id: String(c.rpid || ''),
        parent_id: c.parent && c.parent !== 0 ? String(c.parent) : '',
        author: c.member?.uname || '',
        content: c.content?.message || '',
        likes: Number(c.like || 0),
        replies: Number(c.rcount || 0),
        location: (c.reply_control?.location || '').replace('IP属地：', ''),
        page_url: pageUrl,
        keyword,
      })).filter((c) => c.comment_id && c.content);
    },
    hasMore: (json) => {
      const cursor = json.data?.cursor;
      return cursor ? cursor.is_end === false : !!(json.data?.replies?.length);
    },
  },
  kuaishou: {
    match: (url) => /comment/i.test(url) && /graphql|rest/i.test(url),
    parse: (json, targetId, pageUrl, keyword, url) => {
      const root = json.data || json;
      const list =
        root.visionCommentList?.commentList ||
        root.commentList ||
        [];
      return list.map((c) => ({
        platform: 'kuaishou',
        target_id: targetId,
        comment_id: String(c.commentId || ''),
        parent_id: c.pcommentId ? String(c.pcommentId) : '',
        author: c.authorName || c.author?.name || '',
        content: c.text || '',
        likes: Number(c.likedCount || c.realLikedCount || 0),
        replies: Number(c.subCommentCount || 0),
        location: c.ipTag?.location || '',
        page_url: pageUrl,
        keyword,
      })).filter((c) => c.comment_id && c.content);
    },
    hasMore: (json) => {
      const root = json.data || json;
      return !!root.visionCommentList?.hasMore;
    },
  },
};

/**
 * 采集一条内容的评论区：进详情页 → 滚评论区 → 拦评论接口
 * @returns {Array} comments
 */
/** B站评论区在隐藏窗口里懒加载不触发；改在页面内算 wbi 签名直调评论接口 */
const BILI_WBI_SCRIPT = fs.readFileSync(new URL('../scripts/bili-comment-script.js', import.meta.url), 'utf8');


export async function collectComments({ session, platform, targetId, pageUrl, keyword, maxScrolls = 15, limit = 50, onProgress, signal }) {
  // B站：页面内 wbi 签名直调（懒加载在后台窗口不触发）
  if (platform === 'bilibili') {
    // 页面会有 zh-Hans 二次跳转，首次 evaluate 可能撞上 frame 重建，重试几次
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (attempt === 0) {
          await session.navigate(pageUrl, 30000).catch(() => {});
        }
        await jitter(1200, 2000);
        await session.evaluate(`window.__CMT_LIMIT = ${Number(limit) || 50};`).catch(() => {});
        // 等 __INITIAL_STATE__ 就绪（页面重定向 + 数据填充需要几秒）
        for (let i = 0; i < 12; i += 1) {
          try {
            const ready = await Promise.race([
              session.evaluate('(function(){ return !!(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData && window.__INITIAL_STATE__.videoData.aid); })()'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('t')), 3000)),
            ]);
            if (ready === true) break;
          } catch {
            /* frame 还在换，等下一轮 */
          }
          await new Promise((r) => setTimeout(r, 900));
        }
        const raw = await Promise.race([
          session.evaluate(BILI_WBI_SCRIPT),
          new Promise((_, reject) => setTimeout(() => reject(new Error('B站评论脚本超时')), 45000)),
        ]);
        const parsed = JSON.parse(raw || '{}');
        if (parsed.error) throw new Error('B站评论接口：' + parsed.error);
        const items = (parsed.comments || []).slice(0, limit).map((c) => ({ ...c, platform: 'bilibili', target_id: targetId, page_url: pageUrl, keyword }));
        onProgress?.({ found: items.length, limitReached: !!parsed.limitReached });
        return items;
      } catch (error) {
        lastError = error.message;
        onProgress?.({ found: 0, error: lastError });
        await jitter(1800, 2600);
      }
    }
    return [];
  }

  const parser = COMMENT_PARSERS[platform];
  if (!parser) return [];
  const wc = session;

  const collected = new Map();
  const absorb = (items) => {
    for (const c of items || []) {
      if (!c || !c.comment_id || collected.has(c.comment_id)) continue;
      if (collected.size >= limit) return true; // 上限
      collected.set(c.comment_id, c);
    }
    return collected.size >= limit;
  };

  const bodies = new Map();
  const off = wc.onEvent((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response } = msg.params || {};
      if (!requestId || !response) return;
      if (!/json/i.test(response.mimeType || '')) return;
      if (!parser.match(response.url || '')) return;
      bodies.set(requestId, response.url);
    }
    if (msg.method === 'Network.loadingFinished') {
      const rid = msg.params?.requestId;
      const u = bodies.get(rid);
      if (!u) return;
      bodies.delete(rid);
      wc.send('Network.getResponseBody', { requestId: rid })
        .then((res) => {
          if (!res?.body) return;
          const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          try {
            const full = JSON.parse(text);
            absorb(parser.parse(full, targetId, pageUrl, keyword, u));
            onProgress?.({ found: collected.size, limitReached: collected.size >= limit });
          } catch {
            /* 非 JSON 响应 */
          }
        })
        .catch(() => {});
    }
  });

  try {
    await wc.navigate(pageUrl, 30000);
    await jitter(1500, 2500);

    // 评论区是懒加载：滚到底触发；顺带点开「展开 N 条回复」把二级评论拉出来
    for (let i = 0; i < maxScrolls; i += 1) {
      if (signal?.aborted) break;
      if (collected.size >= limit) break;
      await wc.evaluate(`
        (() => {
          window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
          // 评论区容器单独滚（部分平台评论区在独立滚动容器里）
          const boxes = [...document.querySelectorAll('*')].filter((el) => {
            if (el.scrollHeight <= el.clientHeight + 100 || el.clientHeight < 200) return false;
            return /(auto|scroll)/.test(getComputedStyle(el).overflowY);
          });
          boxes.slice(0, 3).forEach((el) => { el.scrollTop = el.scrollHeight; });
          // 展开二级回复：抖音/小红书/快手的「展开 N 条回复」类按钮
          const btns = [...document.querySelectorAll('[class*=show-more], [class*=expand], [class*=more-btn], [class*=unfold], [class*=reply-expand]')];
          btns.forEach((b) => {
            if (b && b.getBoundingClientRect && b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().top < innerHeight) {
              try { b.click(); } catch {}
            }
          });
          // 文案匹配兜底（不同平台文案不同）
          [...document.querySelectorAll('span, div')].some((el) => {
            if (!el.childElementCount && /展开\s*\d*\s*条回复|查看全部.*回复|more.*repl/i.test(el.textContent || '') && el.getBoundingClientRect().top < innerHeight) {
              try { el.click(); return true; } catch {}
            }
            return false;
          });
          return 1;
        })()
      `);
      await jitter(1000, 1800);
      onProgress?.({ found: collected.size, scroll: i + 1 });
      // 连续几轮没有新增就停
      const before = collected.size;
      await jitter(600, 1200);
      if (collected.size >= limit) break;
      if (collected.size === before && i >= 3) break;
    }
  } finally {
    off();
  }
  return [...collected.values()];
}
