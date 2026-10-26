/**
 * 抖音适配器
 *
 * 实测结论（2026-10-25）：
 * - 未登录访问 /search/{kw}?type=video 直接弹扫码登录，搜索结果为空
 * - 登录后搜索接口走 /aweme/v1/web/general/search/single/（也可能 search/item），
 *   返回 aweme_list，每条含 video.play_addr.url_list
 * - 签名 a_bogus/msToken 由页面 JS 生成，我们只负责拦响应，不发请求
 *
 * 去水印（2026-10-25 实现）：
 * - web 端 play_addr 的 url_list 是「带水印或播放页同源」，直接下会带水印
 * - 无水印候选链（按优先级）：
 *   1. https://www.douyin.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0
 *      （web 播放接口，302 到无水印 CDN，登录 cookie 必带）
 *   2. play_addr.url_list 里把 /playwm/ 替换成 /play/（老牌去水印替换）
 *   3. video.bit_rate[] 里码率最高的 play_addr（同样做 /playwm/→/play/）
 *   4. 原始 url_list 兜底（可能带水印）
 */
import { Adapter, absUrl, toNumber } from './base.mjs';

const MATCH_RE = /\/aweme\/v1\/web\/general\/search\/single|\/aweme\/v1\/web\/search\/item|\/aweme\/v1\/web\/search\/single/;

