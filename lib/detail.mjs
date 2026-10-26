/**
 * 单条详情补全（抖音 / 小红书 / 快手）
 * 在已打开的标签页里导航到详情页，拦对应接口，DOM 兜底。
 */
export async function collectOne({ tab, adapter, item, signal }) {
  if (!item.page_url) return null;

  const waiter = new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, 12000);
    const off = tab.onEvent((msg) => {
      if (msg.method !== 'Network.responseReceived') return;
      const { requestId, response } = msg.params || {};
      const url = response?.url || '';
      const hit =
        (adapter.detailMatch && adapter.detailMatch(url)) ||
        (adapter.matchFeed && adapter.matchFeed(url));
      if (!hit) return;
      tab
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

  await tab.navigate(item.page_url, 20000);
  if (signal?.aborted) return null;
  const body = await waiter;

  const out = {
    video_url: '',
    video_backups: [],
    audio_url: '',
    audio_backups: [],
    author: '',
    likes: 0,
    duration: 0,
    desc: '',
    extra: '',
  };

  if (body) {
    if (adapter.parseBody) {
      const list = adapter.parseBody(body, item.keyword || '');
      const own = list.find((x) => x.platform_id === item.platform_id) || list[0];
      if (own) {
        if (own.video_url) out.video_url = own.video_url;
        if (own.video_backups?.length) out.video_backups = own.video_backups;
        if (own.audio_url) out.audio_url = own.audio_url;
        if (own.author) out.author = own.author;
        if (own.likes) out.likes = own.likes;
        if (own.duration) out.duration = own.duration;
        if (own.desc) out.desc = own.desc;
        if (own.music) out.music = own.music;
        if (own.tags) out.tags = own.tags;
      }
    }
    if (adapter.parseFeed) {
      const d = adapter.parseFeed(body);
      if (d) {
        if (d.video_url) out.video_url = d.video_url;
        if (d.duration) out.duration = d.duration;
        if (d.desc) out.desc = d.desc;
        if (d.tags) out.tags = d.tags;
      }
    }
  }

  // DOM 兜底：<video> 标签 + og:video
  if (!out.video_url) {
    const src = await tab.evaluate(`
      (() => {
        const v = document.querySelector('video');
        let url = v ? (v.currentSrc || v.src || '') : '';
        if (!url) {
          const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
          if (og) url = og.getAttribute('content') || '';
        }
        const sources = [...document.querySelectorAll('video source')].map(s => s.src).filter(Boolean);
        if (!url && sources.length) url = sources[0];
        return url || '';
      })()
    `);
    if (src && /^https?:/.test(src)) out.video_url = src;
  }

  if (!out.video_url) return null;
  return out;
}
