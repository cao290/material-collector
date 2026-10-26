/**
 * CDP 客户端 —— 连接真实 Chrome，复用登录态
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export function findFirst(list) {
  for (const item of list) {
    if (!item) continue;
    try {
      if (fs.existsSync(item)) return item;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export class CdpError extends Error {
  constructor(message, code = 'CDP_ERROR', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function cdpAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new CdpError(`CDP 返回 HTTP ${response.status}`, 'CDP_HTTP', 502);
  return response.json();
}

export async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/**
 * 启动带调试端口的 Chrome，使用独立 profile（登录态与日常 Chrome 隔离）
 */
export async function launchBrowser({ port, profileDir, url, exe, headless = false, extraArgs = [] }) {
  if (await cdpAlive(port)) return { launched: false };
  const chrome = exe || findFirst(CHROME_CANDIDATES);
  if (!chrome) throw new CdpError('没找到 Chrome 或 Edge', 'NO_CHROME', 500);

  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate',
    ...extraArgs,
  ];
  if (headless) args.push('--headless=new');
  if (url) args.push(url);

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  if (!(await waitForCdp(port))) {
    throw new CdpError('浏览器已启动，但调试端口没有就绪，请关掉窗口后重试', 'CDP_TIMEOUT', 504);
  }
  return { launched: true, exe: chrome };
}

/**
 * 单个页面的 CDP 会话：请求/响应、事件派发、响应体抓取
 */
export class CdpSession {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.targetId = null;
  }

  async connect(targetId, preferUrl) {
    const targets = await listTargets(this.port);
    const pages = targets.filter((item) => item.type === 'page');
    const target = targetId
      ? pages.find((p) => p.id === targetId)
      : (preferUrl && pages.find((p) => preferUrl.test(p.url))) || pages[0];
    if (!target) throw new CdpError('没有可用的页面，请先在浏览器窗口里打开目标站点', 'NO_TARGET', 404);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('连接调试端口超时', 'WS_TIMEOUT', 504)), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('连接调试端口失败', 'WS_ERROR', 502));
      }, { once: true });
    });

    this.ws = ws;
    this.targetId = target.id;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    await this.sendSafe('Page.enable');
    await this.sendSafe('Network.enable');
    await this.sendSafe('Runtime.enable');
    return target;
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new CdpError(message.error.message || 'CDP 错误', 'CDP_ERROR', 502));
      else waiter.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* 单个监听器异常不影响其它 */
      }
    }
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new CdpError('还没有连接浏览器', 'NO_WS', 400));
        return;
      }
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new CdpError(`CDP 调用超时：${method}`, 'CDP_TIMEOUT', 504));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async sendSafe(method, params = {}) {
    try {
      return await this.send(method, params);
    } catch {
      return null;
    }
  }

  /** 在页面里执行 JS，返回可序列化结果 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails.exception || {};
      const text = ex.description || result.exceptionDetails.text || '页面脚本执行失败';
      throw new CdpError('EVAL_DETAIL: ' + text.slice(0, 600), 'EVAL_ERROR', 500);
    }
    return result.result?.value;
  }

  async navigate(url, timeoutMs = 30000) {
    const loaded = new Promise((resolve) => {
      const off = this.onEvent((msg) => {
        if (msg.method === 'Page.loadEventFired') {
          off();
          resolve(true);
        }
      });
      setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
    });
    await this.sendSafe('Page.navigate', { url });
    return loaded;
  }

  /**
   * 在当前浏览器里新建一个后台 tab 并连接它，避免干扰用户正在看的页面。
   */
  async newTab(url) {
    const created = await this.send('Target.createTarget', { url: url || 'about:blank', background: true });
    const id = created?.targetId;
    if (!id) throw new CdpError('新建标签页失败', 'NO_TARGET', 500);
    // 等调试端口把新 target 暴露出来
    let wsUrl = created.webSocketDebuggerUrl || null;
    const deadline = Date.now() + 8000;
    while (!wsUrl && Date.now() < deadline) {
      const targets = await listTargets(this.port);
      const found = targets.find((t) => t.id === id);
      if (found?.webSocketDebuggerUrl) wsUrl = found.webSocketDebuggerUrl;
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) throw new CdpError('新标签页没有调试地址', 'NO_TARGET', 500);
    const child = new CdpSession(this.port);
    await child.attach(wsUrl, id);
    return child;
  }

  /** 直接用已解析出的 ws 地址连接（newTab 内部用） */
  async attach(wsUrl, targetId) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('连接新标签页超时', 'WS_TIMEOUT', 504)), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('连接新标签页失败', 'WS_ERROR', 502));
      }, { once: true });
    });
    this.ws = ws;
    this.targetId = targetId;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    await this.sendSafe('Page.enable');
    await this.sendSafe('Network.enable');
    return true;
  }

  /** 关闭本会话所在的标签页 */
  async closeTab() {
    const id = this.targetId;
    this.close();
    if (!id) return;
    try {
      const admin = new CdpSession(this.port);
      const targets = await listTargets(this.port);
      const any = targets.find((t) => t.webSocketDebuggerUrl);
      if (!any) return;
      await admin.attach(any.webSocketDebuggerUrl, any.id);
      await admin.sendSafe('Target.closeTarget', { targetId: id });
      admin.close();
    } catch {
      /* ignore */
    }
  }

  async getCookies(urls) {
    const result = await this.sendSafe('Network.getCookies', urls ? { urls } : {});
    return result?.cookies || [];
  }

  /**
   * 在页面上下文里下载二进制（B站视频流校验 Referer，Node 直连会被拒）
   * 分块 base64 回传，避免单条 CDP 消息过大。
   */
  async fetchBinaryInPage(url, { chunkSize = 6 * 1024 * 1024, onProgress } = {}) {
    const KEY = `k${Date.now().toString(36)}`;
    // 先整个拉进页面内存
    const head = await this.evaluate(
      `(async () => {
        const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!res.ok) return JSON.stringify({ ok: false, status: res.status });
        const buf = await res.arrayBuffer();
        window.__scBin = window.__scBin || {};
        window.__scBin[${JSON.stringify(KEY)}] = new Uint8Array(buf);
        return JSON.stringify({ ok: true, size: buf.byteLength });
      })()`,
      { awaitPromise: true }
    );
    let info;
    try {
      info = JSON.parse(head);
    } catch {
      throw new Error('页面内请求失败');
    }
    if (!info.ok) throw new Error(`页面内请求返回 HTTP ${info.status}`);

    const total = info.size;
    const parts = [];
    let offset = 0;
    while (offset < total) {
      const len = Math.min(chunkSize, total - offset);
      const b64 = await this.evaluate(
        `(() => {
          const arr = window.__scBin[${JSON.stringify(KEY)}].subarray(${offset}, ${offset + len});
          let s = '';
          const step = 0x8000;
          for (let i = 0; i < arr.length; i += step) {
            s += String.fromCharCode.apply(null, arr.subarray(i, i + step));
          }
          return btoa(s);
        })()`
      );
      parts.push(Buffer.from(b64, 'base64'));
      offset += len;
      onProgress?.({ received: offset, total });
    }

    await this.evaluate(`(() => { delete window.__scBin[${JSON.stringify(KEY)}]; return 1; })()`);
    return Buffer.concat(parts);
  }

  async setCookie(cookie) {
    return this.sendSafe('Network.setCookie', cookie);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
