/**
 * 采集引擎
 * - 打开平台搜索页（独立标签页，不干扰用户）
 * - 双通道取数：CDP 拦 XHR JSON + DOM 解析
 * - 滚动到够数或没新内容
 * - 登录墙/验证码 → 任务转 need_human，等用户处理后继续
 */
import { jitter, autoScroll, detectBlock, PLATFORM_META } from './adapters/base.mjs';
import { BilibiliAdapter } from './adapters/bilibili.mjs';
import { DouyinAdapter } from './adapters/douyin.mjs';
import { XhsAdapter } from './adapters/xhs.mjs';
import { KuaishouAdapter } from './adapters/kuaishou.mjs';

const ADAPTERS = {
  douyin: new DouyinAdapter({ id: 'douyin' }),
  xhs: new XhsAdapter({ id: 'xhs' }),
  bilibili: new BilibiliAdapter({ id: 'bilibili' }),
  kuaishou: new KuaishouAdapter({ id: 'kuaishou' }),
};

export function getAdapter(platform) {
  return ADAPTERS[platform] || null;
}

export const PLATFORMS = Object.values(PLATFORM_META).map((m) => ({
  id: Object.keys(PLATFORM_META).find((k) => PLATFORM_META[k] === m),
  label: m.label,
  color: m.color,
  searchUrl: m.searchUrl('关键词'),
}));

/**
 * 单次采集任务
 * @param {object} opts
 * @param {function} opts.createSession 建一个采集会话（Electron 宿主提供）
 * @param {string} opts.platform
 * @param {string} opts.keyword
 * @param {number} opts.target 目标条数
 * @param {function} opts.onProgress ({found, status, message})
 * @param {function} opts.onItems (items[]) 增量入库
 * @param {AbortSignal} opts.signal
 */
