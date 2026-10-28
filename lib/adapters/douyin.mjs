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

/** 组无水印候选链
 * 实测（2026-10-27）：web 端 play_addr.url_list 已经不带 /playwm/，
 * 且 bit_rate 里 normal_1080_0 那条直连 CDN 下载回来画面干净无水印。
 * 所以按「码率最高 → 其余候选 → 播放接口 → 原地址」排。 */
export function douyinNoWmCandidates(video) {
  const out = [];
  const playAddr = video?.play_addr || {};
  const urlList = playAddr.url_list || [];

  // 1. bit_rate 里码率最高的直链（实测 1080P 无水印，最优先）
  const rates = (video?.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  for (const br of rates) {
    for (const u of br.play_addr?.url_list || []) out.push(String(u).replace('/playwm/', '/play/'));
  }

  // 2. play_addr 主地址（现在本身无水印，去掉历史遗留的 playwm）
  for (const u of urlList) out.push(String(u).replace('/playwm/', '/play/'));

  // 3. v1/play 播放接口兜底（302 到无水印 CDN，需登录 cookie）
  let uri = playAddr.uri || '';
  if (!uri) {
    const m = String(urlList[0] || '').match(/video_id=([\w-]+)/);
    if (m) uri = m[1];
  }
  if (uri) out.push(`https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`);

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
    // 详情接口返回的是 aweme_detail（单个对象），搜索接口才是 aweme_list（数组）。
    // 2026-10-27 实测：抖音搜索页已改 SSR，搜索接口根本不发请求，
    // 唯一可靠拿 play_addr 的路径就是详情接口 → 必须认 aweme_detail。
    const single = json.aweme_detail || (Array.isArray(json.aweme_details) ? json.aweme_details[0] : null);
    if (single) {
      const one = normalize(single, keyword);
      return one ? [one] : [];
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

  /**
   * 取无水印直链（2026-10-27 实测通过）
   *
   * 优先在「当前页上下文」里直接 fetch aweme/detail，不导航去详情页。
   * 原因：详情页风控比列表页严得多，导航过去常常落到「视频数据加载中」的空壳页
   * （aweme/detail 被拦、video 标签也没有）；而在列表页里发同样的请求，
   * 页面带着完整的 cookie 与指纹，接口能正常返回 play_addr。
   *
   * 拿到的 bit_rate[].play_addr 直连 CDN 下载回来画面干净无水印（1080P 实测）。
   * 注意不要用 download_addr —— 那条是带烧录水印的。
   */
  async detail(page, item) {
    const id = String(item.platform_id || '').match(/\d{15,25}/)?.[0];
    if (!id) return null;

    const apiUrl =
      'https://www.douyin.com/aweme/v1/web/aweme/detail/' +
      `?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${id}` +
      '&request_source=600&origin_source=600&update_version_code=170400' +
      '&pc_client_type=1&version_code=290100&version_name=29.1.0' +
      '&cookie_enabled=true&platform=PC&pc_libra_divert=Windows';

    // ① 当前页上下文直调接口（最可靠）
    const body = await page
      .evaluate(
        `(async () => {
          try {
            const r = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include', headers: { accept: 'application/json' } });
            const t = await r.text();
            return t.length > 80 ? t : '';
          } catch (e) { return ''; }
        })()`
      )
      .catch(() => '');
    if (body) {
      const list = this.parseBody(body, item.keyword || '');
      if (list.length && list[0].video_url) return list[0];
    }

    // ② 回退：导航到详情页，拦 aweme/detail 响应
    const cur = await page.evaluate('location.href').catch(() => '');
    if (!cur.includes(`/video/${id}`)) {
      const bodyPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, 15000);
        const off = page.onEvent((msg) => {
          if (msg.method !== 'Network.responseReceived') return;
          const { requestId, response } = msg.params || {};
          if (!this.detailMatch(response?.url || '')) return;
          page
            .send('Network.getResponseBody', { requestId })
            .then((res) => {
              if (!res?.body) return;
              clearTimeout(timer);
              off();
              resolve(res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body);
            })
            .catch(() => {});
        });
      });
      await page.navigate(`https://www.douyin.com/video/${id}`, 25000);
      const navBody = await bodyPromise;
      if (navBody) {
        const list = this.parseBody(navBody, item.keyword || '');
        if (list.length && list[0].video_url) return list[0];
      }
    }

    // ③ 兜底：页面里 <video> 的 currentSrc（播放器真实在放的地址）
    const src = await page
      .evaluate(`(() => { const v = document.querySelector('video'); return v ? (v.currentSrc || v.src || '') : ''; })()`)
      .catch(() => '');
    if (src && /^https?:/.test(src)) {
      return { ...item, video_url: src, video_backups: [], extra: JSON.stringify({ source: 'video-tag' }) };
    }
    return null;
  }
}
