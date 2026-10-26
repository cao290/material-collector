/**
 * 快手适配器
 *
 * 实测结论（2026-10-25）：
 * - 未登录访问 /search/video?searchKey=... 只给登录引导，无结果
 * - 登录后走 /graphql（operationName=visionSearchPhoto），
 *   返回 data.visionSearchPhoto.feeds[].photo：
 *     photoUrl / photoH265Url（无水印，通常带 clientCacheKey）
 *     coverUrl、caption、duration、likeCount、timestamp
 * - 也兼容旧版 /rest/wd/search/photo
 */
import { Adapter, absUrl, toNumber, pick } from './base.mjs';

const MATCH_RE = /\/graphql|\/rest\/wd\/search\/photo|\/rest\/n\/web\/search\/photo/;

function normalize(photo, keyword) {
  if (!photo) return null;
  const id = photo.id || photo.photoId || '';
  if (!id) return null;
  const tags = (photo.ext_params || []).map((t) => t.hashtagName).filter(Boolean).join(',');
  // 快手 web 端 photoUrl 本身无水印；h265 与 manifest 作为备用源
  const candidates = [
    photo.photoUrl,
    photo.photoH265Url,
    photo.manifest?.adaptationSet?.[0]?.representation?.[0]?.url,
  ].filter(Boolean).map((u) => absUrl(u, 'https://www.kuaishou.com'));
  return {
    platform: 'kuaishou',
    platform_id: String(id),
    keyword,
    title: (photo.caption || '').slice(0, 200),
    desc: photo.caption || '',
    tags,
    author: pick(photo, 'userName', 'user.userName', 'author.name') || '',
    author_id: pick(photo, 'userId', 'user.id') || '',
    cover: absUrl(pick(photo, 'coverUrl', 'coverUrls.0.url', 'webpCoverUrl'), 'https://www.kuaishou.com'),
    video_url: candidates[0] || '',
    video_backups: candidates.slice(1),
    duration: Math.round(Number(photo.duration || 0) / 1000) || 0,
    likes: toNumber(pick(photo, 'likeCount', 'realLikeCount', 'likedCount')),
    comments: toNumber(pick(photo, 'commentCount', 'commentsCount')),
    shares: toNumber(pick(photo, 'shareCount', 'forwardCount')),
    collects: toNumber(pick(photo, 'collectCount', 'saveCount')),
    published: photo.timestamp ? new Date(Number(photo.timestamp)).toISOString().slice(0, 10) : '',
    page_url: `https://www.kuaishou.com/short-video/${id}`,
    music: pick(photo, 'musicName', 'soundTrack.name') || '',
    extra: JSON.stringify({ watermarkFree: true, candidates: candidates.length }),
  };
}

export class KuaishouAdapter extends Adapter {
  matchResponse(url) {
    return MATCH_RE.test(url);
  }

  parseBody(text, keyword) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const root = json.data || json;
    const feeds =
      root.visionSearchPhoto?.feeds ||
      root.visionSearchPhoto?.list ||
      root.feeds ||
      root.list ||
      root.pcSearchPhoto?.feeds ||
      [];
    if (!Array.isArray(feeds)) return [];
    return feeds
      .map((f) => normalize(f.photo || f, keyword))
      .filter(Boolean);
  }

  /** DOM 兜底：搜索结果卡片 */
  async collect(page, keyword) {
    const raw = await page.evaluate(
      String.raw`
      (() => {
        const out = [];
        const seen = new Set();
        const anchors = [...document.querySelectorAll('a[href*="/short-video/"]')];
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/short-video\/([0-9A-Za-z_-]+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          const card = a.closest('div[class*=card], li, [class*=item]') || a;
          const img = card.querySelector('img');
          const text = (card.innerText || '').replace(/\n/g, ' | ');
          out.push({
            id: m[1],
            href,
            title: (img && img.getAttribute('alt')) || text.split('|')[0] || '',
            cover: img ? (img.getAttribute('src') || '') : '',
            author: (card.querySelector('[class*=name], [class*=user]')?.textContent || '').trim(),
            duration: (card.querySelector('[class*=duration]')?.textContent || '').trim(),
            raw: text.slice(0, 300),
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
      const num = (c.raw.match(/([\d.]+)\s*(万|w)?\s*[赞❤]/) || [])[0] || '';
      const secs = c.duration
        ? c.duration.split(':').reduce((acc, v) => acc * 60 + (Number(v) || 0), 0)
        : 0;
      return {
        platform: 'kuaishou',
        platform_id: c.id,
        keyword,
        title: c.title,
        desc: '',
        author: c.author,
        cover: absUrl(c.cover, 'https://www.kuaishou.com'),
        video_url: '',
        duration: secs,
        likes: toNumber(num),
        page_url: absUrl(c.href, 'https://www.kuaishou.com'),
        extra: JSON.stringify({ source: 'dom', raw: c.raw }),
      };
    });
  }
}
