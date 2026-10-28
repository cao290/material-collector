/**
 * 素材采集器后端
 * - 界面与 API 同源（默认 127.0.0.1:8343）
 * - 浏览器操作全部走 browserHost 抽象：
 *     Electron 模式 → 内嵌 WebContentsView（登录/采集都在软件窗口内）
 * - 采集：Network 抓包 + DOM 解析，签名交给页面 JS
 * - 下载：直链优先，yt-dlp 兜底
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CdpError } from './lib/cdp.mjs';
import { openDb, createJob, updateJob, listJobs, getJob, upsertItem, queryItems, getItem, updateItem, createDownload, updateDownload, listDownloads, stats, keywordsOf } from './lib/db.mjs';
import { runCollect, PLATFORMS, getAdapter } from './lib/collector.mjs';
import { downloadItem, buildFileName } from './lib/downloader.mjs';
import { PLATFORM_META } from './lib/adapters/base.mjs';
import * as dbCopies from './lib/db-copies.mjs';
import { mountCopyApi } from './lib/copy-api.mjs';
// 视频转写：数据层/服务客户端/取音频/批量任务/HTTP API 全在这一个模块里
import { ensureTranscribeSchema, mountTranscribe } from './lib/transcribe.mjs';
import { mountSubtitleApi } from './lib/subtitle-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_PORT = Number(process.env.PORT) || 8343;
const HOST = '127.0.0.1';
const WEB_DIR = path.join(__dirname, 'web');
const ROOT = path.resolve(__dirname, '..', '..');

const db = openDb(path.join(__dirname, 'data', 'library.db'));
dbCopies.ensureCopySchema(db);
import { createLoginGuard } from './lib/login-guard.mjs';
let lastBackupAt = 0;
const now = () => Date.now();
const loginGuard = createLoginGuard({
  getSession: () => browserHost?.getSession?.() || null,
});
// 启动时把磁盘上的登录态备份读进守护内存，否则重启后 hasBackup()/丢失提示要等
// 第一次成功备份（可能已经登不上）才可用——「一键恢复」就永远用不上。
try {
  const backupFile = path.join(__dirname, 'data', 'login-backup', 'latest.json');
  if (fs.existsSync(backupFile)) {
    const meta = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    if (meta?.cookies?.length) loginGuard.prefillMeta(meta);
  }
} catch {
  /* 备份文件损坏就当没有 */
}
dbCopies.migrateCopySchema(db);
ensureTranscribeSchema(db);

// 启动清账：上次退出时残留的 downloading/queued 记录已无进程在跑，标成中断，
// 否则它们在下载中心永远显示「进行中」且进度卡住。
try {
  const stale = db
    .prepare("UPDATE downloads SET status = 'error', error = '进程重启，任务中断' WHERE status IN ('downloading','queued')")
    .run();
  if (stale.changes) console.log(`[boot] 清理 ${stale.changes} 条中断的下载记录`);
} catch {
  /* ignore */
}

/** 设置持久化 */
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const DEFAULT_SETTINGS = {
  downloadDir: 'H:\\素材库',
  rootDir: 'H:\\素材库',
  concurrency: 5,
  delayMin: 800,
  delayMax: 1800,
  defaultTarget: 50,
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  copyCommentTarget: 50,
  webhookUrl: '',
  transcribeModel: 'medium',
  transcribeLanguage: 'zh',
};
let settings = { ...DEFAULT_SETTINGS };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {
  /* 首次运行 */
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// 启动清扫下载残片：进程被强杀时 finally 不会跑，`.part`/`.m4s`/`.tmp` 半成品会留在
// 素材库里永久占盘（实测攒过 332MB）。这些文件永远不该长期存在（成功会被 rename 掉），
// 所以开机递归扫一遍素材库删干净。只删明确的临时后缀，不碰正式成品。
// 必须放在 settings 加载之后调用——依赖 settings.downloadDir。
function sweepTempFiles() {
  try {
    const dir = settings.downloadDir;
    let freed = 0;
    let n = 0;
    const isTmp = (name) =>
      /\.part$/.test(name) ||
      /\.part\.m4a$/.test(name) ||
      /\.tmp\.mp4$/.test(name) ||
      /\.(v|a)\.m4s$/.test(name) ||
      /\.tmp\.(douyin|xhs|kuaishou|bilibili)$/.test(name);
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (isTmp(e.name)) {
          try {
            freed += fs.statSync(p).size;
            fs.unlinkSync(p);
            n += 1;
          } catch {
            /* 单个文件删不掉（占用/权限）不影响其他文件 */
          }
        }
      }
    };
    if (dir && fs.existsSync(dir)) walk(dir);
    if (n) console.log(`[boot] 清扫 ${n} 个下载残片，释放 ${(freed / 1048576).toFixed(1)}MB`);
  } catch {
    /* 清理失败不能拖垮启动 */
  }
}
sweepTempFiles();

/** 浏览器宿主（Electron 主进程注入；直接 node 启动时为 null） */
let browserHost = null;
export function setBrowserHost(host) {
  browserHost = host;
}

const running = new Map(); // jobId -> {controller, promise, needResume}
const downloads = new Map(); // downloadId -> {controller}
const downloadTasks = new Map(); // taskId -> 批量下载任务状态
let automationCtx = null; // 外部自动化会话（占用内核时非 null）
let automationIdleAt = 0; // 最后一次使用时间
let captchaAlert = null; // 最近一次验证码告警 {at, reason, platform, jobId}
const AUTOMATION_IDLE_MS = 3 * 60 * 1000; // 空闲 3 分钟自动释放

/** 释放自动化会话（幂等） */
async function releaseAutomation() {
  const ctx = automationCtx;
  automationCtx = null;
  automationIdleAt = 0;
  if (ctx) {
    try {
      await ctx.closeTab();
    } catch {
      /* ignore */
    }
  }
}

// 定时巡检：空闲太久就释放，避免外部调用方忘了关导致内核永久被占
setInterval(() => {
  if (automationCtx && automationIdleAt && Date.now() - automationIdleAt > AUTOMATION_IDLE_MS) {
    console.log('[automation] 空闲超时，自动释放内核');
    releaseAutomation().catch(() => {});
  }
}, 30 * 1000).unref?.();
const runningCopy = new Map(); // 文案采集任务
const copyRoutes = new Map(); // 文案·评论·AI 路由表
const transcribeRoutes = new Map(); // 转写路由表
const subtitleRoutes = new Map();   // 字幕检测路由表

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

/** Webhook 推送：任务/下载事件主动通知外部软件（fire-and-forget，3s 超时） */
function pushWebhook(event, payload) {
  const url = settings.webhookUrl;
  if (!url) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Collector-Event': event },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    /* 通知失败不影响主流程 */
  });
}

/** 下载进度写库
 *  回调本身已节流到 120ms，但写 SQLite 是同步 IO，
 *  大文件时每次都写会明显拖慢下载，这里再按 500ms 落一次。 */
const _lastDlWrite = new Map();
function onProgressUpdate(db, dlId, p, phase) {
  const now = Date.now();
  const last = _lastDlWrite.get(dlId) || 0;
  if (now - last < 500) return;
  _lastDlWrite.set(dlId, now);
  // 只在记录仍是进行中时才写。取消/失败收尾后，下载器可能还有一次迟到的进度回调，
  // 无条件 UPDATE 会把 cancelled 又改回 downloading，下载中心就永远停在那一条上。
  db.prepare(
    `UPDATE downloads SET status = 'downloading', received = ?, total = ?, speed = ?, updated_at = ?
     WHERE id = ? AND status IN ('downloading','queued')`
  ).run(p.received || 0, p.total || 0, p.speed || 0, now, dlId);
}

