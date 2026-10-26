/**
 * B站适配器
 *
 * 实测结论（2026-10-25）：
 * - 搜索页 SSR + 客户端接管，DOM 卡片一定存在（42 张/页），XHR 不一定触发
 * - 卡片：.bili-video-card，链接 //www.bilibili.com/zh-Hans/video/BVxxx
 * - 作者：.bili-video-card__info--author；日期：.bili-video-card__info--date（"· 2021年10月20日"）
 * - 时长：.bili-video-card__stats__duration（03:34）；统计：播放/弹幕，不是点赞
 * - 详情页 window.__playinfo__ 里带 DASH 直链（video + audio 分离），
 *   window.__INITIAL_STATE__ 带标题/作者/点赞/简介/发布时间/分区
 * - yt-dlp 对本站报 "Unable to extract initial state"，因此不用它，改自己拼 DASH
 * - 未登录最高 480p；登录后可到 1080p 以上
 */
import { Adapter, absUrl, toNumber, toSeconds } from './base.mjs';

const CARD_SCRIPT = String.raw`
(() => {
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const out = [];
  for (const card of cards) {
    const link = card.querySelector('a[href*="/video/BV"]');
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const m = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!m) continue;
    const img = card.querySelector('img');
    const titleEl = card.querySelector('.bili-video-card__info--tit');
    const upEl = card.querySelector('.bili-video-card__info--author');
    const dateEl = card.querySelector('.bili-video-card__info--date');
    const durEl = card.querySelector('.bili-video-card__stats__duration');
    const stats = [...card.querySelectorAll('.bili-video-card__stats--item')].map(el => (el.textContent || '').trim());
    out.push({
      bvid: m[1],
      href,
      title: (titleEl && titleEl.getAttribute('title')) || (titleEl && titleEl.textContent) || (img && img.getAttribute('alt')) || '',
      author: upEl ? upEl.textContent.trim() : '',
      date: dateEl ? dateEl.textContent.replace(/^[·\s]+/, '').trim() : '',
      duration: durEl ? durEl.textContent.trim() : '',
      cover: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '',
      stats,
    });
  }
  return JSON.stringify(out);
})()
`;

/** 详情页取全量信息 + 直链 */
const DETAIL_SCRIPT = String.raw`
(() => {
  const info = (window.__playinfo__ && (window.__playinfo__.data || window.__playinfo__.result)) || {};
  const init = window.__INITIAL_STATE__ || {};
  const vd = init.videoData || init.videoInfo || {};
  const pages = vd.pages || [];
  const dash = info.dash || {};
  const pickVideo = () => {
    const list = dash.video || [];
    if (!list.length) return null;
    // 优先 avc1（兼容性最好），同编码取分辨率最高
    const avc = list.filter(v => /avc1/.test(v.codecs || ''));
    const pool = avc.length ? avc : list;
    return pool.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  };
  const pickAudio = () => {
    const list = dash.audio || [];
    if (!list.length) return null;
    return list.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  };
  const v = pickVideo();
  const a = pickAudio();
  const durl = (info.durl || [])[0] || null;
  return JSON.stringify({
    ok: !!(v || durl),
    cid: info.cid || (pages[0] && pages[0].cid) || null,
    bvid: info.bvid || vd.bvid || '',
    quality: info.quality,
    acceptDescription: info.accept_description || [],
    title: vd.title || '',
    author: (vd.owner && vd.owner.name) || '',
    authorId: (vd.owner && vd.owner.mid) || '',
    cover: vd.pic || '',
    desc: vd.desc || '',
    tname: vd.tname || '',
    pubdate: vd.pubdate || 0,
    duration: (vd.duration && vd.duration + '') || (info.timelength ? String(Math.round(info.timelength / 1000)) : ''),
    stat: {
      view: (vd.stat && vd.stat.view) || 0,
      like: (vd.stat && vd.stat.like) || 0,
      danmaku: (vd.stat && vd.stat.danmaku) || 0,
      coin: (vd.stat && vd.stat.coin) || 0,
      favorite: (vd.stat && vd.stat.favorite) || 0,
      share: (vd.stat && vd.stat.share) || 0,
      reply: (vd.stat && vd.stat.reply) || 0,
    },
    bgm: (vd.pages && vd.pages[0] && vd.pages[0].part) ? '' : '',
    videoUrl: v ? (v.baseUrl || v.base_url || '') : '',
    videoBackups: v ? (v.backupUrl || v.backup_url || []) : [],
    audioUrl: a ? (a.baseUrl || a.base_url || '') : '',
    audioBackups: a ? (a.backupUrl || a.backup_url || []) : [],
    height: v ? v.height : 0,
    codecs: v ? v.codecs : '',
    durlUrl: durl ? durl.url : '',
  });
})()
`;

export class BilibiliAdapter extends Adapter {
  async collect(page, keyword) {
    const raw = await page.evaluate(CARD_SCRIPT);
    let cards = [];
    try {
      cards = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
    return cards
      .filter((c) => c.bvid)
      .map((card) => {
        const views = toNumber(card.stats[0] || '');
        const danmaku = toNumber(card.stats[1] || '');
        return {
          platform: 'bilibili',
          platform_id: card.bvid,
          keyword,
          title: card.title,
          desc: '',
          tags: '',
          author: card.author,
          author_id: '',
          cover: absUrl(card.cover, 'https://www.bilibili.com'),
          video_url: '', // 详情页补
          audio_url: '',
          duration: toSeconds(card.duration),
          likes: 0,
          comments: danmaku,
          page_url: `https://www.bilibili.com/video/${card.bvid}`,
          published: card.date,
          music: '',
          extra: JSON.stringify({ views, danmaku }),
        };
      });
  }

  /** 详情页：进页面读 __playinfo__ 和 __INITIAL_STATE__ */
  async detail(page, item) {
    const bvid = item.platform_id;
    if (!bvid) return null;
    await page.navigate(`https://www.bilibili.com/video/${bvid}`, 25000);
    // 等 __playinfo__ 就绪
    for (let i = 0; i < 12; i += 1) {
      const ready = await page.evaluate(`!!(window.__playinfo__ && window.__INITIAL_STATE__)`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    const raw = await page.evaluate(DETAIL_SCRIPT);
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!d || (!d.videoUrl && !d.durlUrl)) return null;

    // 视频直链和音频直链必须带 Referer+UA，下载器会处理
    return {
      title: d.title || item.title,
      author: d.author || item.author,
      author_id: d.authorId || '',
      cover: d.cover || item.cover,
      desc: d.desc || '',
      duration: Number(d.duration) || item.duration,
      likes: d.stat?.like || 0,
      comments: d.stat?.reply || 0,
      shares: d.stat?.share || 0,
      collects: d.stat?.favorite || 0,
      published: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : item.published,
      video_url: d.videoUrl || d.durlUrl,
      video_backups: d.videoBackups || [],
      audio_url: d.audioUrl || '',
      audio_backups: d.audioBackups || [],
      extra: JSON.stringify({
        height: d.height,
        codecs: d.codecs,
        quality: d.quality,
        tname: d.tname,
        views: d.stat?.view,
        danmaku: d.stat?.danmaku,
        coin: d.stat?.coin,
        accept: d.acceptDescription,
        cid: d.cid,
      }),
    };
  }

  async isLoggedIn(page) {
    const cookies = await page.getCookies(['https://www.bilibili.com']);
    return cookies.some((c) => c.name === 'SESSDATA');
  }
}