export async function runCollect({ createSession, platform, keyword, target = 50, onProgress, onItems, signal, checkLogin, onCaptcha }) {
  const adapter = getAdapter(platform);
  if (!adapter) throw new Error(`不支持的平台：${platform}`);
  const meta = PLATFORM_META[platform];

  const report = (patch) => onProgress && onProgress(patch);

  if (!createSession) throw new Error('没有可用的浏览器宿主');
  const tab = await createSession();
  const seen = new Map(); // platform_id -> item
  const bodies = new Map();

  const absorb = (items) => {
    if (!items || !items.length) return 0;
    let added = 0;
    for (const item of items) {
      if (!item || !item.platform_id) continue;
      if (seen.has(item.platform_id)) {
        // 已有条目只补空字段（例如直链）
        const prev = seen.get(item.platform_id);
        for (const [k, v] of Object.entries(item)) {
          if (v && !prev[k]) prev[k] = v;
        }
        continue;
      }
      seen.set(item.platform_id, item);
      added += 1;
    }
    if (added && onItems) onItems([...seen.values()].slice(-added));
    return added;
  };

  // 拦 XHR 取结构化数据
  tab.onEvent((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response } = msg.params || {};
      if (!requestId || !response) return;
      if (!/json/i.test(response.mimeType || '')) return;
      const url = response.url || '';
      const isDouyin = adapter.matchResponse && adapter.matchResponse(url);
      const isXhsList = adapter.matchList && adapter.matchList(url);
      const isXhsFeed = adapter.matchFeed && adapter.matchFeed(url);
      const isKwai = adapter.matchResponse && adapter.matchResponse(url);
      if (!(isDouyin || isXhsList || isXhsFeed || isKwai)) return;
      bodies.set(requestId, { url, kind: isXhsFeed ? 'feed' : 'list' });
    }
    if (msg.method === 'Network.loadingFinished') {
      const rid = msg.params?.requestId;
      const info = bodies.get(rid);
      if (!info) return;
      bodies.delete(rid);
      tab
        .send('Network.getResponseBody', { requestId: rid })
        .then((res) => {
          if (!res?.body) return;
          const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          if (info.kind === 'feed') {
            const detail = adapter.parseFeed ? adapter.parseFeed(text) : null;
            if (detail?.platform_id && seen.has(detail.platform_id)) {
              const prev = seen.get(detail.platform_id);
              Object.assign(prev, {
                video_url: detail.video_url || prev.video_url,
                duration: detail.duration || prev.duration,
                desc: detail.desc || prev.desc,
                tags: detail.tags || prev.tags,
              });
            }
            return;
          }
          const items = adapter.parseBody ? adapter.parseBody(text, keyword) : [];
          const added = absorb(items);
          if (added) report({ found: seen.size });
        })
        .catch(() => {});
    }
  });

  await tab.sendSafe('Page.enable');
  await tab.sendSafe('Network.enable');

  try {
    report({ status: 'running', message: `打开 ${meta.label} 搜索页` });
    await tab.navigate(meta.searchUrl(keyword), 35000);
    await jitter(1200, 2200);

    // 风控中间页检测（抖音连续访问会跳「验证码中间页」，body 只有几字节）
    const riskProbe = await tab
      .evaluate(
        `JSON.stringify({
          title: document.title || '',
          bodyLen: (document.body && document.body.innerText || '').length,
          url: location.href
        })`
      )
      .catch(() => '');
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
      // 先抓当前页面地址（会话随后会被 closeTab 重置成 about:blank）
      const pageUrl = await tab.evaluate('location.href').catch(() => '');
      if (onCaptcha) {
        await onCaptcha({ reason: riskPage.title || '验证码页', platform, url: pageUrl }).catch(() => {});
      }
      report({
        status: 'need_human',
        message: `${meta.label} 触发风控（${riskPage.title || '页面无内容'}）：验证页面已显示在「内置浏览器」里，完成后点「继续」`,
      });
      return {
        items: [...seen.values()],
        needHuman: true,
        logged: false,
        captchaUrl: pageUrl,
        message: `${meta.label} 触发风控：验证页面已显示在「内置浏览器」里，完成验证后点「继续」`,
      };
    }

    // 登录 / 风控检测
    let block = await detectBlock(tab, meta);
    // 登录判定交给宿主（服务端验证，cookie 存在但失效也能识别）；
    // 宿主不可用时退回适配器的 cookie 判断
    let logged;
    if (checkLogin) {
      try {
        const map = await checkLogin();
        logged = !!map?.[platform];
      } catch {
        logged = await adapter.isLoggedIn(tab);
      }
    } else {
      logged = await adapter.isLoggedIn(tab);
    }
    if (block.loginWall || !logged) {
      if (block.loginWall || platform !== 'bilibili') {
        report({
          status: 'need_human',
          message: `${meta.label} ${block.loginWall ? '页面要求登录' : '登录态无效'}：请到「内置浏览器」扫码登录，然后点「继续」`,
        });
        return { items: [...seen.values()], needHuman: true, logged: false };
      }
    }
    if (block.verifyWall || block.captchaDom) {
      const pageUrl = await tab.evaluate('location.href').catch(() => '');
      if (onCaptcha) await onCaptcha({ reason: '验证码弹窗', platform, url: pageUrl }).catch(() => {});
      report({ status: 'need_human', message: `${meta.label} 出现验证码：验证页面已显示在「内置浏览器」里，完成后点「继续」` });
      return {
        items: [...seen.values()],
        needHuman: true,
        logged,
        captchaUrl: pageUrl,
        message: `${meta.label} 出现验证码：验证页面已显示在「内置浏览器」里，完成验证后点「继续」`,
      };
    }

    report({ status: 'running', message: '滚动加载中' });

    await autoScroll(tab, {
      rounds: 40,
      idleStop: 4,
      stopAt: (n) => n >= target,
      onRound: async () => {
        if (signal?.aborted) throw new Error('已取消');
        // 第一通道：DOM
        const fromDom = await adapter.collect(tab, keyword);
        absorb(fromDom);
        report({ found: seen.size });
        if (seen.size >= target) return seen.size;

        // 第二通道：对有直链的平台，边滚边补详情（小红书）
        if (platform === 'xhs') {
          const need = [...seen.values()].filter((i) => !i.video_url).slice(0, 3);
          for (const item of need) {
            await openDetail(tab, item, adapter, seen, signal);
            await jitter(700, 1400);
          }
        }

        // 风控检查
        if (Math.random() < 0.34) {
          const b = await detectBlock(tab, meta);
          if (b.captchaDom || b.verifyWall) {
            if (onCaptcha) await onCaptcha({ reason: '采集中出现验证码', platform }).catch(() => {});
            report({ status: 'need_human', message: `${meta.label} 出现验证码：验证窗口已自动弹出，完成后点「继续」` });
            throw new Error('NEED_HUMAN');
          }
        }
        return seen.size;
      },
    });

    // 抖音/快手/B站：DOM 拿不到直链的，进详情页补
    {
      const need = [...seen.values()].filter((i) => !i.video_url).slice(0, Math.min(target, 60));
      if (need.length) {
        report({ message: `补全 ${need.length} 条详情（获取直链）` });
        let riskHits = 0;
        for (const item of need) {
          if (signal?.aborted) break;
          await openDetail(tab, item, adapter, seen, signal);
          // 抖音连续访问详情页会跳验证码中间页：命中就停，别把账号搞进黑名单
          if (adapter.detectRiskPage) {
            const r = await adapter.detectRiskPage(tab).catch(() => ({ risk: false }));
            if (r.risk) {
              riskHits += 1;
              // 抓当前地址 + 搬验证页到面板（和搜索页风控同样的处理）
              const riskUrl = await tab.evaluate('location.href').catch(() => '');
              if (onCaptcha) {
                await onCaptcha({ reason: '详情页触发风控', platform, url: riskUrl }).catch(() => {});
              }
              report({
                status: 'need_human',
                message: `${meta.label} 详情页触发风控：验证页面已显示在「内置浏览器」里，过完验证点「继续」补直链（已采 ${seen.size} 条）`,
              });
              break;
            }
          }
          // 抖音详情页间隔加大，降低风控概率
          await jitter(platform === 'douyin' ? 2500 : 900, platform === 'douyin' ? 4500 : 1800);
          report({ found: seen.size });
        }
        if (riskHits) {
          return {
            items: [...seen.values()],
            needHuman: true,
            logged: true,
            message: `${meta.label} 详情页触发风控：验证页面已显示在「内置浏览器」里，过完验证点「继续」补直链`,
          };
        }
      }
    }

    if (seen.size === 0) {
      const again = await tab
        .evaluate(
          `JSON.stringify({ title: document.title || '', bodyLen: (document.body && document.body.innerText || '').length })`
        )
        .catch(() => '');
      let why = `${meta.label} 没有采到结果`;
      try {
        const a = JSON.parse(again || '{}');
        if (/验证码|安全验证|频繁/.test(a.title) || a.bodyLen < 60) {
          why = `${meta.label} 触发风控（${a.title || '页面无内容'}），请到「内置浏览器」手动过验证后点「继续」`;
        } else {
          why = `${meta.label} 没有采到结果（可能关键词无匹配，或页面结构已变化）`;
        }
      } catch {
        /* ignore */
      }
      report({ status: 'need_human', message: why });
      return { items: [...seen.values()], needHuman: true, logged: true };
    }

    report({ status: 'done', message: `采集完成，共 ${seen.size} 条` });
    return { items: [...seen.values()], needHuman: false, logged: true };
  } finally {
    await tab.closeTab().catch(() => {});
  }
}

