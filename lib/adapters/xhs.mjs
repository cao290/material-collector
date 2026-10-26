/**
 * 小红书适配器
 *
 * 实测结论（2026-10-25）：
 * - 未登录访问 search_result 直接要求登录，结果为空
 * - 登录后搜索走 /api/sns/web/v1/search/notes，返回 items[].note_card + id(note_id) + xsec_token
 * - 视频直链在 /api/sns/web/v1/feed（详情）里：note.video.media.stream.h264[0].master_url
 *   或 note.video.consumer.origin_video_key
 * - 列表接口只给封面和标题，直链必须进详情，因此采集分两段：列表 + 补详情
 */
import { Adapter, absUrl, toNumber } from './base.mjs';

const LIST_RE = /\/api\/sns\/web\/v1\/search\/notes|\/api\/sns\/web\/v1\/search\/notes\/groups/;
const FEED_RE = /\/api\/sns\/web\/v1\/feed/;

/** 小红书 master_url 本身无水印；h264 优先（兼容性好），h265/av1 备用 */
function pickVideoCandidates(note) {
  const v = note?.video || {};
  const stream = v.media?.stream || {};
  const list = [
    ...(stream.h264 || []).map((x) => x.master_url),
    ...(stream.h265 || []).map((x) => x.master_url),
    ...(stream.av1 || []).map((x) => x.master_url),
    v.consumer?.origin_video_key,
    ...(stream.h264?.[0]?.backup_urls || []),
  ].filter(Boolean);
  return list.map((u) => absUrl(u, 'https://www.xiaohongshu.com'));
}

function pickVideoUrl(note) {
  return pickVideoCandidates(note)[0] || '';
}

function normalizeFromList(item, keyword) {
  const note = item.note_card || item.noteCard || item;
  const id = item.id || note.note_id || note.noteId;
  if (!id) return null;
  const interact = note.interact_info || note.interactInfo || {};
  const cover = note.cover?.url || note.cover?.url_default || '';
  const tagList = note.tag_list || note.tagList || [];
  return {
    platform: 'xhs',
    platform_id: String(id),
    keyword,
    title: (note.display_title || note.displayTitle || note.title || '').slice(0, 200),
    desc: note.desc || '',
    tags: tagList.map((t) => t.name).filter(Boolean).join(','),
    author: note.user?.nickname || note.user?.nick_name || '',
    author_id: note.user?.user_id || note.user?.userId || '',
    cover: absUrl(cover, 'https://www.xiaohongshu.com'),
    video_url: pickVideoCandidates(note)[0] || '',
    video_backups: pickVideoCandidates(note).slice(1),
    duration: 0,
    likes: toNumber(interact.liked_count || interact.likedCount),
    collects: toNumber(interact.collected_count || interact.collectedCount),
    comments: toNumber(interact.comment_count || interact.commentCount),
    page_url: `https://www.xiaohongshu.com/explore/${id}` +
      (item.xsec_token ? `?xsec_token=${encodeURIComponent(item.xsec_token)}&xsec_source=pc_search` : ''),
    music: '',
    extra: JSON.stringify({ xsec_token: item.xsec_token || '', source: 'list' }),
  };
}

export class XhsAdapter extends Adapter {
  matchList(url) {
    return LIST_RE.test(url);
  }

  matchFeed(url) {
    return FEED_RE.test(url);
  }

  parseList(text, keyword) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const items = json.data?.items || json.items || [];
    if (!Array.isArray(items)) return [];
    return items.map((it) => normalizeFromList(it, keyword)).filter(Boolean);
  }

  /** 详情响应里补直链 */
  parseFeed(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const items = json.data?.items || json.items || [];
    if (!Array.isArray(items) || !items.length) return null;
    const note = items[0].note_card || items[0].noteCard || items[0];
    const id = items[0].id || note.note_id || note.noteId;
    if (!id) return null;
    const videoUrl = pickVideoCandidates(note)[0] || '';
    const tags = note.tag_list || note.tagList || [];
    return {
      platform_id: String(id),
      video_url: videoUrl,
      duration: Number(note.video?.capa?.duration || 0),
      desc: note.desc || '',
      tags: tags.map((t) => t.name).filter(Boolean).join(','),
      music: note.video?.consumer?.origin_video_key ? '' : '',
    };
  }

  /** DOM 兜底 */
  async collect(page, keyword) {
    const raw = await page.evaluate(
      String.raw`
      (() => {
        const out = [];
        const seen = new Set();
        const anchors = [...document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]')];
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/(?:explore|search_result)\/([0-9a-f]{20,})/i);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          const card = a.closest('section, [class*=note-item], [class*=card]') || a;
          const img = card.querySelector('img');
          const titleEl = card.querySelector('[class*=title], .footer');
          out.push({
            id: m[1],
            href,
            title: (titleEl && titleEl.textContent || img && img.getAttribute('alt') || '').trim().slice(0, 120),
            cover: img ? (img.getAttribute('src') || '') : '',
            author: (card.querySelector('[class*=author], [class*=name]')?.textContent || '').trim(),
            raw: (card.innerText || '').replace(/\n/g, ' | ').slice(0, 300),
          });
          if (out.length >= 200) break;
        }
        return JSON.stringify(out);
      })()
    `
    );
    let cards = [];
    try {
      cards = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
    return cards.map((c) => {
      const num = (c.raw.match(/([\d.]+)\s*(万|w)?\s*赞?/) || [])[0] || '';
      return {
        platform: 'xhs',
        platform_id: c.id,
        keyword,
        title: c.title,
        desc: '',
        author: c.author,
        cover: absUrl(c.cover, 'https://www.xiaohongshu.com'),
        video_url: '',
        likes: toNumber(num),
        page_url: absUrl(c.href, 'https://www.xiaohongshu.com'),
        extra: JSON.stringify({ source: 'dom', raw: c.raw }),
      };
    });
  }
}