/** 组无水印候选链 */
export function douyinNoWmCandidates(video) {
  const out = [];
  const playAddr = video?.play_addr || {};
  const urlList = playAddr.url_list || [];

  // 1. v1/play 接口（video_id 就是 play_addr.uri）
  let uri = playAddr.uri || '';
  if (!uri) {
    const m = String(urlList[0] || '').match(/video_id=([\w-]+)/);
    if (m) uri = m[1];
  }
  if (uri) out.push(`https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`);

  // 2. playwm → play 替换
  for (const u of urlList) out.push(String(u).replace('/playwm/', '/play/'));

  // 3. bit_rate 里码率最高的（同样替换）
  const rates = (video?.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  for (const br of rates) {
    for (const u of br.play_addr?.url_list || []) out.push(String(u).replace('/playwm/', '/play/'));
  }

  // 4. 原始地址兜底（可能带水印）
  for (const u of urlList) out.push(u);

  return [...new Set(out.map((u) => absUrl(u, 'https://www.douyin.com')))].filter(Boolean);
}

function normalize(aweme, keyword) {
  if (!aweme || (!aweme.aweme_id && !aweme.awemeId)) return null;
  const id = aweme.aweme_id || aweme.awemeId;
  const video = aweme.video || {};
  const coverList = video.cover?.url_list || video.origin_cover?.url_list || [];
  const music = aweme.music || {};
  const tags =
    (aweme.text_extra || [])
      .map((t) => t.hashtag_name)
      .filter(Boolean)
      .join(',') || '';
  const candidates = douyinNoWmCandidates(video);
  return {
    platform: 'douyin',
    platform_id: String(id),
    keyword,
    title: (aweme.desc || '').slice(0, 200),
    desc: aweme.desc || '',
    tags,
    author: aweme.author?.nickname || '',
    author_id: aweme.author?.uid || '',
    cover: absUrl(coverList[0], 'https://www.douyin.com'),
    video_url: candidates[0] || '',
    video_backups: candidates.slice(1),
    audio_url: '',
    duration: Number(video.duration || 0) / (video.duration > 1000 ? 1000 : 1),
    likes: toNumber(aweme.statistics?.digg_count),
    comments: toNumber(aweme.statistics?.comment_count),
    shares: toNumber(aweme.statistics?.share_count),
    collects: toNumber(aweme.statistics?.collect_count),
    published: aweme.create_time ? new Date(aweme.create_time * 1000).toISOString().slice(0, 10) : '',
    page_url: `https://www.douyin.com/video/${id}`,
    music: music.title || '',
    extra: JSON.stringify({
      watermarkFree: candidates.length > 1,
      candidates: candidates.length,
      width: video.width,
      height: video.height,
    }),
  };
}

export class DouyinAdapter extends Adapter {
  matchResponse(url) {
    return MATCH_RE.test(url);
  }

  /** 从拦到的 JSON 里解析条目 */
  parseBody(text, keyword) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const list = json.aweme_list || json.data?.aweme_list || json.data || [];
    if (!Array.isArray(list)) return [];
    return list.map((a) => normalize(a, keyword)).filter(Boolean);
  }

  /**
   * DOM 兜底解析（实测结构 2026-10-26）：
   * .search-result-card 内的文本形如：
   *   "01:50|97|见过很多城市的夜景… #城市夜景|@许 哥|2月前"
   * 即：时长|点赞|标题(含话题)|@作者|发布时间
   * 链接：//www.douyin.com/video/<id>
   */
  async collect(page, keyword) {
    const raw = await page.evaluate(
      String.raw`
      (function () {
        var cards = document.querySelectorAll('.search-result-card');
        var out = [];
        for (var i = 0; i < cards.length && out.length < 200; i++) {
          var card = cards[i];
          var a = card.querySelector('a[href*="/video/"]');
          if (!a) continue;
          var href = a.getAttribute('href') || '';
          var m = href.match(/\/video\/(\d+)/);
          if (!m) continue;
          var img = card.querySelector('img');
          out.push({
            id: m[1],
            text: (card.innerText || '').split('\n').join('|'),
            alt: img ? (img.getAttribute('alt') || '') : '',
            cover: img ? (img.getAttribute('src') || '') : ''
          });
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
      // 文本用 | 分隔，字段顺序不固定（「合集」卡片会多一个前导字段），按特征逐个识别
      const parts = String(c.text || '').split('|').map((x) => x.trim()).filter(Boolean);
      let duration = 0;
      let likes = 0;
      let author = '';
      let published = '';
      const titleParts = [];

      for (const part of parts) {
        // 时长 mm:ss
        if (/^\d{1,2}:\d{2}$/.test(part) && !duration) {
          const [mm, ss] = part.split(':').map(Number);
          duration = mm * 60 + ss;
          continue;
        }
        // 点赞：纯数字或 x.x万（必须紧跟时长之后才可信，这里用「尚未取到」保护）
        if (!likes && /^[\d.]+\s*万?$/.test(part) && duration) {
          likes = part.includes('万') ? Math.round(parseFloat(part) * 10000) : Number(part) || 0;
          continue;
        }
        // 作者 @xxx
        if (part.startsWith('@') && !author) {
          author = part.slice(1).trim();
          continue;
        }
        // 时间：2月前 / 3天前 / 昨天
        if (/^(\d+\s*(秒|分钟|小时|天|月|年)前|昨天|前天|今天)$/.test(part)) {
          published = part;
          continue;
        }
        // 「合集」「置顶」这类标记跳过
        if (/^(合集|置顶|广告|直播中)$/.test(part)) continue;
        titleParts.push(part);
      }

      const title = titleParts.join(' ').trim();
      const tags = (title.match(/#[^\s#]+/g) || []).join(',');
      return {
        platform: 'douyin',
        platform_id: c.id,
        keyword,
        title: title || c.alt || '',
        desc: title || '',
        tags,
        author,
        cover: absUrl(c.cover, 'https://www.douyin.com'),
        video_url: '', // 直链必须进详情页取
        duration,
        likes,
        published,
        page_url: `https://www.douyin.com/video/${c.id}`,
        extra: JSON.stringify({ source: 'dom', raw: String(c.text || '').slice(0, 300) }),
      };
    });
  }

  /**
   * 抖音风控中间页识别：连续访问详情页会跳到「验证码中间页」，
   * 此时页面 body 只有几个字、没有 video 标签。
   */
  async detectRiskPage(page) {
    const info = await page.evaluate(
      String.raw`JSON.stringify({
        title: document.title || '',
        bodyLen: (document.body && document.body.innerText || '').length,
        videoCount: document.querySelectorAll('video').length,
        url: location.href
      })`
    );
    try {
      const d = JSON.parse(info);
      const risk =
        /验证码|安全验证|访问过于频繁|请稍后再试/.test(d.title) ||
        (d.bodyLen < 60 && d.videoCount === 0 && /douyin\.com\/video/.test(d.url));
      return { risk, ...d };
    } catch {
      return { risk: false };
    }
  }

  /** 补详情：进入视频页，拦 aweme/detail 拿 play_addr */
  detailMatch(url) {
    return /\/aweme\/v1\/web\/aweme\/detail|\/aweme\/v1\/web\/aweme\/post/.test(url);
  }
}
