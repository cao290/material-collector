/**
 * 平台探针 —— 实测四个平台的搜索接口，把真实响应原样存盘
 *
 * 用法：
 *   node scripts/probe.mjs bilibili 编程
 *   node scripts/probe.mjs douyin 城市夜景
 *   node scripts/probe.mjs xhs 露营
 *   node scripts/probe.mjs kuaishou 美食
 *
 * 产物：probe-out/<平台>_<关键词>_<时间>.json
 * 目的：确定真实字段路径，不做猜测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, CdpSession, cdpAlive } from '../lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe-out');
const PROFILE = path.join(ROOT, 'profile');
const PORT = 9340;

const PLATFORMS = {
  douyin: {
    label: '抖音',
    url: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
    match: /\/aweme\/v1\/web\/general\/search\/single|\/aweme\/v1\/web\/search\/item/,
    loginHint: /登录|扫码/,
  },
  xhs: {
    label: '小红书',
    url: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&type=51`,
    match: /\/api\/sns\/web\/v1\/search\/notes|\/api\/sns\/web\/v1\/feed/,
    loginHint: /登录|扫码/,
  },
  bilibili: {
    label: 'B站',
    url: (kw) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(kw)}`,
    match: /\/x\/web-interface\/wbi\/search\/type|\/x\/web-interface\/search\/type/,
    loginHint: /登录/,
  },
  kuaishou: {
    label: '快手',
    url: (kw) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(kw)}`,
    match: /\/graphql|visionSearchPhoto|search/i,
    loginHint: /登录|扫码/,
  },
};

const platform = String(process.argv[2] || '').toLowerCase();
const keyword = String(process.argv[3] || '').trim();
if (!PLATFORMS[platform] || !keyword) {
  console.error('用法：node scripts/probe.mjs <douyin|xhs|bilibili|kuaishou> <关键词>');
  process.exit(1);
}

const cfg = PLATFORMS[platform];
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`[探针] ${cfg.label} · 关键词「${keyword}」`);

await launchBrowser({ port: PORT, profileDir: PROFILE, url: 'about:blank' });
if (!(await cdpAlive(PORT))) {
  console.error('无法连接浏览器');
  process.exit(1);
}

const session = new CdpSession(PORT);
const target = await session.connect();
console.log(`[探针] 已连接调试端口，当前页面：${target.title} ${target.url}`);

// 新建独立标签页做搜索，不干扰已有页面
const page = await session.newTab('about:blank');
const collected = [];
const bodies = new Map();

page.onEvent((msg) => {
  if (msg.method === 'Network.responseReceived') {
    const { requestId, response } = msg.params || {};
    if (!requestId || !response) return;
    if (!/json/i.test(response.mimeType || '')) return;
    bodies.set(requestId, { url: response.url, status: response.status });
  }
  if (msg.method === 'Network.loadingFinished') {
    const rid = msg.params?.requestId;
    const meta = bodies.get(rid);
    if (!meta) return;
    bodies.delete(rid);
    if (!cfg.match.test(meta.url)) return;
    page
      .send('Network.getResponseBody', { requestId: rid })
      .then((res) => {
        if (!res?.body) return;
        const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
        collected.push({ url: meta.url, status: meta.status, size: text.length, body: text });
        console.log(`[命中] ${meta.url.slice(0, 120)} (${text.length} 字节)`);
      })
      .catch(() => {});
  }
});

await page.navigate(cfg.url(keyword), 35000);
console.log('[探针] 页面已加载，开始滚动加载…');

// 滚动加载更多
for (let i = 0; i < 6; i += 1) {
  await page.evaluate(
    `(() => {
      if (!document.body) return 0;
      window.scrollTo(0, document.body.scrollHeight);
      const list = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
      list.forEach(el => { el.scrollTop = el.scrollHeight; });
      return document.body.scrollHeight;
    })()`
  );
  await new Promise((r) => setTimeout(r, 1200));
}

const pageInfo = await page.evaluate(
  `JSON.stringify({ title: document.title, url: location.href, text: document.body.innerText.slice(0, 600) })`
);
const info = JSON.parse(pageInfo);
console.log(`[页面] ${info.title} | ${info.url}`);
if (/登录|扫码|验证|安全/.test(info.text)) {
  console.log('[注意] 页面出现登录/验证提示，请先在浏览器窗口里处理：');
  console.log(info.text.slice(0, 300));
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(OUT_DIR, `${platform}_${keyword}_${stamp}.json`);
fs.writeFileSync(
  file,
  JSON.stringify(
    {
      platform,
      keyword,
      probedAt: new Date().toISOString(),
      page: info,
      hits: collected,
    },
    null,
    2
  ),
  'utf8'
);

console.log(`\n[完成] 命中 ${collected.length} 个接口响应`);
console.log(`[产物] ${file}`);
if (collected.length) {
  const sample = collected[0].body.slice(0, 2000);
  console.log('\n第一个响应片段：\n' + sample);
}
page.closeTab();
process.exit(0);