/** 把底层技术错误翻译成人话（下载中心里显示给用户看） */
function humanizeDownloadError(msg) {
  const m = String(msg || '').trim();
  if (!m) return '未知错误';
  if (/已取消/.test(m)) return '已取消';
  // fetch 被 abort 时抛的是 DOMException，文案是英文且各 Node 版本不一样，
  // 不翻译的话下载中心会直接显示「This operation was aborted」。
  if (/AbortError|This operation was aborted|The operation was aborted|aborted/i.test(m)) {
    return '请求被中止（取消或超时）';
  }
  if (/\(-101\)|ERR_ABORTED|ERR_FAILED/i.test(m) && /bilibili\.com\/video|douyin\.com|xiaohongshu|kuaishou/i.test(m)) {
    return '视频页打不开（可能已被删除或下架）';
  }
  if (/\(-101\)/i.test(m)) return '页面加载失败（网络中断或链接失效）';
  if (/\(-3\)|ERR_ABORTED/i.test(m)) return '请求被中止';
  if (/\(-105\)|ERR_NAME_NOT_RESOLVED/i.test(m)) return '域名解析失败（检查网络）';
  if (/\(-118\)|ERR_CONNECTION_TIMED_OUT|timeout|超时/i.test(m)) return '连接超时（网络不稳或平台限流）';
  if (/数据停滞|连接停滞/.test(m)) return '连接停滞（CDN 中断传数据），已自动换源重试仍失败';
  if (/只收到|字节不符/.test(m)) return '分段下载不完整（网络不稳，重试即可）';
  if (/HTTP 403|deadline|过期/.test(m)) return '直链已过期（重试会重新取）';
  if (/HTTP 567/.test(m)) return '被 CDN 拒绝（缺请求头，重试一次常可）';
  if (/HTTP 404/.test(m)) return '资源不存在（视频可能已删除）';
  if (/流为空|只下到/.test(m)) return '下载中断（网络不稳，重试即可）';
  if (/Fresh cookies|需要登录|not necessary/.test(m)) return '登录态失效，去「内置浏览器」重新登录';
  // 抖音详情页被风控时页面只剩「视频数据加载中」，别误导成登录问题
  if (/验证码|安全验证|verifycenter|captcha/i.test(m)) return '触发平台验证码，去「内置浏览器」过一次验证';
  if (/core_dep|filter_reason/.test(m)) return '这条视频平台不给公开数据（受限/仅粉丝可见），换一条试试';
  if (/ffmpeg/i.test(m)) return '缺少 ffmpeg（合并音视频用）';
  // 兜底：截断但保留可读部分
  return m.length > 120 ? m.slice(0, 120) + '…' : m;
}

async function browserCookies() {
  if (!browserHost) return [];
  try {
    return await browserHost.getCookies();
  } catch {
    return [];
  }
}

async function loginStatus() {
  if (!browserHost) {
    return { browser: false, mode: 'none', platforms: [] };
  }
  const map = await browserHost.getLoginStatus();
  const notes = browserHost.getLoginNotes?.() || {};
  return {
    browser: true,
    mode: browserHost.mode,
    platforms: Object.keys(PLATFORM_META).map((id) => ({
      id,
      label: PLATFORM_META[id].label,
      loggedIn: !!map[id],
      note: notes[id] || '',
    })),
  };
}

/** 需要登录才能搜索的平台 */
const NEED_LOGIN = { douyin: true, xhs: true, kuaishou: true, bilibili: false };

/** 采集任务主体 */
async function startJob({ platform, keyword, target, resumeJobId }) {
  if (!browserHost) throw new Error('浏览器宿主未就绪，请从软件窗口启动');
  const jobId = resumeJobId || createJob(db, { platform, keyword, target });
  const controller = new AbortController();
  const record = { controller, needHuman: false };

  // 忙检查必须在 running.set 之前，否则批量任务的第二个永远撞上自己
  if (browserHost.isBusy?.() || running.size > 0) {
    updateJob(db, jobId, { status: 'error', message: '内核忙：等上一个任务结束再试' });
    const err = new Error('内核忙');
    err.code = 'BUSY';
    throw err;
  }

  // 登录预检：没登录不浪费一轮页面加载
  if (NEED_LOGIN[platform]) {
    try {
      const map = await browserHost.getLoginStatus();
      if (!map[platform]) {
        updateJob(db, jobId, {
          status: 'need_human',
          message: `${PLATFORM_META[platform].label} 未登录（或登录已过期）：请到「内置浏览器」扫码登录后点「继续」`,
        });
        record.needHuman = true;
        record.promise = Promise.resolve();
        return { jobId };
      }
    } catch {
      /* 检测失败不拦截，交给采集过程中的登录墙检测 */
    }
  }

  running.set(jobId, record);

  const promise = (async () => {
    updateJob(db, jobId, { status: 'running' });
    try {
      const result = await runCollect({
        platform,
        keyword,
        target,
        signal: controller.signal,
        // 恢复的任务（过完验证码/登录墙后继续的）自动进入谨慎模式，全部节奏放慢
        cautious: !!resumeJobId,
        createSession: () => browserHost.createCollectSession(),
        checkLogin: () => browserHost.getLoginStatus(),
        onCaptcha: async ({ reason, url }) => {
          // 把验证码搬到内置浏览器面板（用采集引擎在关闭会话前抓到的 URL）
          const r = await browserHost.bringCaptchaFront(url).catch(() => null);
          captchaAlert = {
            at: Date.now(),
            reason,
            platform,
            jobId,
            url: url || '',
            shownInPane: !!(r && r.ok),
            hint: r && r.ok ? '验证码已显示在「内置浏览器」面板里，完成后点下面按钮' : '验证码没能自动显示，请到「内置浏览器」手动打开该平台',
          };
          pushWebhook('captcha.required', { platform, jobId, reason });
        },
        onProgress: ({ status, message, found }) => {
          const patch = { message: message || '' };
          if (status) patch.status = status;
          if (typeof found === 'number') patch.found = found;
          updateJob(db, jobId, patch);
        },
        onItems: (items) => {
          for (const item of items) upsertItem(db, item);
        },
      });
      for (const item of result.items) upsertItem(db, item);
      const finalStatus = result.needHuman ? 'need_human' : 'done';
      updateJob(db, jobId, {
        status: finalStatus,
        found: result.items.length,
        // 保留采集引擎给出的具体原因（如「触发风控，验证页面已显示」），别用通用文案覆盖
        message: result.needHuman
          ? (result.message || '等待浏览器里完成登录/验证')
          : `完成，共 ${result.items.length} 条`,
      });
      record.needHuman = result.needHuman;
      record.result = result;
      pushWebhook('collect.done', { jobId, platform, keyword, found: result.items.length, status: 'done' });
    } catch (error) {
      if (String(error.message).includes('NEED_HUMAN')) {
        updateJob(db, jobId, { status: 'need_human', message: '出现验证码，请在浏览器里处理后继续' });
        record.needHuman = true;
        pushWebhook('collect.need_human', { jobId, platform, keyword });
      } else if (controller.signal.aborted) {
        updateJob(db, jobId, { status: 'cancelled', message: '已取消' });
      } else {
        updateJob(db, jobId, { status: 'error', message: error.message || String(error) });
        pushWebhook('collect.error', { jobId, platform, keyword, error: error.message });
      }
    } finally {
      running.delete(jobId);
      // 兜底：任务结束确保内核锁释放（防止异常路径漏放）
      if (!running.size && !automationCtx) browserHost?.forceRelease?.();
    }
  })();

  record.promise = promise;
  return { jobId };
}

/** 续跑：验证/登录完成后重开一轮采集（幂等，按 platform_id 去重） */
async function resumeJob(jobId) {
  const job = getJob(db, jobId);
  if (!job) throw new Error('任务不存在');
  // 复用原任务记录继续跑（不新建）
  updateJob(db, jobId, { status: 'running', message: '继续采集中' });
  return startJob({ platform: job.platform, keyword: job.keyword, target: job.target, resumeJobId: jobId });
}

