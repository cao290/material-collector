/**
 * 平台适配器基类与公共工具
 *
 * 设计原则：
 * - 所有搜索都在真实浏览器里发生，签名由页面 JS 生成，我们不碰算法
 * - 采集优先「拦截 XHR」拿结构化 JSON；拦不到时退回「解析 DOM 卡片」
 * - 适配器只负责：登录检测 / 打开搜索页 / 滚动加载 / 解析条目
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 随机延迟，降低风控特征 */
export function jitter(min = 800, max = 1800) {
  return sleep(Math.floor(min + Math.random() * (max - min)));
}

/** 从任意嵌套 JSON 里按候选路径取值 */
export function pick(obj, ...paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur === null || cur === undefined) {
        ok = false;
        break;
      }
      if (Array.isArray(cur)) {
        const idx = Number(part);
        cur = Number.isInteger(idx) ? cur[idx] : undefined;
      } else {
        cur = cur[part];
      }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

/** 把 12.3w / 1.2亿 / "1,234" 之类转成数字 */
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const text = String(value).trim().replace(/,/g, '');
  const m = text.match(/^([\d.]+)\s*(万|w|W|亿|千|k|K)?/);
  if (!m) return 0;
  const num = Number(m[1]) || 0;
  const unit = m[2] || '';
  if (/万|w|W/.test(unit)) return Math.round(num * 10000);
  if (/亿/.test(unit)) return Math.round(num * 100000000);
  if (/千|k|K/.test(unit)) return Math.round(num * 1000);
  return Math.round(num);
}

/** 03:34 → 214；01:02:03 → 3723 */
export function toSeconds(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** 补全协议相对地址 */
export function absUrl(url, base) {
  if (!url) return '';
  let u = String(url).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  }
  return u;
}

/** 从 URL 里抽视频 id */
export function idFrom(url, re) {
  const m = String(url || '').match(re);
  return m ? m[1] : '';
}

/**
 * 通用滚动加载：
 * - 滚动窗口和所有可滚动容器
 * - 每轮回调一次（可在此收集卡片）
 * - 连续 idle 轮没有新增就停
 */
export async function autoScroll(page, { rounds = 30, idleStop = 4, onRound, stopAt, delay = [900, 1600] } = {}) {
  let idle = 0;
  let lastCount = 0;
  for (let i = 0; i < rounds; i += 1) {
    if (stopAt && stopAt(lastCount)) break;
    const moved = await page.evaluate(`
      (() => {
        let moved = false;
        const before = window.scrollY;
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        if (window.scrollY > before) moved = true;
        const list = [...document.querySelectorAll('*')].filter((el) => {
          if (el.scrollHeight <= el.clientHeight + 200 || el.clientHeight < 150) return false;
          return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
        });
        list.sort((a, b) => b.scrollHeight - a.scrollHeight);
        for (const el of list.slice(0, 3)) {
          const b = el.scrollTop;
          el.scrollTop = Math.min(el.scrollHeight, b + Math.max(500, el.clientHeight * 0.9));
          if (el.scrollTop > b) moved = true;
        }
        return moved;
      })()
    `);
    await jitter(delay[0], delay[1]);
    let count = lastCount;
    if (onRound) {
      const got = await onRound(i);
      if (typeof got === 'number') count = got;
    }
    if (count <= lastCount && !moved) idle += 1;
    else idle = 0;
    lastCount = Math.max(lastCount, count);
    if (idle >= idleStop) break;
  }
  return lastCount;
}

/** 检测页面是否要求登录 / 出现验证 */
/**
 * 登录墙 / 验证码检测。
 * 关键：文字命中不够——隐藏的登录弹窗也在 innerText 里（抖音就有这个问题，会误判）。
 * 判定：文字命中 **且** 元素实际可见（有尺寸、在视口内、未被隐藏）。
 *
 * 实现注意：脚本里所有配置都通过 JSON.stringify 序列化后拼进去，
 * 绝不做「占位符替换」——正则里含 [class*=x] 这类字符时替换会破坏语法。
 */