/** 进入详情页，补直链和完整元信息 */
async function openDetail(tab, item, adapter, seen, signal) {
  if (signal?.aborted) return;
  if (!item.page_url) return;

  // 优先用适配器自己的 detail（B站读 __playinfo__）
  if (adapter.detail) {
    try {
      const detail = await adapter.detail(tab, item);
      if (detail) {
        Object.assign(item, {
          ...detail,
          keyword: item.keyword,
          platform: item.platform,
          platform_id: item.platform_id,
          page_url: item.page_url,
        });
        seen.set(item.platform_id, item);
        return;
      }
    } catch {
      /* 退回 XHR 拦截 */
    }
  }

  if (!item.video_url) {
    const before = { url: item.video_url };
    const waiter = new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, 12000);
      const off = tab.onEvent((msg) => {
        if (msg.method !== 'Network.responseReceived') return;
        const { requestId, response } = msg.params || {};
        const url = response?.url || '';
        const isDetail =
          (adapter.detailMatch && adapter.detailMatch(url)) ||
          (adapter.matchFeed && adapter.matchFeed(url));
        if (!isDetail) return;
        tab
          .send('Network.getResponseBody', { requestId })
          .then((res) => {
            if (!res?.body) return;
            const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
            clearTimeout(timer);
            off();
            resolve(text);
          })
          .catch(() => {});
      });
    });

    await tab.navigate(item.page_url, 20000);
    const body = await waiter;

    if (body) {
      if (adapter.parseBody) {
        const list = adapter.parseBody(body, item.keyword || '');
        if (list.length) Object.assign(item, list[0]);
      }
      if (adapter.parseFeed) {
        const d = adapter.parseFeed(body);
        if (d) Object.assign(item, {
          video_url: d.video_url || item.video_url,
          duration: d.duration || item.duration,
          tags: d.tags || item.tags,
          desc: d.desc || item.desc,
        });
      }
    }

    // 详情页 DOM 兜底：<video> 标签
    if (!item.video_url) {
      const src = await tab.evaluate(
        `(() => { const v = document.querySelector('video'); return v ? (v.currentSrc || v.src || '') : ''; })()`
      );
      if (src && /^https?:/.test(src)) item.video_url = src;
    }
    if (item.video_url && item.video_url !== before.url) seen.set(item.platform_id, item);
    return;
  }

  if (item.detail_url) await tab.navigate(item.detail_url, 20000);
  else await tab.navigate(item.page_url, 20000);
}