/**
 * 单条补详情：开一个隐藏采集会话进详情页抓直链。
 * 返回 { detail, tab, base }，调用方负责 tab.closeTab() / base.destroy()。
 */
async function fetchDetailForItem(item, signal) {
  const adapter = getAdapter(item.platform);
  if (!adapter || !browserHost) return null;

  // 内核被采集任务/自动化会话占用时静默降级（后续走 yt-dlp 兜底）
  if (browserHost.isBusy?.()) return null;

  // 硬超时：页面 evaluate 的 CDP 路径超时后会回退到 executeJavaScript（无超时），
  // 页面 JS 一挂整个下载就跟着永远等。90s 内拿不到就放弃，回退存量直链/yt-dlp。
  const DETAIL_TIMEOUT_MS = 90000;
  let base = null;
  // 超时后必须能真正掐断 work：否则它继续跑、继续占着内核和标签页，
  // 下一个下载 createCollectSession 拿不到内核 → 整条队列卡死（实测卡过 372s）。
  const ctl = new AbortController();
  const ownSignal = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  // 超时后 work 若「后来成功」，返回的 tab/base 没人接手 → 在这里兜底销毁
  let abandoned = false;

  const work = (async () => {
    try {
      base = await browserHost.createCollectSession();
    } catch (error) {
      if (error.code === 'BUSY') return null;
      throw error;
    }
    // 会话建好时可能已经超时了，直接交还，别继续占用内核
    if (abandoned) {
      await base.closeTab?.().catch(() => {});
      await base.destroy?.().catch(() => {});
      return null;
    }
    let tab = base;
    let ok = false;
    try {
      if (adapter.detail) {
        const detail = await adapter.detail(tab, { ...item, page_url: item.page_url || '' });
        if (detail?.video_url) {
          ok = true;
          if (abandoned) {
            // 超时之后才拿到结果：调用方早已放弃，销毁资源别泄漏
            await tab.closeTab().catch(() => {});
            await base.destroy?.().catch(() => {});
            return null;
          }
          return { detail, tab, base };
        }
        return null;
      }
      const { collectOne } = await import('./lib/detail.mjs');
      const detail = await collectOne({ tab, adapter, item, signal: ownSignal });
      if (detail?.video_url) {
        ok = true;
        if (abandoned) {
          await tab.closeTab().catch(() => {});
          await base.destroy?.().catch(() => {});
          return null;
        }
        return { detail, tab, base };
      }
      return null;
    } finally {
      if (!ok) {
        await tab.closeTab().catch(() => {});
        await base.destroy?.().catch(() => {});
      }
    }
  })();
  // work 自己失败（不是超时）时别变成 unhandledRejection
  work.catch(() => {});

  let timerId = null;
  const timer = new Promise((resolve) => {
    timerId = setTimeout(() => resolve('TIMEOUT'), DETAIL_TIMEOUT_MS);
    timerId.unref?.();
  });
  const result = await Promise.race([work, timer]);
  clearTimeout(timerId);
  if (result === 'TIMEOUT') {
    abandoned = true;
    ctl.abort(); // 掐断在途的 evaluate/navigate，让 work 尽快退出来
    // 不 await work：它可能正卡在无超时的 executeJavaScript 里，await 会再卡 90s。
    // abandoned 标记 + 上面的销毁分支保证它脱身后自己清理。
    console.warn(`[detail] ${item.platform} ${item.platform_id} 现取直链超时 ${DETAIL_TIMEOUT_MS / 1000}s，回退存量直链`);
    return null;
  }
  return result;
}

/** 面板页发起的下载任务状态表（url → {status, percent, note}），注入按钮轮询显示进度 */
const paneDlRunning = new Map();

/**
 * 对「面板里某个视频详情页 URL」执行无水印下载（手动下载链路的核心）。
 * 内核忙时等上一小会再试（注入按钮的下载不该直接失败）。
 * @returns {{code, body}}
 */