export async function detectBlock(page, platformCfg) {
  const cfg = {
    login: platformCfg.loginText || '$^',
    verify: platformCfg.verifyText || '$^',
    captcha: platformCfg.captchaSelector || '',
  };
  const script = `(function(){${DETECT_BLOCK_BODY}})(${JSON.stringify(cfg)})`;
  const info = await page.evaluate(script);
  try {
    return JSON.parse(info);
  } catch {
    return { loginWall: false, verifyWall: false, captchaDom: false, text: '', parseError: true };
  }
}

/** 脚本主体：接收 cfg 参数，返回 JSON 字符串 */
const DETECT_BLOCK_BODY = String.raw`
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return false;
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function findVisibleByText(re) {
    var nodes = document.querySelectorAll('div, section, form, aside, dialog');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var own = (el.innerText || '').trim();
      if (!own || own.length > 400) continue;
      if (!re.test(own)) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  var cfg = arguments[0] || {};
  var LOGIN_RE = new RegExp(cfg.login);
  var VERIFY_RE = new RegExp(cfg.verify);

  var loginEl = findVisibleByText(LOGIN_RE);
  var verifyEl = findVisibleByText(VERIFY_RE);

  var captchaVisible = false;
  if (cfg.captcha) {
    var caps = document.querySelectorAll(cfg.captcha);
    for (var j = 0; j < caps.length; j++) {
      if (visible(caps[j])) { captchaVisible = true; break; }
    }
  }

  var text = (document.body && document.body.innerText || '').slice(0, 4000);
  return JSON.stringify({
    text: text.slice(0, 400),
    loginWall: !!loginEl,
    loginElText: loginEl ? (loginEl.innerText || '').trim().slice(0, 60) : '',
    verifyWall: !!verifyEl,
    captchaDom: captchaVisible,
    url: location.href
  });
`;

/** 各平台的页面约定，供基类统一判断 */
export const PLATFORM_META = {
  douyin: {
    label: '抖音',
    color: '#fe2c55',
    searchUrl: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
    loginText: '扫码登录|登录后即可搜索|登录后查看',
    verifyText: '验证码|拖动滑块|安全验证|请完成验证',
    captchaSelector: '#captcha_container, .captcha_verify_container, [class*=captcha]',
    homeUrl: 'https://www.douyin.com',
  },
  xhs: {
    label: '小红书',
    color: '#ff2442',
    searchUrl: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&type=51`,
    loginText: '登录后查看搜索结果|扫码|手机号登录',
    verifyText: '验证码|滑动验证|安全验证|请完成验证',
    captchaSelector: '.captcha, [class*=captcha]',
    homeUrl: 'https://www.xiaohongshu.com',
  },
  bilibili: {
    label: 'B站',
    color: '#00aeec',
    searchUrl: (kw) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(kw)}`,
    loginText: '登录后推荐更懂你的内容|请登录',
    verifyText: '验证码|安全验证',
    captchaSelector: '.geetest_panel, [class*=captcha]',
    homeUrl: 'https://www.bilibili.com',
  },
  kuaishou: {
    label: '快手',
    color: '#ff5000',
    searchUrl: (kw) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(kw)}`,
    loginText: '登录即可享受|立即登录|扫码登录',
    verifyText: '验证码|安全验证|请完成验证',
    captchaSelector: '[class*=captcha]',
    homeUrl: 'https://www.kuaishou.com',
  },
};

export class Adapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.meta = PLATFORM_META[cfg.id];
  }

  get label() {
    return this.meta.label;
  }

  /** 用浏览器 cookie 判断是否已登录 */
  async isLoggedIn(page) {
    const cookies = await page.getCookies([this.meta.homeUrl]);
    const names = new Set(cookies.map((c) => c.name));
    return (this.cfg.loginCookies || []).some((n) => names.has(n));
  }

  async searchUrl(keyword) {
    return this.meta.searchUrl(keyword);
  }

  /** 子类实现：从当前页面解析已有条目 */
  async collect() {
    throw new Error('未实现');
  }
}
