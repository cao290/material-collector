/**
 * Electron 宿主适配层
 *
 * 窗口结构：
 * - 主窗口：功能界面（采集/结果/素材库/设置）+ userView（「内置浏览器」视图里的浏览面板）
 * - 任务窗口：隐藏的子窗口，跑采集/自动化——物理上不在主窗口里，不可能遮挡界面；
 *   show:false + backgroundThrottling:false 保证后台照常渲染（Electron 爬虫标准姿势）
 *
 * 服务端逻辑只认「浏览器宿主」接口；采集会话实现 CdpSession 的鸭子接口
 * （onEvent / send / evaluate / navigate / getCookies / closeTab），
 * collector.mjs 与平台适配器零改动。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const HOME_URLS = {
  douyin: 'https://www.douyin.com',
  xhs: 'https://www.xiaohongshu.com',
  bilibili: 'https://www.bilibili.com',
  kuaishou: 'https://www.kuaishou.com',
};

// 只认「强登录」cookie——ttwid/a1/userId 这类游客态不算已登录
const LOGIN_COOKIES = {
  douyin: ['sessionid', 'sessionid_ss'],
  xhs: ['web_session'],
  bilibili: ['SESSDATA'],
  kuaishou: ['kuaishou.server.web_st', 'kuaishou.server.webday7_st'],
};

const PARTITION = 'persist:platforms';

import { CAPTCHA_PROBE_SCRIPT } from './captcha.mjs';

export function createElectronHost({ electron, mainWindow }) {
  const { session, WebContentsView, BrowserWindow } = electron;

  let platformSession = null;
  let userView = null; // 「内置浏览器」视图里的浏览面板
  let taskWin = null; // 任务用的隐藏子窗口
  const addedViews = new Set();
  let paneState = { visible: false, url: '', title: '', canBack: false, canForward: false };
  let paneRect0 = null;
  let paneAllowed = false; // UI 是否正停在「内置浏览器」视图——只有 true 才允许挂载视图
  let browserSessionActive = false;
  const loginNotes = {}; // platform -> 检测说明
  let automationCtx = null; // 外部自动化长会话

  function ses() {
    if (!platformSession) {
      platformSession = session.fromPartition(PARTITION);
      platformSession.setUserAgent(UA, '');
      platformSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      // 注意：setWindowOpenHandler 是 webContents 的方法，Session 上没有——
      // 面板/任务窗口各自在创建时挂（见 ensureUserView / taskWin）。
    }
    return platformSession;
  }

  /* ==================== 内嵌浏览面板（用户浏览） ==================== */

  function attachView(view) {
    // addChildView 对已存在的视图会重排到最顶层
    mainWindow.contentView.addChildView(view);
    addedViews.add(view);
  }

  function detachView(view) {
    if (addedViews.has(view)) {
      mainWindow.contentView.removeChildView(view);
      addedViews.delete(view);
    }
  }

  let userPaneMuted = true; // 内置浏览面板默认静音，界面有声音开关

  function setUserPaneMuted(muted) {
    userPaneMuted = !!muted;
    if (userView) userView.webContents.setAudioMuted(userPaneMuted);
    return { ok: true, muted: userPaneMuted };
  }

  function ensureUserView() {
    if (!userView) {
      userView = new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 面板切到后台/最小化时页面定时器会被 Chromium 降频甚至冻结，
          // 卡片下载按钮的补扫与进度回显就停了——和任务窗口一样关掉节流。
          backgroundThrottling: false,
        },
      });
      const wc = userView.webContents;
      wc.setAudioMuted(userPaneMuted);
      // 面板里点开的链接（target=_blank / window.open）不弹新窗口，直接在本面板内打开
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) wc.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      wc.on('did-navigate', () => { syncPaneState(); injectDlButtons().catch(() => {}); });
      wc.on('did-navigate-in-page', () => { syncPaneState(); injectDlButtons().catch(() => {}); });
      wc.on('page-title-updated', () => syncPaneState());
      // 抖音这类 SPA 首屏渲染慢，导航事件早于卡片出现；靠定时补注兜住
      const injectTimer = setInterval(() => {
        if (wc.isDestroyed()) return clearInterval(injectTimer);
        injectDlButtons().catch(() => {});
      }, 4000);
      injectTimer.unref?.();
      wc.once('destroyed', () => clearInterval(injectTimer));
    }
    return userView;
  }

  /**
   * 往面板页面注入「每个视频卡片一个下载按钮」。
   * 注入脚本由页面 URL 平台判断生成；按钮点击后把视频详情页地址写到 window 上，
   * 主进程轮询取出 → 走 /api/page/download 同一条无水印下载链路。
   * 支持的平台：抖音 / B站 / 快手 / 小红书（其它平台不注入）。
   */
  function platformOfUrl(url) {
    if (/douyin\.com|iesdouyin\.com/.test(url)) return 'douyin';
    if (/bilibili\.com/.test(url)) return 'bilibili';
    if (/kuaishou\.com/.test(url)) return 'kuaishou';
    if (/xiaohongshu\.com/.test(url)) return 'xhs';
    return '';
  }

  async function injectDlButtons() {
    if (!userView) return;
    const wc = userView.webContents;
    const url = wc.getURL() || '';
    const platform = platformOfUrl(url);
    if (!platform) return;
    // 页面还没就绪（SPA 首屏/风控空页）时 body 是空的，注进去也扫不到卡片，
    // 所以这里不落防重标记——等下次导航或定时补注再试。
    const ready = await wc
      .executeJavaScript(
        `(() => { try { return !!(document.body && document.body.innerText && document.body.innerText.length > 20); } catch (e) { return false; } })()`,
        true
      )
      .catch(() => false);
    if (!ready) return;
    // 脚本已装过就只重新扫一遍（页面重渲染会把按钮冲掉），没装过则整套装上。
    let added = -1;
    try {
      const r = await wc.executeJavaScript(PANE_DL_BUTTONS_SCRIPT.replace(/__PLATFORM__/g, platform), true);
      if (typeof r === 'number') added = r;
    } catch {
      /* 页面还没就绪时静默，下次导航再试 */
    }
    return added;
  }

  /** 取走页面上按钮收集的下载请求（被 server 轮询） */
  async function takePaneDlRequests() {
    if (!userView) return [];
    try {
      const raw = await userView.webContents.executeJavaScript(
        '(() => { const r = JSON.stringify(window.__dlRequests || []); window.__dlRequests = []; return r; })()',
        true
      );
      const arr = JSON.parse(raw || '[]');
      return Array.isArray(arr) ? arr.filter((r) => r && r.url) : [];
    } catch {
      return [];
    }
  }

  /** 在面板页面执行任意 JS（下载按钮进度回显用）；面板未开页面时抛错 */
  async function paneEval(expr) {
    if (!userView) throw new Error('面板未创建');
    const url = userView.webContents.getURL() || '';
    if (!url || url === 'about:blank') throw new Error('面板没有打开页面');
    return await userView.webContents.executeJavaScript(expr, true);
  }

  /** 在主窗口（软件界面）里执行 JS —— 用于自检界面渲染 */
  async function mainEval(expr) {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不存在');
    return await mainWindow.webContents.executeJavaScript(expr, true);
  }


  function syncPaneState() {
    if (!userView) return;
    paneState.url = userView.webContents.getURL() || '';
    paneState.title = userView.webContents.getTitle() || '';
    paneState.canBack = userView.webContents.navigationHistory.canGoBack();
    paneState.canForward = userView.webContents.navigationHistory.canGoForward();
  }

  /**
   * 面板矩形校验：尺寸无效返回 null（绝不兜底铺满窗口——那会盖住整个界面）。
   * 侧栏宽 208，x 小于它就说明量到了错误位置。
   */
  function sanitizeRect(rect) {
    const r = {
      x: Math.round(Number(rect?.x) || 0),
      y: Math.round(Number(rect?.y) || 0),
      width: Math.round(Number(rect?.width) || 0),
      height: Math.round(Number(rect?.height) || 0),
    };
    if (r.width < 200 || r.height < 200) return null;
    if (r.x < 180) return null; // 落进侧栏区域，肯定是错的
    return r;
  }

  function showPane(rect, url) {
    const view = ensureUserView();
    const r = sanitizeRect(rect);
    if (!r) {
      // 界面量不到尺寸（视图还没显示）：只预加载，不挂载，等下次带正确尺寸再来
      if (url && url !== view.webContents.getURL()) {
        view.webContents.loadURL(url).catch(() => {});
      }
      return { ok: false, reason: 'rect-invalid' };
    }
    paneAllowed = true;
    attachView(view); // 置顶，保证面板不被其它视图盖住
    paneRect0 = r;
    view.setBounds(r);
    paneState.visible = true;
    if (url && url !== view.webContents.getURL()) {
      view.webContents.loadURL(url).catch(() => {});
    }
    view.webContents.focus();
    syncPaneState();
    // 面板重新挂上/回到前台时立刻补一次按钮：detach 期间页面定时器被冻结，
    // 期间 SPA 重渲染会把按钮冲掉，不能等下一个 4 秒 tick。
    injectDlButtons().catch(() => {});
    startQrWatcher();
    return { ok: true };
  }

  function setBounds(rect) {
    const r = sanitizeRect(rect);
    if (!r) return { ok: false, reason: 'rect-invalid' };
    paneRect0 = r;
    if (paneAllowed) {
      const view = ensureUserView();
      attachView(view);
      view.setBounds(r);
      paneState.visible = true;
    }
    return { ok: true };
  }

  function hidePane() {
    paneAllowed = false;
    if (userView) detachView(userView);
    paneState.visible = false;
    stopQrWatcher();
    stopCaptchaWatcher();
  }

  /**
   * 导航：只加载，不挂载。视图是否显示完全由 UI 决定（/browser/show）。
   * 这样外部调 API 打开页面时，绝不会盖住用户正在看的功能界面。
   */
  async function paneNavigate(url) {
    const view = ensureUserView();
    await view.webContents.loadURL(url).catch(() => {});
    syncPaneState();
    return { ok: true, visible: paneState.visible };
  }

  function paneBack() {
    const wc = userView?.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  function paneForward() {
    const wc = userView?.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  function paneReload() {
    userView?.webContents.reload();
  }

  let qrTimer = null;

  /** 二维码看守：扫码页的二维码会过期，自动点刷新，免得你盯着失效码白等 */
  function startQrWatcher() {
    if (qrTimer) return;
    qrTimer = setInterval(async () => {
      if (!userView || !paneAllowed) return;
      try {
        const clicked = await userView.webContents
          .executeJavaScript(QR_PROBE_SCRIPT, true)
          .catch(() => false);
        if (clicked) console.log('[qr-watcher] 已刷新过期二维码:', clicked);
      } catch {
        /* ignore */
      }
    }, 4000);
  }

  function stopQrWatcher() {
    if (qrTimer) {
      clearInterval(qrTimer);
      qrTimer = null;
    }
  }

  function paneStateSnapshot() {
    syncPaneState();
    return { ...paneState };
  }

  /* ==================== 任务窗口（采集 / 自动化） ==================== */

  function ensureTaskWindow() {
    if (!taskWin || taskWin.isDestroyed()) {
      taskWin = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        autoHideMenuBar: true,
        skipTaskbar: true, // 不占任务栏
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false, // 后台照常渲染、跑脚本
        },
      });
      taskWin.setMenuBarVisibility(false);
      taskWin.webContents.setAudioMuted(true); // 自动化全程静音，绝不外放
      taskWin.webContents.setWindowOpenHandler(({ url }) => {
        taskWin.webContents.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      taskWin.on('closed', () => {
        taskWin = null;
      });
    }
    return taskWin;
  }

  /** 「看任务画面」的截图源 */
  async function taskScreenshot() {
    if (!taskWin || taskWin.isDestroyed()) return null;
    try {
      const img = await taskWin.webContents.capturePage();
      if (!img || img.isEmpty()) return null;
      return img.toPNG().toString('base64');
    } catch {
      return null;
    }
  }

  async function createCollectSession() {
    // 互斥：同一时间只允许一个会话占用任务窗口
    if (browserSessionActive) {
      const err = new Error('浏览器内核正被其它任务占用，请稍后再试');
      err.code = 'BUSY';
      err.status = 409;
      throw err;
    }
    browserSessionActive = true;

    const win = ensureTaskWindow();
    const wc = win.webContents;

    // 预热渲染进程：页面没就绪前 debugger 命令会无限排队
    if (!wc.getURL() || wc.getURL() === '') {
      await Promise.race([
        wc.loadURL('about:blank'),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      for (let i = 0; i < 20; i += 1) {
        try {
          const ready = await Promise.race([
            wc.executeJavaScript('document.readyState', true),
            new Promise((_, reject) => setTimeout(() => reject(new Error('预热超时')), 2000)),
          ]);
          if (ready === 'complete' || ready === 'interactive') break;
        } catch {
          /* 渲染进程还没起来，等下一轮 */
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch {
        /* 已附加 */
      }
    }
    const listeners = new Set();
    const onMessage = (_event, method, params) => {
      for (const fn of listeners) {
        try {
          fn({ method, params });
        } catch {
          /* 单个监听器异常不影响其它 */
        }
      }
    };
    dbg.on('message', onMessage);

    for (const domain of ['Page.enable', 'Network.enable', 'Runtime.enable']) {
      try {
        await Promise.race([
          dbg.sendCommand(domain),
          new Promise((_, reject) => setTimeout(() => reject(new Error(domain + ' 超时')), 8000)),
        ]);
      } catch {
        /* ignore */
      }
    }

    let sessionClosed = false;
    const sessionLike = {
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async send(method, params = {}, timeoutMs = 45000) {
        if (!dbg.isAttached()) throw new Error('debugger 未附加');
        return await Promise.race([
          dbg.sendCommand(method, params),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`CDP 调用超时：${method}`)), timeoutMs)
          ),
        ]);
      },
      async sendSafe(method, params = {}) {
        try {
          return await sessionLike.send(method, params);
        } catch {
          return null;
        }
      },
      async evaluate(expression) {
        // 走 debugger 的 Runtime.evaluate：异常信息完整（executeJavaScript 只给一句笼统提示）
        if (dbg.isAttached()) {
          try {
            const r = await sessionLike.send('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            });
            if (r && r.exceptionDetails) {
              const ex = r.exceptionDetails.exception || {};
              throw new Error('EVAL_DETAIL: ' + String(ex.description || r.exceptionDetails.text || '').slice(0, 800));
            }
            return r && r.result ? r.result.value : undefined;
          } catch (error) {
            if (String(error.message || '').includes('EVAL_DETAIL')) throw error;
            // debugger 路径失败，退回 executeJavaScript
          }
        }
        return await wc.executeJavaScript(expression, true);
      },
      async navigate(url, timeoutMs = 30000) {
        await Promise.race([
          wc.loadURL(url, { userAgent: UA }),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
        return true;
      },
      async getCookies(urls) {
        return getCookies(urls);
      },
      async newTab(url) {
        if (url && url !== 'about:blank') await sessionLike.navigate(url);
        return sessionLike;
      },
      async closeTab() {
        if (sessionClosed) return; // 幂等，避免重复清理
        sessionClosed = true;
        // 先放锁再清理：wc.stop()/loadURL 在页面僵死时会一直挂着，
        // 原来锁放在最后，清理一卡就永久 busy——下一个下载 createCollectSession
        // 拿不到内核，整条队列卡死（实测卡过 372s）。锁和清理必须解耦。
        browserSessionActive = false;
        try {
          dbg.removeListener('message', onMessage);
          if (dbg.isAttached()) dbg.detach();
        } catch {
          /* ignore */
        }
        try {
          // 清理动作本身限时 5s，超时就放弃——页面已经僵死，再等也没意义
          await Promise.race([
            (async () => {
              await wc.stop();
              if (taskWin && !taskWin.isDestroyed()) {
                await wc.loadURL('about:blank');
              }
            })(),
            new Promise((resolve) => {
              const t = setTimeout(resolve, 5000);
              t.unref?.();
            }),
          ]);
        } catch {
          /* ignore */
        }
      },
      async destroy() {
        await sessionLike.closeTab();
      },
    };
    return sessionLike;
  }

  /* ==================== 登录检测 / cookie ==================== */

  /**
   * 登录态检测：cookie 存在 ≠ 已登录（抖音/小红书会提前失效但 cookie 还在）。
   * 有 cookie 时再问一次平台服务端，避免绿灯骗人。
   */
  async function getLoginStatus() {
    const s = ses();
    const out = {};
    for (const [id, names] of Object.entries(LOGIN_COOKIES)) {
      try {
        const cookies = await s.cookies.get({ url: HOME_URLS[id] });
        const hit = cookies.find((c) => names.includes(c.name));
        if (!hit) {
          out[id] = false;
          continue;
        }
        // cookie 在，再验证服务端是否真认（失败时保守认为已登录，避免误杀）
        const verified = await verifyRemote(id, cookies).catch(() => null);
        if (verified === false) {
          out[id] = false;
          loginNotes[id] = 'cookie 还在但平台已判定失效（需重新扫码）';
        } else {
          out[id] = hit.name;
          if (verified === null) loginNotes[id] = 'cookie 有效（服务端未响应，按有效处理）';
        }
      } catch {
        out[id] = false;
      }
    }
    return out;
  }

  /** 问平台服务端：这个 session 还有效吗。true=有效 false=失效 null=不确定 */
  async function verifyRemote(platform, cookies) {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const headers = {
      'user-agent': UA,
      cookie: cookieHeader,
      referer: HOME_URLS[platform] + '/',
      accept: 'application/json, text/plain, */*',
    };
    const timeout = AbortSignal.timeout(6000);

    if (platform === 'douyin') {
      // 抖音：/aweme/v1/web/query/user/ 返回 user_uid 才算登录
      // （im/user/info 会返回 "url doesn't match"，不能用）
      const r = await fetch('https://www.douyin.com/aweme/v1/web/query/user/', { headers, signal: timeout })
        .then((x) => x.json())
        .catch(() => null);
      if (!r) return null;
      if (r.status_code && r.status_code !== 0) return false;
      return !!(r.user_uid || (r.user_info && (r.user_info.uid || r.user_info.user_id)));
    }

    if (platform === 'bilibili') {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers, signal: timeout })
        .then((x) => x.json())
        .catch(() => null);
      if (!r) return null;
      return r.code === 0 && r.data?.isLogin === true;
    }

    if (platform === 'xhs') {
      const r = await fetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', { headers, signal: timeout })
        .then((x) => x.json())
        .catch(() => null);
      if (!r) return null;
      if (r.code === -100 || r.success === false) return false;
      return !!(r.data && (r.data.user_id || r.data.userId));
    }

    if (platform === 'kuaishou') {
      const r = await fetch('https://www.kuaishou.com/rest/wd/user/info', { headers, signal: timeout })
        .then((x) => x.json())
        .catch(() => null);
      if (!r) return null;
      if (r.result === 2 || r.result === 400002) return false;
      return !!(r.data && (r.data.userId || r.data.user_name));
    }

    return null;
  }

  async function getCookies(urls) {
    const s = ses();
    try {
      if (urls?.length) {
        const all = [];
        for (const u of urls) all.push(...(await s.cookies.get({ url: u })));
        return all;
      }
      return await s.cookies.get({});
    } catch {
      return [];
    }
  }

  /* ==================== 对外接口 ==================== */

  /* ---------- 面板诊断 ---------- */

  /** 截取内置浏览器面板当前画面（诊断用） */
  async function paneScreenshot() {
    if (!userView) return null;
    try {
      const img = await userView.webContents.capturePage();
      if (!img || img.isEmpty()) return null;
      return img.toPNG().toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * 把「内置浏览器面板」当前页包成一个鸭子兼容的采集会话。
   * 与 createCollectSession 返回同样的接口（evaluate/navigate/getCookies/onEvent/…），
   * adapters 的详情/去水印逻辑零改动跑在面板页上——用户刷到的视频可直接取直链下载。
   * 不占任务窗口互斥锁（面板是用户自己看着的页面），但与任务窗口会话互斥由调用方决定。
   */
  async function createPaneSession() {
    const view = ensureUserView();
    const wc = view.webContents;
    if (!wc.getURL() || wc.getURL() === 'about:blank') {
      throw new Error('面板没有打开页面：先在内置浏览器里打开要下载的视频页');
    }

    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch {
        /* 已附加 */
      }
    }
    const listeners = new Set();
    const onMessage = (_event, method, params) => {
      for (const fn of listeners) {
        try {
          fn({ method, params });
        } catch {
          /* ignore */
        }
      }
    };
    dbg.on('message', onMessage);
    for (const domain of ['Page.enable', 'Network.enable', 'Runtime.enable']) {
      try {
        await Promise.race([
          dbg.sendCommand(domain),
          new Promise((_, reject) => setTimeout(() => reject(new Error(domain + ' 超时')), 8000)),
        ]);
      } catch {
        /* ignore */
      }
    }

    let closed = false;
    const session = {
      paneBased: true,
      url: () => wc.getURL(),
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async send(method, params = {}, timeoutMs = 45000) {
        if (!dbg.isAttached()) throw new Error('debugger 未附加');
        return await Promise.race([
          dbg.sendCommand(method, params),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`CDP 调用超时：${method}`)), timeoutMs)
          ),
        ]);
      },
      async sendSafe(method, params = {}) {
        try {
          return await session.send(method, params);
        } catch {
          return null;
        }
      },
      async evaluate(expression) {
        if (dbg.isAttached()) {
          try {
            const r = await session.send('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            });
            if (r && r.exceptionDetails) {
              const ex = r.exceptionDetails.exception || {};
              throw new Error('EVAL_DETAIL: ' + String(ex.description || r.exceptionDetails.text || '').slice(0, 800));
            }
            return r && r.result ? r.result.value : undefined;
          } catch (error) {
            if (String(error.message || '').includes('EVAL_DETAIL')) throw error;
          }
        }
        return await wc.executeJavaScript(expression, true);
      },
      async navigate(url, timeoutMs = 30000) {
        await Promise.race([
          wc.loadURL(url, { userAgent: UA }),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
        syncPaneState();
        return true;
      },
      async getCookies(urls) {
        return getCookies(urls);
      },
      async newTab(url) {
        if (url && url !== 'about:blank') await session.navigate(url);
        return session;
      },
      async closeTab() {
        if (closed) return;
        closed = true;
        try {
          dbg.removeListener('message', onMessage);
          if (dbg.isAttached()) dbg.detach();
        } catch {
          /* ignore */
        }
      },
      async destroy() {
        await session.closeTab();
      },
    };
    return session;
  }

  /** 读面板页面文本（诊断用，不占用 automation 会话） */
  async function paneText() {
    if (!userView) return { error: '面板未创建' };
    try {
      const raw = await Promise.race([
        userView.webContents.executeJavaScript(
          `JSON.stringify({
            url: location.href,
            title: document.title,
            bodyLen: (document.body && document.body.innerText || '').length,
            text: (document.body && document.body.innerText || '').slice(0, 500),
            iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 5),
            canvases: document.querySelectorAll('canvas').length,
            inputs: document.querySelectorAll('input').length,
            buttons: [...document.querySelectorAll('button, [role=button]')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 10)
          })`,
          true
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('读取超时')), 8000)),
      ]);
      return JSON.parse(raw || '{}');
    } catch (error) {
      return { error: error.message };
    }
  }

  /* ---------- 验证码辅助 ---------- */

  /** 探测任务窗口/浏览面板里是否有验证码 */
  async function probeCaptcha() {
    const targets = [];
    if (taskWin && !taskWin.isDestroyed()) targets.push(taskWin.webContents);
    if (userView) targets.push(userView.webContents);
    for (const wc of targets) {
      try {
        const raw = await Promise.race([
          wc.executeJavaScript(CAPTCHA_PROBE_SCRIPT, true),
          new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 5000)),
        ]);
        const info = JSON.parse(raw || '{}');
        if (info.found) return info;
      } catch {
        /* 试下一个 */
      }
    }
    return { found: false };
  }

  /**
   * 把验证码顶到用户面前：
   * 1. 若验证码在任务窗口里 → 该窗口短暂显示出来（置顶、居中、可交互）
   * 2. 同时切到内置浏览器视图（界面侧配合）
   */
  /**
   * 把验证码搬到「内置浏览器」面板里显示。
   *
   * 为什么不用「弹出任务窗口」：任务窗口是 show:false + 屏幕外定位创建的，
   * Windows 下对它 setBounds/show 经常不生效（实测停在 -21333 且最小化）。
   * 面板是主窗口的 WebContentsView，只要主窗口在前台就一定可见——最可靠。
   *
   * 做法：把任务窗口当前 URL 复制到 userView 里加载，用户在面板里过验证。
   * 过完验证后，cookie 是同一个 partition，任务窗口自然也是已通过状态。
   */
  /**
   * @param {string} [explicitUrl] 采集引擎在会话关闭前抓到的页面地址（优先用这个，
   *        因为任务窗口在任务结束时会重置成 about:blank）
   */
  async function bringCaptchaFront(explicitUrl) {
    const probe = await probeCaptcha();
    const srcWc = taskWin && !taskWin.isDestroyed() ? taskWin.webContents : null;
    const liveUrl = srcWc ? srcWc.getURL() : '';
    let url = explicitUrl || '';
    if (!url || url === 'about:blank') {
      // 任务窗口还停在有效页面就用它
      if (liveUrl && liveUrl !== 'about:blank') url = liveUrl;
    }
    if (!url || url === 'about:blank') {
      return { ok: false, error: '没有可显示的验证页面（任务可能已结束，请重新发起采集）' };
    }

    // 实测（2026-10-26）：单独打开验证 iframe 的 URL 只会得到空白页
    // （那 URL 依赖父页面上下文/inner 参数）。正确做法是打开**业务页面本身**，
    // 验证码由页面内的 iframe 自然渲染，用户在面板里直接拖滑块即可。
    const targetUrl = url;
    const usedIframe = false;

    const view = ensureUserView();
    paneAllowed = true;
    attachView(view);
    if (paneRect0) view.setBounds(paneRect0);
    await view.webContents.loadURL(targetUrl).catch(() => {});
    view.webContents.focus();
    syncPaneState();
    startQrWatcher();
    startCaptchaWatcher();

    // 让主窗口到前台，保证面板可见
    try {
      mainWindow.show();
      mainWindow.focus();
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      kind: probe.found ? probe.kind : 'unknown',
      tip: probe.tip || '',
      probed: !!probe.found,
      url: targetUrl,
      pageUrl: url,
      usedIframe,
      showing: 'pane',
    };
  }

  /**
   * 面板里的验证码看守：验证码消失（用户过了）→ 通知界面并收回面板提示
   * 验证码还在 → 保持面板显示
   */
  let captchaTimer = null;
  let captchaSeenOnce = false; // 必须先在面板里「看到过」验证码，才谈得上「消失=通过」
  let captchaWatcherTicks = 0;

  function startCaptchaWatcher() {
    if (captchaTimer) return;
    captchaSeenOnce = false;
    captchaWatcherTicks = 0;
    captchaTimer = setInterval(async () => {
      if (!userView || !paneAllowed) return;
      captchaWatcherTicks += 1;
      // 前 3 秒（1 tick）页面还在加载，不做任何判定
      if (captchaWatcherTicks < 2) return;
      try {
        const wc = userView.webContents;
        if (wc.isLoading()) return; // 页面还在加载，跳过
        const raw = await Promise.race([
          wc.executeJavaScript(CAPTCHA_PROBE_SCRIPT, true),
          new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 4000)),
        ]);
        const info = JSON.parse(raw || '{}');
        if (info.found) {
          captchaSeenOnce = true;
          return; // 验证码还在，继续等
        }
        // 只有「之前看到过验证码、现在没了」才算通过
        if (captchaSeenOnce) {
          console.log('[captcha] 面板内验证码已消失，判定已通过');
          stopCaptchaWatcher();
          captchaPassed = true;
        }
      } catch {
        /* ignore */
      }
    }, 3000);
  }
  function stopCaptchaWatcher() {
    if (captchaTimer) {
      clearInterval(captchaTimer);
      captchaTimer = null;
    }
  }
  let captchaPassed = false;
  function consumeCaptchaPassed() {
    const v = captchaPassed;
    captchaPassed = false;
    return v;
  }

  /** 计算滑块缺口位置（只给参考，不自动拖） */
  async function solveCaptchaOffset() {
    const probe = await probeCaptcha();
    if (!probe.found) return { ok: false, error: '没检测到验证码' };
    if (probe.kind !== 'slide') return { ok: false, error: `当前是 ${probe.kind} 类型，暂只支持滑块拼图` };
    // 图片数据交给 Node 侧处理（这里只返回原图，避免在页面里跑重计算）
    return {
      ok: true,
      kind: probe.kind,
      bgSrc: probe.bgSrc,
      sliderSrc: probe.sliderSrc,
      sliderRect: probe.sliderRect,
      rect: probe.rect,
      note: '缺口识别仅作参考，字节滑块还会校验轨迹，请手动拖动',
    };
  }

  /** 验证码通过后把任务窗口收回屏幕外 */
  function hideTaskWindowBack() {
    if (taskWin && !taskWin.isDestroyed()) {
      try {
        taskWin.setAlwaysOnTop(false);
        taskWin.hide();
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  }

  async function openPlatform(platform) {
    await paneNavigate(HOME_URLS[platform] || 'about:blank');
  }

  return {
    mode: 'electron',
    showPane,
    hidePane,
    setBounds,
    paneNavigate,
    paneBack,
    paneForward,
    paneReload,
    paneState: paneStateSnapshot,
    getLoginStatus,
    getLoginNotes: () => ({ ...loginNotes }),
    getCookies,
    openPlatform,
    createCollectSession,
    probeCaptcha,
    bringCaptchaFront,
    solveCaptchaOffset,
    hideTaskWindowBack,
    consumeCaptchaPassed,
    stopCaptchaWatcher,
    paneScreenshot,
    createPaneSession,
    takePaneDlRequests,
    paneEval,
    mainEval,
    platformOfUrl,
    paneText,
    /** 兜底：强制释放内核锁（任务异常结束、外部调用忘关时用） */
    forceRelease: () => {
      browserSessionActive = false;
      automationCtx = null;
      return true;
    },
    getSession: () => ses(),
    setUserPaneMuted,
    isUserPaneMuted: () => userPaneMuted,
    isBusy: () => browserSessionActive || !!automationCtx,
    taskScreenshot,
    get automationContext() {
      return automationCtx;
    },
    set automationContext(v) {
      automationCtx = v;
    },
  };
}

/** 在扫码页里找「二维码失效/点击刷新」，返回点了什么 */
const QR_PROBE_SCRIPT = String.raw`
(() => {
  const text = document.body ? document.body.innerText : '';
  if (!/二维码(已)?失效|二维码已过期|点击刷新|扫码失败/.test(text)) return false;
  const nodes = [...document.querySelectorAll('div, span, button, a, p')];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // 1) 文字就是「刷新 / 点击刷新 / 重新获取」
  const btn = nodes.find((el) => {
    const t = (el.textContent || '').trim();
    if (!t || t.length > 12) return false;
    if (!/^(点击)?刷新$|重新获取|重新加载|刷新二维码$/.test(t)) return false;
    return visible(el);
  });
  if (btn) { btn.click(); return 'btn'; }
  // 2) 文字里含「二维码失效」的小容器（点它）
  const box = nodes.find((el) => {
    const t = (el.textContent || '').trim();
    if (!/二维码(已)?失效|二维码已过期|点击刷新/.test(t)) return false;
    if (t.length > 40) return false;
    const r = el.getBoundingClientRect();
    return visible(el) && r.width > 20 && r.width < 600;
  });
  if (box) { box.click(); return 'box'; }
  return false;
})()
`;


/**
 * 面板页面注入：给每个视频卡片挂「⬇ 无水印下载」按钮。
 * - 每次滚动/翻页后 MutationObserver 自动补挂
 * - 按钮点击 → 抓卡片上的视频详情链接 → 推进 window.__dlRequests
 * - 主进程 takePaneDlRequests() 轮询取走 → 走无水印下载链路
 * - 下载状态通过 window.__dlState 回显到按钮上
 * 平台差异：从卡片 DOM 里抽详情链接的选择器。
 */
const PANE_DL_BUTTONS_SCRIPT = String.raw`
(() => {
  // 二次调用不能直接 return——面板被 detach 时页面定时器会被 Chromium 冻结，
  // 期间 SPA 重渲染会把已挂的按钮冲掉；主进程的兜底定时器必须能把 scan 再触发一次。
  // 所以这里把 scan 挂到 window 上，重复调用 = 重新扫一遍。
  if (typeof window.__dlScan === 'function') {
    try { return window.__dlScan(); } catch (e) { return -1; }
  }
  window.__dlButtonsInstalled = true;
  window.__dlRequests = [];
  window.__dlState = {};          // url -> {status, percent, note}

  const PLATFORM = '__PLATFORM__';

  const isDetail = (u) => {
    if (!u) return false;
    if (PLATFORM === 'douyin')   return /\/(video|note)\/\d+/.test(u);
    if (PLATFORM === 'bilibili') return /\/video\/BV/.test(u);
    if (PLATFORM === 'kuaishou') return /\/short-video\//.test(u);
    if (PLATFORM === 'xhs')      return /\/(explore|discovery\/item)\//.test(u);
    return false;
  };

  // 抖音「精选」页的卡片是 <div data-aweme-id="..." href="//www.douyin.com/video/...">，
  // 根本不是 <a> 标签（实测 links=0）。所以不能只扫 a[href]，
  // 要把带 href / data-aweme-id 属性的任意元素都算作详情入口。
  const detailUrlOf = (el) => {
    const raw = el.getAttribute('href') || '';
    if (isDetail(raw)) return new URL(raw, location.origin).href;
    const awemeId = el.getAttribute('data-aweme-id') || '';
    if (awemeId && PLATFORM === 'douyin') return 'https://www.douyin.com/video/' + awemeId;
    return '';
  };

  const findCardLink = (card) => {
    for (const a of card.querySelectorAll('a[href]')) {
      if (isDetail(a.href || '')) return a.href;
    }
    const own = detailUrlOf(card);
    if (own) return own;
    for (const el of card.querySelectorAll('[data-aweme-id],[href]')) {
      const u = detailUrlOf(el);
      if (u) return u;
    }
    return '';
  };

  const stateOf = (url) => (window.__dlState || {})[url] || null;

  const makeBtn = (url) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '⬇ 下载';
    b.setAttribute('data-collector-dl', url);
    const st = stateOf(url);
    if (st) b.textContent = st.status === 'done' ? '✓ 已下载' : (st.percent ? '↓ ' + st.percent + '%' : '↓ 解析中');
    Object.assign(b.style, {
      position: 'absolute', right: '8px', bottom: '8px', zIndex: '99999',
      padding: '4px 10px', fontSize: '12px', lineHeight: '1.4',
      color: '#fff', background: 'rgba(20,24,34,.82)', border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '999px', cursor: 'pointer', pointerEvents: 'auto',
    });
    b.addEventListener('mouseenter', () => { b.style.background = '#4f8cff'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'rgba(20,24,34,.82)'; });
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (b.dataset.busy === '1') return;
      b.dataset.busy = '1';
      b.textContent = '↓ 排队中';
      window.__dlRequests.push({ url, platform: PLATFORM, at: Date.now() });
    });
    return b;
  };

  const ensureHost = (card) => {
    const pos = getComputedStyle(card).position;
    if (pos === 'static' || pos === '') card.style.position = 'relative';
  };

  const scan = () => {
    // 全页找「含详情链接的卡片」。各家列表结构不同，用启发式：
    // 详情入口可能是 <a href>，也可能只是带 href/data-aweme-id 属性的 div（抖音精选页），
    // 两者都收，再往上找最近的"大块"容器挂按钮。
    const seen = new Set();
    const anchors = document.querySelectorAll('a[href]');
    const extras = PLATFORM === 'douyin' ? document.querySelectorAll('[data-aweme-id]') : [];
    let added = 0;
    for (const el of [...anchors, ...extras]) {
      const url = detailUrlOf(el);
      if (!url) continue;
      // 已挂过就跳过（同一 url 只挂一次）
      if (seen.has(url)) continue;
      seen.add(url);
      // 找容器：从详情入口往上走，选「第一个尺寸像单张卡片」的祖先。
      // 注意不能一遇到大块就停——抖音精选页的卡片 div 外面直接就是
      // 1092x901 的整个网格，那样会把按钮挂到网格上（整页只有一个）。
      const own = el.getBoundingClientRect();
      const targetW = own.width || 0;
      let host = el;
      for (let i = 0; i < 6 && host.parentElement; i++) {
        const p = host.parentElement;
        const r = p.getBoundingClientRect();
        // 一旦明显超出单张卡片尺度（宽度是卡片的 1.6 倍以上）就停，用上一层
        if (targetW && r.width > targetW * 1.6) break;
        if (!targetW && r.width > 1200) break;
        host = p;
        if (r.width > 220 && r.height > 150) break;
      }
      if (!host || host === document.body) continue;
      if (host.querySelector('[data-collector-dl]')) continue;
      ensureHost(host);
      const btn = makeBtn(url);
      host.appendChild(btn);
      added++;
    }
    if (added) {
      // 数量变化通知（主进程轮询 __dlCount 变化决定要不要再取请求）
      window.__dlCount = (window.__dlCount || 0) + added;
    }
    return added;
  };

  scan();
  // 暴露给主进程兜底调用：面板被 detach / 窗口后台时页面定时器会被冻结，
  // 回到前台后由主进程重新调 scan 补挂按钮（见 injectDlButtons）。
  window.__dlScan = scan;
  const mo = new MutationObserver(() => { try { scan(); } catch (e) {} });
  mo.observe(document.body, { childList: true, subtree: true });
  // 滚动加载时定期补扫
  setInterval(() => { try { scan(); } catch (e) {} }, 2500);
  return 'installed';
})()
`;