async function downloadFromPaneUrl(pageUrl) {
  const platform = Object.keys(PLATFORM_META).find((k) => {
    const m = PLATFORM_META[k];
    try {
      return pageUrl.includes(new URL(m.homeUrl).hostname.replace('www.', ''));
    } catch {
      return false;
    }
  });
  if (!platform) return { code: 400, body: { error: '识别不了页面所属平台：' + (pageUrl.slice(0, 60) || '面板未打开页面') } };
  const detailish = /\/(video|explore|discovery\/item|short-video|note)\//.test(pageUrl);
  if (!detailish && platform !== 'bilibili') {
    return { code: 400, body: { error: '这不是视频详情页（像是首页/搜索页），进到某个视频再下' } };
  }

  // 内核忙（采集/下载补详情）→ 最多等 60 秒
  for (let i = 0; i < 30 && browserHost.isBusy?.(); i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (browserHost.isBusy?.()) return { code: 409, body: { error: 'BUSY', message: '采集任务运行中，稍后再试' } };

  let session = null;
  let dlRecId = null;
  try {
    const adapter = getAdapter(platform);
    const itemId = `${platform}_page_${Date.now().toString(36)}`;
    // platform_id 必须是真实作品号：详情接口要用它拼 aweme_id。
    // 面板下载场景拿到的是详情页 URL，从这里抽真 id（抽不到才退回占位符）。
    const realPlatformId =
      (pageUrl.match(/\/(?:video|note|explore|discovery\/item|short-video)\/([A-Za-z0-9]+)/) || [])[1] ||
      itemId;
    const item = {
      id: itemId,
      platform,
      platform_id: realPlatformId,
      keyword: '手动下载',
      title: '',
      desc: '',
      author: '',
      likes: 0,
      duration: 0,
      page_url: pageUrl,
      video_url: '',
      audio_url: '',
    };

    // 快路径：面板页已经在某个页面上，直接在页面上下文里调详情接口。
    // 实测只要 0.5s，而新建 CDP 会话 + 导航要十几秒——绝大多数情况走这里就够。
    let detail = null;
    if (platform === 'douyin' && realPlatformId && /^\d{15,25}$/.test(realPlatformId)) {
      const apiUrl =
        'https://www.douyin.com/aweme/v1/web/aweme/detail/' +
        `?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${realPlatformId}` +
        '&request_source=600&origin_source=600&update_version_code=170400' +
        '&pc_client_type=1&version_code=290100&version_name=29.1.0' +
        '&cookie_enabled=true&platform=PC&pc_libra_divert=Windows';
      const raw = await browserHost
        .paneEval(
          `(async () => {
            try {
              const r = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include', headers: { accept: 'application/json' } });
              const t = await r.text();
              return t.length > 80 ? t : '';
            } catch (e) { return ''; }
          })()`
        )
        .catch(() => '');
      if (raw) {
        const parsed = adapter.parseBody(String(raw), '手动下载');
        if (parsed.length && parsed[0].video_url) detail = parsed[0];
      }
    }

    // 慢路径：快路径没拿到（非抖音 / 接口被拦 / 页面不在抖音域）才建会话
    if (!detail?.video_url) {
      session = await browserHost.createPaneSession();
      if (adapter?.detail) {
        detail = await adapter.detail(session, item).catch(() => null);
      }
      if (!detail?.video_url) {
        const { collectOne } = await import('./lib/detail.mjs');
        detail = await collectOne({ tab: session, adapter, item, signal: null }).catch(() => null);
      }
    }
    if (!detail?.video_url) {
      return { code: 502, body: { error: '没能从页面拿到视频直链（页面可能还没加载完，或平台接口变了）' } };
    }

    const finalItem = {
      ...item,
      title: detail.title || item.title || '手动下载',
      desc: detail.desc || '',
      author: detail.author || '',
      likes: detail.likes || 0,
      duration: detail.duration || 0,
      video_url: detail.video_url,
      video_backups: detail.video_backups || [],
      audio_url: detail.audio_url || '',
      audio_backups: detail.audio_backups || [],
    };

    const saved = upsertItem(db, finalItem);
    const realId = saved?.id || itemId;

    const cookies = await browserCookies();
    // 已经下好过就直接返回，不再建新记录——连点按钮会攒出一串重复的下载行
    const prevDone = db
      .prepare("SELECT id, dest, received FROM downloads WHERE item_id = ? AND status = 'done' ORDER BY rowid DESC LIMIT 1")
      .get(realId);
    if (prevDone?.dest && fs.existsSync(prevDone.dest)) {
      return {
        code: 200,
        body: {
          ok: true,
          id: realId,
          title: finalItem.title,
          platform,
          path: prevDone.dest,
          size: prevDone.received || 0,
          engine: 'cache',
        },
      };
    }
    // 先建记录并置成 downloading，边下边写进度——否则下载中心整段时间都是空白，
    // 用户看不到速度和百分比，像是没启动。
    // createDownload 返回的就是 id 字符串（不是对象），别写成 dlRec.id
    dlRecId = createDownload(db, { itemId: realId, url: finalItem.video_url, engine: 'auto' });
    updateDownload(db, dlRecId, { status: 'downloading', engine: 'direct' });
    const result = await downloadItem({
      item: finalItem,
      outDir: settings.downloadDir,
      cookies,
      signal: AbortSignal.timeout(10 * 60 * 1000),
      onProgress: (p) => {
        updateDownload(db, dlRecId, {
          received: p.received || 0,
          total: p.total || 0,
          speed: p.speed || 0,
        });
      },
    });
    updateItem(db, realId, { status: 'done', local_path: result.path, local_size: result.size, error: '' });
    // 下载已经在这里同步做完了，记录必须直接落成 done。
    // 原来 createDownload 建出来是 queued 且没人接管 → 下载中心永远挂着一条「排队中」。
    updateDownload(db, dlRecId, {
      status: 'done',
      dest: result.path,
      received: result.size,
      total: result.size,
      engine: result.engine || 'auto',
    });
    return {
      code: 200,
      body: {
        ok: true,
        id: realId,
        title: finalItem.title,
        platform,
        path: result.path,
        size: result.size,
        engine: result.engine,
      },
    };
  } catch (error) {
    // 失败也要把这条下载记录收尾，否则会一直显示「下载中」
    if (dlRecId) {
      updateDownload(db, dlRecId, { status: 'error', error: humanizeDownloadError(error.message) });
    }
    return { code: 500, body: { error: error.message } };
  } finally {
    if (session) await session.closeTab().catch(() => {});
  }
}

/**
 * 启动一批素材下载（后台任务，多个并发 worker）。
 * /api/download 与「下载重试」共用这条链路。
 * @returns {{taskId, total}}
 */
async function startItemDownload(ids) {
  const cookies = await browserCookies();
  const queue = [...ids];
  const results = [];
  // 下载是 IO 等待型，并发拉高能显著提速；上限放到 10 防止把 CDN 惹毛
  const workers = Math.max(1, Math.min(settings.concurrency || 5, 10));
  const taskId = `dq-${Date.now().toString(36)}`;
  const task = { id: taskId, total: ids.length, done: 0, ok: 0, failed: 0, cancelled: 0, status: 'running', results, startedAt: Date.now() };
  downloadTasks.set(taskId, task);

  const runOne = async () => {
    while (queue.length) {
      const id = queue.shift();
      let item = getItem(db, id);
      if (!item) continue;
      const dlId = createDownload(db, { itemId: id, url: item.video_url || item.page_url, engine: 'auto' });
      const controller = new AbortController();
      downloads.set(dlId, { controller });
      let detailCtx = null;

      try {
        // 直链带 deadline 会过期（抖音几小时就 403），凡有页面地址就现取新鲜直链。
        // 之前只有 video_url 为空才取，结果存量链接过期后「重试」永远拿旧 403 链接，
        // 错误文案写着「重试会重新取」实际却不取——就是在这里补上的。
        if (item.page_url) {
          updateDownload(db, dlId, { status: 'downloading', engine: 'detail' });
          detailCtx = await fetchDetailForItem(item, controller.signal);
          if (detailCtx?.detail) {
            const fresh = detailCtx.detail;
            updateItem(db, id, {
              video_url: fresh.video_url || '',
              audio_url: fresh.audio_url || '',
              author: fresh.author || item.author,
              likes: fresh.likes || item.likes,
              duration: fresh.duration || item.duration,
              desc: fresh.desc || item.desc,
              extra: fresh.extra || item.extra,
            });
            item = getItem(db, id);
          }
        }
        // 候选链不落库：凡有详情上下文，用新鲜直链+备用源覆盖本次下载
        if (detailCtx?.detail) {
          const fresh = detailCtx.detail;
          item = {
            ...item,
            video_url: fresh.video_url || item.video_url,
            video_backups: fresh.video_backups || [],
            audio_url: fresh.audio_url || item.audio_url,
            audio_backups: fresh.audio_backups || [],
          };
        }

        const inPageFetch = detailCtx?.tab
          ? async (url, phase) => {
              const buf = await detailCtx.tab.fetchBinaryInPage(url, {
                onProgress: (p) => onProgressUpdate(db, dlId, p, phase),
              });
              return buf;
            }
          : null;

        const result = await downloadItem({
          item,
          outDir: settings.downloadDir,
          cookies,
          signal: controller.signal,
          inPageFetch,
          onProgress: (p) => onProgressUpdate(db, dlId, p, p.phase),
        });
        updateDownload(db, dlId, { status: 'done', dest: result.path, received: result.size, total: result.size, engine: result.engine });
        updateItem(db, id, { status: 'done', local_path: result.path, local_size: result.size, error: '' });
        results.push({ id, ok: true, path: result.path, engine: result.engine });
        task.ok += 1;
        task.done += 1;
      } catch (error) {
        // 用户点了取消 → controller 已 abort，abort 会让下载抛错。
        // 这里不能一律记成 error，否则 cancel 路由刚写下的 cancelled 立刻被覆盖，
        // 下载中心显示「失败」而不是「已取消」。
        if (controller.signal.aborted) {
          updateDownload(db, dlId, { status: 'cancelled', error: '已取消' });
          updateItem(db, id, { status: 'cancelled', error: '已取消' });
          results.push({ id, ok: false, cancelled: true, error: '已取消' });
          task.cancelled = (task.cancelled || 0) + 1;
          task.done += 1;
        } else {
          const friendly = humanizeDownloadError(error.message);
          updateDownload(db, dlId, { status: 'error', error: friendly });
          updateItem(db, id, { status: 'error', error: friendly });
          results.push({ id, ok: false, error: friendly });
          task.failed += 1;
          task.done += 1;
        }
      } finally {
        if (detailCtx) {
          await detailCtx.tab.closeTab().catch(() => {});
          await detailCtx.base.destroy?.().catch(() => {});
        }
        downloads.delete(dlId);
      }
    }
  };

  Promise.all(Array.from({ length: workers }, runOne))
    .then(() => {
      task.status = 'done';
      task.finishedAt = Date.now();
      pushWebhook('download.done', { taskId, total: ids.length, ok: task.ok, failed: task.failed, results });
    })
    .catch((error) => {
      task.status = 'error';
      task.error = error.message;
    });

  return { taskId, total: ids.length };
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  // 转写路由
  const trHandler = transcribeRoutes.get(`${method} ${route}`);
  if (trHandler) return await trHandler(req, res, url);

  // 字幕检测路由
  const subHandler = subtitleRoutes.get(`${method} ${route}`);
  if (subHandler) return await subHandler(req, res, url);

  // 文案·评论·AI 路由（copy-api.mjs 挂载）
  const copyHandler = copyRoutes.get(`${method} ${route}`);
  if (copyHandler) return await copyHandler(req, res, url);

  if (method === 'GET' && route === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      browser: !!browserHost,
      mode: browserHost?.mode || 'none',
      platforms: PLATFORMS,
      settings,
      stats: stats(db),
    });
  }

  /* ==================== 外部软件接入（自动化服务） ====================
   * 本机 127.0.0.1 上的其它软件可直接调用，复用内置浏览器的登录态：
   *   GET  /api/automation/status   内核是否空闲
   *   POST /api/automation/eval     {url?, script} 打开页面并执行 JS，返回结果
   *   POST /api/automation/navigate {url}           仅导航
   *   GET  /api/automation/cookies?domain=douyin.com 导出指定域登录态
   *   POST /api/automation/close                    释放内核
   * 约定：内核同一时间只服务一个会话，忙时返回 409 {error:'BUSY'}
   */
  // 界面轮询：是否有验证码待处理
  if (method === 'GET' && route === '/api/captcha/alert') {
    const fresh = captchaAlert && Date.now() - captchaAlert.at < 10 * 60 * 1000;
    const passed = browserHost?.consumeCaptchaPassed?.() || false;
    if (passed && captchaAlert) {
      captchaAlert.passed = true;
    }
    return sendJson(res, 200, { alert: fresh ? captchaAlert : null, passed });
  }

  // 用户点「我已通过验证」：清告警 + 收回任务窗口 + 可选自动继续原任务
  if (method === 'POST' && route === '/api/captcha/done') {
    const body = await readBody(req);
    const prev = captchaAlert;
    captchaAlert = null;
    browserHost?.hideTaskWindowBack?.();
    browserHost?.stopCaptchaWatcher?.();

    // 自动继续：把之前因验证码中断的任务重新跑一遍（按 platform_id 幂等去重，不会重复）
    let resumed = null;
    if (body.autoResume !== false && prev?.jobId && prev?.platform) {
      const job = getJob(db, prev.jobId);
      if (job && job.status === 'need_human') {
        try {
          if (browserHost.isBusy?.()) {
            // 内核可能还被旧会话占着，等一下再放
            setTimeout(() => {
              resumeJob(prev.jobId).catch(() => {});
            }, 3000);
          } else {
            await resumeJob(prev.jobId);
          }
          resumed = prev.jobId;
        } catch {
          /* 自动继续失败就让用户手动点 */
        }
      }
    }
    return sendJson(res, 200, { ok: true, resumed });
  }

  /* ---------- 面板诊断 ---------- */

  if (method === 'GET' && route === '/api/pane/text') {
    if (!browserHost?.paneText) return sendJson(res, 404, { error: '无' });
    return sendJson(res, 200, await browserHost.paneText());
  }

  // 在内置浏览器面板页面执行 JS（下载按钮进度回显用；面板没开页面时报错）
  if (method === 'POST' && route === '/api/browser/eval') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    const body = await readBody(req);
    const js = String(body.js || '');
    if (!js) return sendJson(res, 400, { error: '缺少 js' });
    try {
      const out = await browserHost.paneEval(js);
      return sendJson(res, 200, { ok: true, result: out });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  // 自检：在主界面窗口里执行 JS（读界面渲染结果用，临时开启，测完注释掉）
  // if (method === 'POST' && route === '/api/debug/ui') {
  //   if (!browserHost?.mainEval) return sendJson(res, 500, { error: '不支持' });
  //   const body = await readBody(req);
  //   try {
  //     const out = await browserHost.mainEval(String(body.js || '1'));
  //     return sendJson(res, 200, { ok: true, result: out });
  //   } catch (error) {
  //     return sendJson(res, 500, { error: error.message });
  //   }
  // }

  if (method === 'GET' && route === '/api/pane/shot') {
    if (!browserHost?.paneScreenshot) {
      res.writeHead(404).end();
      return;
    }
    const b64 = await browserHost.paneScreenshot();
    if (!b64) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(b64, 'base64'));
    return;
  }

  /* ---------- 验证码辅助 ---------- */

  // 检测当前是否有验证码弹窗，有则返回类型和位置（供界面提示）
  if (method === 'GET' && route === '/api/captcha/probe') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    try {
      const info = await browserHost.probeCaptcha();
      return sendJson(res, 200, info);
    } catch (error) {
      return sendJson(res, 200, { found: false, error: error.message });
    }
  }

  // 把验证码页面顶到用户面前（切到内置浏览器视图 + 显示面板）
  if (method === 'POST' && route === '/api/captcha/bring-front') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    const body = await readBody(req);
    try {
      const r = await browserHost.bringCaptchaFront(body.url || captchaAlert?.url || '');
      return sendJson(res, 200, r);
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  // 计算滑块缺口位置（返回 x，供界面画参考线；不做自动拖动）
  if (method === 'POST' && route === '/api/captcha/solve') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    try {
      const r = await browserHost.solveCaptchaOffset();
      return sendJson(res, 200, r);
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message });
    }
  }

  // 手动释放内核（界面「内核忙」时可点）
  if (method === 'POST' && route === '/api/kernel/release') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    await releaseAutomation();
    browserHost.forceRelease?.();
    running.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && route === '/api/automation/status') {
    return sendJson(res, 200, {
      ok: true,
      busy: !browserHost
        ? true
        : running.size > 0 || (!!automationCtx && Date.now() - automationIdleAt < AUTOMATION_IDLE_MS),
      reason: running.size > 0
        ? '采集任务运行中'
        : automationCtx && Date.now() - automationIdleAt < AUTOMATION_IDLE_MS
          ? '自动化会话占用中'
          : '',
    });
  }

  if (method === 'POST' && route === '/api/automation/eval') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    if (running.size > 0) return sendJson(res, 409, { error: 'BUSY', message: '采集任务运行中' });
    const body = await readBody(req);
    const script = String(body.script || '');
    if (!script) return sendJson(res, 400, { error: 'script 不能为空' });
    try {
      if (!automationCtx) automationCtx = await browserHost.createCollectSession();
      automationIdleAt = Date.now();
      if (body.url) await automationCtx.navigate(String(body.url), Number(body.navigateTimeoutMs) || 30000);
      const result = await Promise.race([
        automationCtx.evaluate(script),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('脚本执行超时')), Number(body.timeoutMs) || 30000)
        ),
      ]);
      automationIdleAt = Date.now();
      return sendJson(res, 200, { ok: true, result });
    } catch (error) {
      if (String(error.message).includes('超时') || error.code === 'BUSY') {
        await releaseAutomation();
      }
      return sendJson(res, error.status || 500, { error: error.message });
    }
  }

  if (method === 'POST' && route === '/api/automation/navigate') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    if (running.size > 0) return sendJson(res, 409, { error: 'BUSY', message: '采集任务运行中' });
    const body = await readBody(req);
    try {
      if (!automationCtx) automationCtx = await browserHost.createCollectSession();
      automationIdleAt = Date.now();
      await automationCtx.navigate(String(body.url || 'about:blank'), 30000);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message });
    }
  }

  if (method === 'GET' && route === '/api/automation/cookies') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    const domain = url.searchParams.get('domain') || '';
    try {
      const all = await browserHost.getCookies(domain ? [`https://${domain}`] : undefined);
      const filtered = domain ? all.filter((c) => c.domain === domain || c.domain === '.' + domain || c.domain?.endsWith('.' + domain)) : all;
      return sendJson(res, 200, {
        ok: true,
        count: filtered.length,
        cookies: filtered.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expirationDate || c.expires, secure: c.secure })),
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (method === 'POST' && route === '/api/automation/close') {
    await releaseAutomation();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && route === '/api/docs') {
    return sendJson(res, 200, {
      name: '素材采集器 API',
      note: '仅监听 127.0.0.1，供本机其它软件调用；内核同一时间只服务一个会话，忙时 409 BUSY',
      events: {
        webhook: 'settings.webhookUrl 配置后，任务事件 POST 过去（collect.done / collect.need_human / collect.error / copy.done / copy.error / download.done）',
      },
      endpoints: {
        'GET /api/health': '内核模式与素材统计',
        'GET /api/login-status': '四平台登录状态',
        'POST /api/jobs': '视频采集 {platform, keywords[], target} → {jobIds}',
        'GET /api/jobs': '任务列表；?id= 单任务',
        'POST /api/jobs/resume|cancel': '继续/取消 {jobId}',
        'GET /api/items': '视频素材 ?platform=&keyword=&status=&q=&sort=&limit=&offset=',
        'POST /api/download': '批量下载 {ids[]} → {taskId}，轮询 GET /api/download/task?id=',
        'GET /api/downloads': '下载记录',
        'POST /api/copy/jobs': '文案采集 {platform, keywords[], target, withComments}',
        'GET /api/copy/jobs': '文案任务列表',
        'GET /api/copies': '文案列表 ?platform=&keyword=&q=&sort=likes',
        'GET /api/comments': '评论列表 ?targetId=&platform=&minLikes=&sort=likes',
        'POST /api/ai/run': 'AI 加工 {action: rewrite|imitate|hooks|commentSummary|script|speechPoints|speechScript|custom, ids[]|targetId|transcriptIds[], theme?, customPrompt?}',
        'GET /api/ai/config | POST /api/ai/config': 'AI 接口配置（OpenAI 兼容）',
        'POST /api/ai/test | GET /api/ai/models': '测试连接 / 拉模型列表',
        'POST /api/transcribe': '发起转写 {scope:pending|audio|platform|ids, platform?, limit?, ids?, language?, model?, audioOnly?, dropAfter?} → {taskId}',
        'GET /api/transcribe/status': '转写服务状态（device/compute/model/待转写数）',
        'GET /api/transcribe/task': '?id= 转写任务进度（含 current/audioBytes）',
        'GET /api/transcribe/pending': '?platform=&audioOnly=1 待转写素材数（audioOnly 含未下载）',
        'POST /api/transcribe/restart': '重启 Python 转写服务',
        'GET /api/transcriptions': '转写结果列表 ?platform=&q=&limit=&offset=',
        'GET /api/transcriptions/get': '?id= 单条详情（含 segments 时间轴）',
        'GET /api/transcriptions/srt | /txt': '?id= 导出 SRT 字幕 / 纯文本',
        'GET /api/automation/status': '内核是否空闲',
        'POST /api/automation/eval': '自动化 {url?, script} 在任务窗口执行 JS，返回结果',
        'GET /api/automation/cookies': '?domain=xx.com 导出登录 cookie',
        'POST /api/automation/close': '释放内核',
        'GET /api/docs': '本文档',
      },
      platforms: { douyin: '抖音（需登录）', xhs: '小红书（需登录）', bilibili: 'B站（可不登录）', kuaishou: '快手（需登录）' },
    });
  }

  if (method === 'GET' && route === '/api/login-status') {
    const result = await loginStatus();
    if (result.browser && result.platforms) {
      const map = Object.fromEntries(result.platforms.map((p) => [p.id, p.loggedIn]));
      const events = loginGuard.onLoginStatus(map, path.join(__dirname, 'data', 'login-backup'));
      if (events.lost?.length) {
        result.lost = events.lost;
        result.canRestore = !!events.canRestore;
      }
      // 登录成功（从未登录→已登录）：自动恢复该平台卡在 need_human 的任务，不用人点「继续」
      if (events.backup) {
        const stuck = listJobs(db).filter(
          (j) => j.platform === events.backup && j.status === 'need_human'
        );
        if (stuck.length) {
          const job = stuck[0]; // 一次恢复一个，跑完再看下一个
          setTimeout(() => {
            resumeJob(job.id).catch(() => {});
          }, 2500);
          result.autoResumedJob = job.id;
        }
      }
      if (events.backup) {
        result.backuped = events.backup;
        await loginGuard.doBackup(path.join(__dirname, 'data', 'login-backup')).catch(() => {});
        lastBackupAt = now();
      } else if (result.platforms.some((p) => p.loggedIn) && now() - lastBackupAt > 10 * 60 * 1000) {
        // 已登录期间每 10 分钟例行备份（cookie 续期也能保住）
        await loginGuard.doBackup(path.join(__dirname, 'data', 'login-backup')).catch(() => {});
        lastBackupAt = now();
      }
    }
    return sendJson(res, 200, result);
  }

  // 一键恢复登录态（session API 直接写回，无需重启）
  if (method === 'POST' && route === '/api/login/restore') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动' });
    const r = await loginGuard.doRestore(path.join(__dirname, 'data', 'login-backup'));
    return sendJson(res, 200, r);
  }

  if (method === 'GET' && route === '/api/login/has-backup') {
    return sendJson(res, 200, { has: loginGuard.hasBackup() });
  }

  /**
   * 下载内置浏览器「当前页」的视频（用户手动刷到的视频，一键无水印下载）。
   * 流程：识别平台 → 在面板会话里跑现有去水印详情逻辑（collectOne / adapter.detail）
   *      → 拿无水印直链 → downloadItem 正常下载入库（含旁车元信息）。
   * 内核忙（采集任务进行中）时返回 409。
   */
  if (method === 'POST' && route === '/api/page/download') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    if (browserHost.isBusy?.()) return sendJson(res, 409, { error: 'BUSY', message: '采集任务运行中，等任务结束再试' });

    const pageUrl = (await browserHost.paneState()).url || '';
    const r = await downloadFromPaneUrl(pageUrl);
    return sendJson(res, r.code, r.body);
  }

  /**
   * 面板页面上注入按钮发起的下载请求队列：
   * 轮询取走 window.__dlRequests → 逐个走无水印下载。
   * 返回每个请求的下载任务状态（前端按钮据此显示进度）。
   */
  if (method === 'GET' && route === '/api/page/dl-requests') {
    if (!browserHost?.takePaneDlRequests) return sendJson(res, 200, { items: [] });
    const reqs = await browserHost.takePaneDlRequests();
    const results = [];
    for (const rq of reqs.slice(0, 3)) { // 一轮最多处理 3 个，防堆积
      if (paneDlRunning.has(rq.url)) {
        results.push({ url: rq.url, status: paneDlRunning.get(rq.url) });
        continue;
      }
      // 后台跑，不阻塞轮询
      paneDlRunning.set(rq.url, { status: 'working', percent: 0, startedAt: Date.now() });
      // 超时兜底：等内核/等验证码时可能长时间没结果，
      // 不给上限的话按钮会永远显示「解析中」，看着像卡死。
      const PANE_DL_TIMEOUT_MS = 3 * 60 * 1000;
      const guard = setTimeout(() => {
        const cur = paneDlRunning.get(rq.url);
        if (cur && cur.status === 'working') {
          paneDlRunning.set(rq.url, {
            status: 'error',
            percent: 0,
            note: '超时未完成（可能在内核排队或触发验证码），稍后重试',
          });
          setTimeout(() => paneDlRunning.delete(rq.url), 60 * 1000);
        }
      }, PANE_DL_TIMEOUT_MS);
      guard.unref?.();
      downloadFromPaneUrl(rq.url)
        .then((r) => {
          clearTimeout(guard);
          paneDlRunning.set(rq.url, {
            status: r.code === 200 ? 'done' : 'error',
            percent: 100,
            note: r.code === 200 ? (r.body.title || '') : (r.body.error || '失败'),
            id: r.body.id,
          });
          // 成功保留 5 分钟（显示 ✓ 已下载）；失败保留 2 分钟后恢复可点
          setTimeout(() => paneDlRunning.delete(rq.url), r.code === 200 ? 5 * 60 * 1000 : 2 * 60 * 1000);
        })
        .catch((e) => {
          clearTimeout(guard);
          paneDlRunning.set(rq.url, { status: 'error', percent: 0, note: e.message });
          setTimeout(() => paneDlRunning.delete(rq.url), 60 * 1000);
        });
      results.push({ url: rq.url, status: 'queued' });
    }
    // 附上所有进行中/已完成的状态
    const states = [];
    for (const [url, st] of paneDlRunning) states.push({ url, ...st });
    return sendJson(res, 200, { items: results, states });
  }

  if (method === 'POST' && route === '/api/browser/open') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    const body = await readBody(req);
    const platform = body.platform;
    const url = body.url || (platform && PLATFORM_META[platform] ? PLATFORM_META[platform].homeUrl : 'about:blank');
    // 只加载，不挂载视图——是否显示由界面决定，避免盖住功能页
    const r = await browserHost.paneNavigate(url);
    return sendJson(res, 200, { ok: true, url, visible: r?.visible === true });
  }

  // 内嵌浏览器面板控制
  if (method === 'POST' && route === '/api/browser/show') {
    if (!browserHost) return sendJson(res, 500, { error: '请从软件窗口启动（Electron）' });
    const body = await readBody(req);
    const r = browserHost.showPane(body.rect || { x: 0, y: 0, width: 100, height: 100 }, body.url || '');
    return sendJson(res, 200, r || { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/bounds') {
    const body = await readBody(req);
    browserHost.setBounds(body.rect || {});
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/hide') {
    browserHost?.hidePane();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/navigate') {
    const body = await readBody(req);
    await browserHost.paneNavigate(String(body.url || 'about:blank'));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/back') {
    browserHost?.paneBack();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/forward') {
    browserHost?.paneForward();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/browser/reload') {
    browserHost?.paneReload();
    return sendJson(res, 200, { ok: true });
  }

  // 「看任务画面」：任务窗口截图（隐藏窗口不遮挡，画面投到面板里）
  if (method === 'GET' && route === '/api/task/shot') {
    if (!browserHost?.taskScreenshot) {
      res.writeHead(404).end();
      return;
    }
    const b64 = await browserHost.taskScreenshot();
    if (!b64) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(b64, 'base64'));
    return;
  }

  if (method === 'POST' && route === '/api/browser/mute') {
    if (!browserHost?.setUserPaneMuted) return sendJson(res, 500, { error: '请从软件窗口启动' });
    const body = await readBody(req);
    return sendJson(res, 200, browserHost.setUserPaneMuted(!!body.muted));
  }

  if (method === 'GET' && route === '/api/browser/state') {
    return sendJson(res, 200, browserHost ? browserHost.paneState() : { visible: false, url: '', title: '' });
  }

  if (method === 'POST' && route === '/api/jobs') {
    const body = await readBody(req);
    const platform = String(body.platform || '');
    const keywords = Array.isArray(body.keywords)
      ? body.keywords
      : String(body.keyword || '').split('\n');
    const list = keywords.map((k) => String(k).trim()).filter(Boolean);
    if (!PLATFORM_META[platform]) return sendJson(res, 400, { error: '未知平台' });
    if (!list.length) return sendJson(res, 400, { error: '关键词不能为空' });
    const target = Math.min(Number(body.target) || settings.defaultTarget, 500);
    const ids = [];
    const skipped = [];
    try {
      for (const keyword of list) {
        const dup = db
          .prepare(
            "SELECT id FROM jobs WHERE platform = ? AND keyword = ? AND status IN ('pending','running','need_human') ORDER BY created_at DESC LIMIT 1"
          )
          .get(platform, keyword);
        if (dup) {
          skipped.push({ keyword, jobId: dup.id });
          continue;
        }
        const { jobId } = await startJob({ platform, keyword, target });
        ids.push(jobId);
      }
    } catch (error) {
      if (error.code === 'BUSY') {
        return sendJson(res, 409, { error: 'BUSY', message: '上一个任务还没跑完（或内核被占用），稍后再试' });
      }
      throw error;
    }
    return sendJson(res, 200, {
      ok: true,
      jobIds: ids,
      skipped,
      message: skipped.length ? `${skipped.length} 个关键词已有进行中任务，已跳过` : '',
    });
  }

  if (method === 'GET' && route === '/api/jobs') {
    if (url.searchParams.get('id')) {
      const job = getJob(db, url.searchParams.get('id'));
      return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: '任务不存在' });
    }
    return sendJson(res, 200, { jobs: listJobs(db) });
  }

  if (method === 'POST' && route === '/api/jobs/resume') {
    const body = await readBody(req);
    const { jobId } = await resumeJob(String(body.jobId || ''));
    return sendJson(res, 200, { ok: true, jobId });
  }

  if (method === 'POST' && route === '/api/jobs/cancel') {
    const body = await readBody(req);
    const id = String(body.jobId || '');
    const rec = running.get(id);
    if (rec) rec.controller.abort();
    updateJob(db, id, { status: 'cancelled', message: '已取消' });
    return sendJson(res, 200, { ok: true });
  }

  // 现取直链（B站直链带 deadline 会过期；预览前调这个刷新）
  if (method === 'GET' && route === '/api/items/fresh-url') {
    const id = url.searchParams.get('id') || '';
    const item = getItem(db, id);
    if (!item) return sendJson(res, 404, { error: '条目不存在' });
    if (item.platform !== 'bilibili') {
      return sendJson(res, 200, { ok: true, video_url: item.video_url, fresh: false });
    }
    if (browserHost?.isBusy?.()) return sendJson(res, 409, { error: 'BUSY', message: '内核忙，稍后再试' });
    const ctx = await fetchDetailForItem(item, null);
    if (!ctx?.detail?.video_url) return sendJson(res, 200, { ok: false, error: '没能取到新鲜直链' });
    updateItem(db, id, { video_url: ctx.detail.video_url, audio_url: ctx.detail.audio_url || '' });
    await ctx.tab.closeTab().catch(() => {});
    await ctx.base.destroy?.().catch(() => {});
    return sendJson(res, 200, { ok: true, video_url: ctx.detail.video_url, fresh: true });
  }

  if (method === 'GET' && route === '/api/items') {
    const q = url.searchParams;
    const result = queryItems(db, {
      platform: q.get('platform') || '',
      keyword: q.get('keyword') || '',
      status: q.get('status') || '',
      subtitle: q.get('subtitle') || '',
      q: q.get('q') || '',
      sort: q.get('sort') || 'new',
      limit: Math.min(Number(q.get('limit')) || 100, 500),
      offset: Number(q.get('offset')) || 0,
    });
    return sendJson(res, 200, { ...result, settings });
  }

  if (method === 'GET' && route === '/api/keywords') {
    return sendJson(res, 200, { keywords: keywordsOf(db) });
  }

  if (method === 'POST' && route === '/api/download') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return sendJson(res, 400, { error: '没有选中素材' });
    const started = await startItemDownload(ids);
    return sendJson(res, 200, { ok: true, taskId: started.taskId, total: started.total });
  }

  if (method === 'GET' && route === '/api/download/task') {
    const id = url.searchParams.get('id') || '';
    const task = downloadTasks.get(id);
    if (!task) return sendJson(res, 404, { error: '任务不存在' });
    return sendJson(res, 200, task);
  }

  if (method === 'GET' && route === '/api/downloads') {
    return sendJson(res, 200, { downloads: listDownloads(db) });
  }

  if (method === 'POST' && route === '/api/download/cancel') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const rec = downloads.get(id);
    if (rec) rec.controller.abort();
    updateDownload(db, id, { status: 'cancelled' });
    return sendJson(res, 200, { ok: true });
  }

  /** 重试失败的下载：把 item 状态复位后重新走一次下载队列 */
  if (method === 'POST' && route === '/api/download/retry') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : [];
    if (!ids.length) return sendJson(res, 400, { error: '没有要重试的下载' });
    // 找到这些下载对应的 item，校验存在
    const itemIds = [];
    for (const dlId of ids) {
      const dl = db.prepare('SELECT item_id, status FROM downloads WHERE id = ?').get(dlId);
      if (dl && dl.item_id && ['error', 'cancelled'].includes(dl.status)) itemIds.push(dl.item_id);
    }
    if (!itemIds.length) return sendJson(res, 400, { error: '没有可重试的（只有失败/取消的能重试）' });
    const started = await startItemDownload(itemIds);
    return sendJson(res, 200, { ok: true, taskId: started.taskId, total: started.total });
  }

  /** 清理已完成的下载记录（只删 downloads 行，不动文件） */
  if (method === 'POST' && route === '/api/download/clear-done') {
    const body = await readBody(req).catch(() => ({}));
    // includeError=1 时连失败/中断记录一起清
    const sql = body?.includeError
      ? "DELETE FROM downloads WHERE status IN ('done','cancelled','error')"
      : "DELETE FROM downloads WHERE status IN ('done','cancelled')";
    const info = db.prepare(sql).run();
    return sendJson(res, 200, { ok: true, cleared: info.changes });
  }

  if (method === 'GET' && route === '/api/settings') {
    return sendJson(res, 200, settings);
  }

  if (method === 'POST' && route === '/api/settings') {
    const body = await readBody(req);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (body[key] !== undefined) {
        settings[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(body[key]) : body[key];
      }
    }
    saveSettings();
    return sendJson(res, 200, settings);
  }

  if (method === 'POST' && route === '/api/reveal') {
    const body = await readBody(req);
    const target = String(body.path || settings.downloadDir);
    const { spawn } = await import('node:child_process');
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    return sendJson(res, 200, { ok: true });
  }

  // 视频预览代理：抖音/快手/小红书 CDN 有防盗链，页面 <video> 直连黑屏。
  // 后端带 Referer/cookie 转发，支持 Range（可拖动进度条）
  if (method === 'GET' && route === '/api/proxy/video') {
    const targetUrl = url.searchParams.get('url') || '';
    const platform = url.searchParams.get('platform') || '';
    if (!/^https?:\/\//i.test(targetUrl)) {
      res.writeHead(400).end('bad url');
      return;
    }
    try {
      const cookies = await browserCookies();
      const cookieHeader = cookies
        .filter((c) => !c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const pageReferer = PLATFORM_META[platform]?.homeUrl || new URL(targetUrl).origin + '/';
      const headers = {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        referer: pageReferer,
        accept: '*/*',
      };
      if (cookieHeader) headers.cookie = cookieHeader;
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(60000) });
      if (!upstream.ok && upstream.status !== 206) {
        res.writeHead(upstream.status).end();
        return;
      }
      const outHeaders = {
        'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      const cr = upstream.headers.get('content-range');
      const cl = upstream.headers.get('content-length');
      if (cr) outHeaders['Content-Range'] = cr;
      if (cl) outHeaders['Content-Length'] = cl;
      res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders);
      const { Readable } = await import('node:stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502).end(error.message);
    }
    return;
  }

  // 封面代理：抖音/小红书/B站的图床都有防盗链，直接 <img src> 会被 403
  if (method === 'GET' && route === '/api/proxy/image') {
    const targetUrl = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(targetUrl)) return sendJson(res, 400, { error: '地址不合法' });
    try {
      const headers = {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      };
      try {
        headers.referer = new URL(targetUrl).origin + '/';
      } catch {
        /* ignore */
      }
      const upstream = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) {
        res.writeHead(upstream.status).end();
        return;
      }
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
    } catch (error) {
      res.writeHead(502).end(error.message);
    }
    return;
  }

  if (method === 'GET' && route === '/api/export') {
    const rows = queryItems(db, { limit: 5000 }).rows;
    const csv = [
      ['平台', '标题', '文案', '话题', 'BGM', '作者', '点赞', '时长秒', '关键词', '原链接', '本地文件'].join(','),
      ...rows.map((r) =>
        [
          PLATFORM_META[r.platform]?.label || r.platform,
          r.title,
          r.desc,
          r.tags,
          r.music,
          r.author,
          r.likes,
          r.duration,
          r.keyword,
          r.page_url,
          r.local_path,
        ]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      ),
    ].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="materials.csv"',
    });
    return res.end('\ufeff' + csv);
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/** 本地视频流（支持 Range，用于素材库预览） */
async function serveMedia(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = filePath.toLowerCase();
  const type = ext.endsWith('.mp4') ? 'video/mp4'
    : ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg'
    : ext.endsWith('.png') ? 'image/png'
    : ext.endsWith('.webp') ? 'image/webp'
    : 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname.startsWith('/media/')) {
      const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
      const full = path.resolve(rel);
      // 只允许读下载目录下的文件
      const allowed = path.resolve(settings.downloadDir);
      if (!full.startsWith(allowed)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      return await serveMedia(req, res, full);
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(WEB_DIR, filePath);
    if (!full.startsWith(WEB_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const ext = path.extname(full);
    const data = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件不存在');
      return;
    }
    if (error instanceof CdpError) {
      return sendJson(res, error.status || 500, { error: error.message, code: error.code });
    }
    sendJson(res, 500, { error: error.message || String(error) });
  }
});

async function findPort(start) {
  for (let p = start; p < start + 20; p += 1) {
    const free = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(p, HOST);
    });
    if (free) return p;
  }
  return start;
}

// 挂载转写接口（实现全在 lib/transcribe.mjs，这里只注入依赖）
mountTranscribe({
  app: {
    sendJson,
    readBody,
    route: (m, p, h) => transcribeRoutes.set(`${m} ${p}`, h),
  },
  db,
  settings,
  pushWebhook,
  getItem: (id) => getItem(db, id),
  updateItem: (id, patch) => updateItem(db, id, patch),
  getFreshDetail: fetchDetailForItem,
  getCookies: browserCookies,
  getOutDir: () => settings.downloadDir,
});

/* ---------- 字幕检测（抽帧判硬字幕，只拉小样不占空间） ---------- */
const subtitleTasks = new Map(); // taskId -> 进度
const subtitleAbort = new Map(); // taskId -> AbortController

mountSubtitleApi({
  app: {
    sendJson,
    readBody,
    route: (m, p, h) => subtitleRoutes.set(`${m} ${p}`, h),
  },
  db,
  settings,
  pushWebhook,
  tasks: subtitleTasks,
  aborts: subtitleAbort,
  getItem: (id) => getItem(db, id),
  updateItem: (id, patch) => updateItem(db, id, patch),
  getFreshDetail: fetchDetailForItem,
  getCookies: browserCookies,
});

// 挂载文案·评论·AI 接口
mountCopyApi({
  app: {
    sendJson,
    readBody,
    route: (m, p, h) => copyRoutes.set(`${m} ${p}`, h),
  },
  db,
  settings,
  saveSettings,
  runningCopy,
  getBrowserHost: () => browserHost,
  pushWebhook,
  onCaptchaAlert: (info) => {
    captchaAlert = { at: Date.now(), ...info };
    pushWebhook('captcha.required', info);
  },
});

/** 启动 HTTP 服务；Electron 主进程与命令行直跑都会用 */
export async function startServer() {
  const port = await findPort(BASE_PORT);
  await new Promise((resolve) => server.listen(port, HOST, resolve));
  console.log(`素材采集器 · http://${HOST}:${port}`);
  console.log(`下载目录：${settings.downloadDir}`);
  return port;
}

// 直接 node server.mjs 时也能跑（无内嵌浏览器，仅界面/素材库/下载）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await startServer();
  console.log('提示：当前是纯后端模式（无内嵌浏览器）。完整功能请用 electron . 启动。');
}
