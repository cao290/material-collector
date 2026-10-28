/**
 * 下载器
 * - 抖音/小红书/快手：优先用采集到的直链 + 浏览器 cookie + Referer
 * - B站 或直链失败：回退 yt-dlp（cookie 从浏览器导出成 Netscape 文本）
 * - 下载后写封面 .jpg 和元信息 .json
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findFirst } from './cdp.mjs';
import { PLATFORM_META } from './adapters/base.mjs';

const YTDLP_CANDIDATES = [
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python311/Scripts/yt-dlp.exe`,
  `${process.env.LOCALAPPDATA || ''}/Programs/Python/Python312/Scripts/yt-dlp.exe`,
  'yt-dlp.exe',
  'yt-dlp',
];

const FFMPEG_CANDIDATES = [
  `${process.env.LOCALAPPDATA || ''}/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe`,
  'ffmpeg.exe',
];

export function ytdlpPath() {
  return findFirst(YTDLP_CANDIDATES);
}

export function ffmpegPath() {
  return findFirst(FFMPEG_CANDIDATES);
}

const sanitize = (text, max = 60) =>
  String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'untitled';

/** 人类可读的点赞数：12345 → 1.2w */
function likeText(n) {
  if (!n) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿赞`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w赞`;
  return `${n}赞`;
}

export function buildFileName(item, ext = 'mp4') {
  const platform = PLATFORM_META[item.platform]?.label || item.platform;
  const parts = [
    platform,
    item.author ? `@${sanitize(item.author, 20)}` : '',
    likeText(item.likes),
    sanitize(item.title, 30),
    item.platform_id,
  ].filter(Boolean);
  return `${parts.join('_')}.${ext}`;
}

function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
    const domain = c.domain?.startsWith('.') ? c.domain : `.${c.domain}`;
    const flag = 'TRUE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = Math.floor(c.expires && c.expires > 0 ? c.expires : Date.now() / 1000 + 86400 * 30);
    lines.push([domain, flag, c.path || '/', secure, expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

const REFERERS = {
  douyin: 'https://www.douyin.com/',
  xhs: 'https://www.xiaohongshu.com/',
  kuaishou: 'https://www.kuaishou.com/',
  bilibili: 'https://www.bilibili.com/',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/**
 * 防盗链站点的完整浏览器头。
 * 实测：B站视频流只带 Referer 会返回 567，必须补齐 sec-fetch-* 才给 206。
 */
function browserHeaders(platform, pageUrl) {
  const referer = pageUrl || REFERERS[platform] || '';
  const origin = referer ? new URL(referer).origin : '';
  return {
    'user-agent': UA,
    referer,
    origin,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-fetch-dest': 'video',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
  };
}

/**
 * 下载一条素材
 * @returns {{path, size, engine, error}}
 */
export async function downloadItem({ item, outDir, cookies, onProgress, signal, inPageFetch }) {
  const failures = [];
  const platform = item.platform;
  const dir = path.join(outDir, PLATFORM_META[platform]?.label || platform, sanitize(item.keyword || '未分类', 30));
  await fsp.mkdir(dir, { recursive: true });

  const name = buildFileName(item);
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    return { path: dest, size: fs.statSync(dest).size, engine: 'cache', skipped: true };
  }

  // DASH 分离流（B站）：视频+音频分别拉取后 ffmpeg 合并
  if (item.video_url && item.audio_url) {
    try {
      const result = await downloadDash({ item, dest, cookies, onProgress, signal, inPageFetch });
      if (result.size > 1024) {
        await writeSidecars({ item, dir, name, size: result.size });
        return result;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`dash: ${error.message}`);
    }
  }

  if (item.video_url) {
    try {
      const result = await downloadDirect({ item, dest, cookies, onProgress, signal });
      if (result.size > 1024) {
        await writeSidecars({ item, dir, name, size: result.size });
        return result;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`direct: ${error.message}`);
    }
  }

  try {
    return await downloadWithYtdlp({ item, dir, dest, cookies, onProgress, signal });
  } catch (error) {
    const detail = failures.length ? `（直链失败：${failures.join(' / ')}）` : '';
    throw new Error(`${error.message}${detail}`);
  }
}

/** DASH 音视频分流下载 + ffmpeg 合并
 *  视频流必须从页面上下文拉（B站校验 Sec-Fetch-Site / Referer，Node 直连返回 567）
 */
async function downloadDash({ item, dest, cookies, onProgress, signal, inPageFetch }) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error('缺少 ffmpeg，无法合并音视频');
  const vTmp = `${dest}.v.m4s`;
  const aTmp = `${dest}.a.m4s`;
  const tmpOut = `${dest}.tmp.mp4`;
  let done = false;

  try {
    await fetchToFile({
      url: item.video_url,
      dest: vTmp,
      platform: item.platform,
      cookies,
      signal,
      onProgress,
      phase: 'video',
      pageUrl: item.page_url,
      backups: item.video_backups || [],
      inPageFetch,
    });
    await fetchToFile({
      url: item.audio_url,
      dest: aTmp,
      platform: item.platform,
      cookies,
      signal,
      onProgress,
      phase: 'audio',
      pageUrl: item.page_url,
      backups: item.audio_backups || [],
      inPageFetch,
    });

    await runCommand(
      ffmpeg,
      ['-y', '-loglevel', 'error', '-i', vTmp, '-i', aTmp, '-c', 'copy', '-movflags', '+faststart', tmpOut],
      { signal, onLine: () => {} }
    );

    await fsp.rename(tmpOut, dest);
    done = true;
    const size = fs.statSync(dest).size;
    return { path: dest, size, engine: 'dash+ffmpeg' };
  } finally {
    // 音视频分片/合并中间产物一律清掉：失败时否则残留好几个 .m4s 巨型残片占盘
    await Promise.all([
      fsp.unlink(vTmp).catch(() => {}),
      fsp.unlink(aTmp).catch(() => {}),
      fsp.unlink(tmpOut).catch(() => {}),
    ]);
  }
}

/**
 * 只取音频（不保存视频）——给「只要内容文字、不要视频」的转写用。
 * 优先：有独立 audio_url 的（B站/抖音 DASH）直接拉音频流，省掉整个视频体积。
 * 回退：只有合流的（小红书/快手）先下整片，ffmpeg 抽成 m4a 再删掉视频临时文件。
 * @returns {{path, size, engine, cleanedVideo?:string}}
 */
export async function downloadAudioOnly({ item, outDir, cookies, onProgress, signal, inPageFetch }) {
  const failures = [];
  const dir = path.join(outDir, PLATFORM_META[item.platform]?.label || item.platform, sanitize(item.keyword || '未分类', 30));
  await fsp.mkdir(dir, { recursive: true });

  const audioName = buildFileName(item, 'm4a');
  const audioDest = path.join(dir, audioName);
  if (fs.existsSync(audioDest) && fs.statSync(audioDest).size > 1024) {
    return { path: audioDest, size: fs.statSync(audioDest).size, engine: 'cache', skipped: true };
  }

  const ffmpeg = ffmpegPath();

  // 1) 有独立音频流：只拉它，完全不碰视频
  if (item.audio_url) {
    try {
      await fetchToFile({
        url: item.audio_url,
        dest: audioDest,
        platform: item.platform,
        cookies,
        signal,
        onProgress,
        phase: 'audio',
        pageUrl: item.page_url,
        backups: item.audio_backups || [],
        inPageFetch,
      });
      const size = fs.statSync(audioDest).size;
      if (size > 1024) return { path: audioDest, size, engine: 'audio-stream' };
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`audio-stream: ${error.message}`);
    }
  }

  // 2) 只有合流：下整片 → ffmpeg 抽音频 → 删视频
  if (!ffmpeg) throw new Error(`缺少 ffmpeg，无法抽取音频${failures.length ? `（${failures.join(' / ')}）` : ''}`);
  const vidName = buildFileName(item);
  const vidDest = path.join(dir, vidName);
  const tmpDest = `${vidDest}.tmp.${item.platform}`;

  try {
    if (fs.existsSync(vidDest) && fs.statSync(vidDest).size > 1024) {
      // 视频已在本地，直接抽音频
      await extractAudio(ffmpeg, vidDest, audioDest, signal);
      return { path: audioDest, size: fs.statSync(audioDest).size, engine: 'extract-from-local' };
    }
    let engine = 'direct';
    if (item.video_url && item.audio_url) {
      await downloadDash({ item, dest: tmpDest, cookies, onProgress, signal, inPageFetch });
      engine = 'dash';
    } else if (item.video_url) {
      const r = await downloadDirect({ item, dest: tmpDest, cookies, onProgress, signal });
      engine = r.engine;
    } else {
      const r = await downloadWithYtdlp({ item, dir, dest: tmpDest, cookies, onProgress, signal });
      engine = r.engine;
    }
    await extractAudio(ffmpeg, tmpDest, audioDest, signal);
    const size = fs.statSync(audioDest).size;
    return { path: audioDest, size, engine: `extract+${engine}` };
  } catch (error) {
    failures.push(error.message);
    throw new Error(`只取音频失败：${failures.join(' / ')}`);
  } finally {
    // 临时视频一律删掉——这就是「不占空间」的关键
    await fsp.unlink(tmpDest).catch(() => {});
  }
}

/** 用 ffmpeg 从视频里抽音频（转 m4a/aac，体积远小于原片） */
async function extractAudio(ffmpeg, videoPath, audioDest, signal) {
  const tmp = `${audioDest}.part.m4a`;
  let done = false;
  try {
    await runCommand(ffmpeg, ['-y', '-loglevel', 'error', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '128k', tmp], {
      signal,
      onLine: () => {},
    });
    await fsp.rename(tmp, audioDest);
    done = true;
  } finally {
    if (!done) await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * 只取视频开头一小段做「小样」（用于抽帧检测字幕），不落素材库。
 * 达到 maxBytes 就提前断流，不算错误。
 * @returns {{path, size, engine}}
 */
export async function downloadSample({ item, tmpDir, maxBytes = 6 * 1024 * 1024, cookies, signal, inPageFetch }) {
  if (!item.video_url) throw new Error('没有视频直链');
  await fsp.mkdir(tmpDir, { recursive: true });
  const dest = path.join(tmpDir, `sample_${item.platform}_${item.platform_id || Date.now()}.bin`);
  if (fs.existsSync(dest)) {
    try { await fsp.unlink(dest); } catch {}
  }
  const size = await fetchToFile({
    url: item.video_url,
    dest,
    platform: item.platform,
    cookies,
    signal,
    phase: 'sample',
    pageUrl: item.page_url,
    backups: item.video_backups || [],
    inPageFetch,
    maxBytes,
  });
  return { path: dest, size, engine: 'sample' };
}

/**
 * 拉取到文件：优先一条 Range=0- 的流式长连接（B站不给无 Range 请求，但接受全量 Range）。
 * 失败时自动重试备用 CDN 域名。
 */
async function fetchToFile({ url, dest, platform, cookies, signal, onProgress, phase, pageUrl, backups = [], inPageFetch, maxBytes }) {
  const cookieHeader = (cookies || [])
    .filter((c) => !c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const candidates = [url, ...backups].filter(Boolean);
  const errors = [];

  for (const candidate of candidates) {
    // 大文件先试分段并行：B站 DASH 的音视频流同样按连接限速，单流拉 300MB 要十几分钟。
    // 只取样（maxBytes）时不能分段——那是有意提前断流的，分段会白拉整片。
    if (!maxBytes) {
      try {
        const r = await downloadParallel({
          url: candidate,
          dest,
          platform,
          pageUrl,
          cookieHeader,
          signal,
          onProgress: onProgress ? (p) => onProgress({ ...p, phase }) : undefined,
        });
        if (r.size > 1024) return r.size;
        errors.push(`${phase} 分段流为空`);
      } catch (error) {
        if (signal?.aborted) throw error;
        // 不支持 Range / 太小时静默回退单流，别把噪声写进错误链
        if (!error.noParallel) errors.push(`分段: ${error.message}`);
        if (process.env.COLLECTOR_DEBUG_SEG) {
          console.error(`[fetchToFile] ${phase} 分段不可用，回退单流：${error.message}`);
        }
      }
    }
    try {
      return await streamToFile({ url: candidate, dest, platform, pageUrl, cookieHeader, signal, onProgress, phase, maxBytes });
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(error.message);
    }
  }

  // 全部失败：退回页面上下文下载
  if (inPageFetch) {
    const buf = await inPageFetch(url, phase);
    const cut = maxBytes ? buf.subarray(0, maxBytes) : buf;
    await fsp.writeFile(dest, cut);
    onProgress?.({ received: cut.length, total: cut.length, speed: 0, phase });
    return cut.length;
  }
  throw new Error(`${phase} 下载失败：${errors.join(' / ')}`);
}

/**
 * 数据停滞看门狗（共享）：CDN 中途不再吐数据时，`for await (response.body)`
 * 会永久挂住——进度条定在某个百分比、速度还是最后一刻的旧值，这就是「卡住」的观感。
 * 用法：fetch 用返回的 signal；每收到一块数据调一次 feed()；结束（含异常）调 stop()。
 * 超过 ms 毫秒没新数据 → abort（body 读取随即抛错）；超过 3s 没新数据 → onIdle(idleMs)，
 * 调用方用它把速度报成 0，别让旧速度一直挂在界面上。
 */
function stallWatchdog({ signal, ms, onIdle } = {}) {
  const threshold = ms || Number(process.env.COLLECTOR_STALL_MS || 45000);
  const ctl = new AbortController();
  const combo = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  let last = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    const idle = Date.now() - last;
    if (idle > threshold) {
      if (!fired) {
        fired = true;
        ctl.abort();
      }
      return;
    }
    if (idle > 3000 && onIdle) onIdle(idle);
  }, 1000);
  timer.unref?.();
  return {
    signal: combo,
    feed: () => {
      last = Date.now();
    },
    fired: () => fired,
    stop: () => clearInterval(timer),
  };
}

async function streamToFile({ url, dest, platform, pageUrl, cookieHeader, signal, onProgress, phase, maxBytes }) {
  const headers = browserHeaders(platform, pageUrl);
  if (cookieHeader) headers.cookie = cookieHeader;
  headers.range = 'bytes=0-';

  const STALL_MS = Number(process.env.COLLECTOR_STALL_MS || 45000);
  let received = 0;
  let total = 0;
  const wd = stallWatchdog({
    signal,
    ms: STALL_MS,
    onIdle: () => onProgress?.({ received, total: maxBytes || total || received, speed: 0, phase }),
  });

  const response = await fetchWithConnectTimeout(url, { headers, signal: wd.signal, redirect: 'follow' });
  if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`);
  const cr = response.headers.get('content-range');
  const m = cr && cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
  total = m ? Number(m[1]) : Number(response.headers.get('content-length')) || 0;
  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) throw new Error('返回网页而不是视频');

  // highWaterMark 调大：视频是大块流，默认 16KB 太碎，写盘会成为瓶颈
  const file = fs.createWriteStream(dest, { highWaterMark: 1024 * 1024 });
  let capped = false; // 只取样时达到上限就提前收工（不算错误）
  let lastReport = 0;
  let lastBytes = 0;
  let lastTime = Date.now();
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('已取消');
      let piece = chunk;
      if (maxBytes && received + piece.length > maxBytes) {
        piece = piece.subarray(0, maxBytes - received);
        capped = true;
      }
      // 必须等 drain：不等的话写盘跟不上，内存堆积把下载一起拖慢
      if (!file.write(piece)) {
        await new Promise((resolve) => file.once('drain', resolve));
      }
      received += piece.length;
      wd.feed();
      // 进度回调节流到 ~120ms，原来每个 chunk 都调（几十次/秒）纯属浪费
      const now = Date.now();
      if (now - lastReport >= 120 || capped) {
        lastReport = now;
        // 瞬时速度（区间增量），平均值会被慢启动拖死
        const dt = (now - lastTime) / 1000;
        const speed = dt > 0 ? (received - lastBytes) / dt : 0;
        lastBytes = received;
        lastTime = now;
        onProgress?.({
          received,
          total: maxBytes || total || received,
          speed,
          phase,
        });
      }
      if (capped) break;
    }
  } catch (error) {
    if (wd.fired() && !signal?.aborted) {
      throw new Error(`数据停滞超过 ${Math.round(STALL_MS / 1000)}s（已收 ${(received / 1048576).toFixed(1)}MB），换源重试`);
    }
    throw error;
  } finally {
    wd.stop();
    await new Promise((resolve) => file.end(resolve));
  }
  if (received < 1024) throw new Error(`${phase} 流为空`);
  if (!maxBytes && total && received < total * 0.98) throw new Error(`${phase} 只下到 ${received}/${total}`);
  return received;
}

/**
 * 给一次 fetch 加「连接/响应头超时」：undici 默认 headersTimeout 是 300s，
 * CDN 半开连接（不吐响应头）会让下载在最开始就静默挂 5 分钟，观感＝卡死。
 * 注意：超时只在「等响应头」阶段生效——fetch 的 promise 一落定就撤销计时器，
 * 绝不能用 AbortSignal.timeout 合进请求信号（那个 20s 一到连 body 一起杀，
 * 实测下载每 20s 被掐断一次再续传）。
 */
function fetchWithConnectTimeout(url, opts, ms = 20000) {
  const ctl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
  const timer = setTimeout(() => ctl.abort(), ms);
  timer.unref?.();
  return fetch(url, { ...opts, signal }).finally(() => clearTimeout(timer));
}

/* ==================== 分段并行下载 ==================== */

// 抖音/B站这类 CDN 按「连接」限速：单连接实测 271~905KB/s（直连与走代理一样），
// 300MB 的长视频要十几分钟，观感就是「卡住」。实测同一 URL 开多条 Range 连接
// 互不挤占、速度近似叠加，所以大文件切成 N 段并发拉。
const SEG_MIN_BYTES = 8 * 1024 * 1024; // 小于这个不分段：没收益还白占连接
const SEG_TARGET_MB = Number(process.env.COLLECTOR_SEGMENT_MB || 24); // 目标每段大小
const SEG_MAX = Number(process.env.COLLECTOR_SEGMENTS || 5); // 最多并发连接数
// 分段的停滞阈值可以比单流激进得多：段内支持断点续传，掐断后只需重请求剩余区间，
// 成本近似为零。单流那条 45s 阈值是为了避免「重下整片」，这里不必陪它一起等。
const SEG_STALL_MS = Number(process.env.COLLECTOR_SEG_STALL_MS || 12000);
const SEG_ATTEMPTS = Number(process.env.COLLECTOR_SEG_ATTEMPTS || 6);

/**
 * 分段并行下载：先探测 Range 支持与总长，切成 N 段并发拉。
 * 各段带偏移写入同一个预分配文件的自己的区间（不落临时分片文件，不翻倍占盘）；
 * 每段带停滞看门狗 + 段内断点续传重试（从该段已收字节继续 Range）。
 * @returns {{size:number, connections:number}} 不支持分段 / 反复失败时抛错，调用方回退单流
 */
export async function downloadParallel({ url, dest, platform, pageUrl, cookieHeader, signal, onProgress }) {
  const headers = browserHeaders(platform, pageUrl);
  if (cookieHeader) headers.cookie = cookieHeader;

  const probe = await fetchWithConnectTimeout(url, { headers: { ...headers, range: 'bytes=0-1' }, signal })
    .catch((e) => {
      if (signal?.aborted) throw e;
      // 连接/响应头超时也按「不支持分段」处理：回退单流（单流同样有 20s 头超时兜底）
      const err = new Error(`分段探测连接失败：${String(e?.cause?.message || e.message).slice(0, 80)}`);
      err.noParallel = true;
      throw err;
    });
  try {
    if (probe.status !== 206) {
      const e = new Error(`分段探测失败：HTTP ${probe.status}（不支持 Range）`);
      e.noParallel = true;
      throw e;
    }
    const total = Number((probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/)?.[1] || 0);
    if (!total) {
      const e = new Error('分段探测失败：拿不到文件总长');
      e.noParallel = true;
      throw e;
    }
    if (total < SEG_MIN_BYTES) {
      const e = new Error(`文件仅 ${(total / 1048576).toFixed(1)}MB，不分段`);
      e.noParallel = true;
      throw e;
    }

    const connections = Math.min(SEG_MAX, Math.max(2, Math.ceil(total / (SEG_TARGET_MB * 1048576))));
    const segSize = Math.ceil(total / connections);

    let received = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let lastReport = 0;
    let lastDataAt = Date.now();
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < 150) return;
      lastReport = now;
      const dt = (now - lastTime) / 1000;
      const speed = dt > 0 ? (received - lastBytes) / dt : 0;
      lastBytes = received;
      lastTime = now;
      onProgress?.({ received, total, speed });
    };
    const bump = (n) => {
      received += n;
      lastDataAt = Date.now();
      report();
    };
    // 超过 3s 全体没增量就把速度报 0（界面显示「等待数据…」）
    const idleTimer = setInterval(() => {
      if (Date.now() - lastDataAt > 3000) {
        lastBytes = received;
        lastTime = Date.now();
        onProgress?.({ received, total, speed: 0 });
      }
    }, 1000);
    idleTimer.unref?.();

    // 预分配目标文件，各段 pwrite 到互不重叠的区间
    const fh = await fsp.open(dest, 'w');
    await fh.truncate(total);
    try {
      const worker = async (i) => {
        const start = i * segSize;
        const end = Math.min(total, start + segSize) - 1; // 含端点
        let got = 0; // 该段已写入字节（相对段起点）
        // 先快速试几轮（12s 停滞阈值，掐断后立刻续传）；
        // 都不成再给最后一次「慢但稳」的机会（45s 阈值）——此时已投入很多，值得多等。
        const rounds = [
          ...Array.from({ length: SEG_ATTEMPTS }, () => ({ ms: SEG_STALL_MS, backoff: 200 })),
          { ms: Number(process.env.COLLECTOR_STALL_MS || 45000), backoff: 0 },
        ];
        for (let attempt = 1; attempt <= rounds.length; attempt++) {
          const { ms, backoff } = rounds[attempt - 1];
          const wd = stallWatchdog({ signal, ms });
          try {
            const res = await fetchWithConnectTimeout(url, {
              headers: { ...headers, range: `bytes=${start + got}-${end}` },
              signal: wd.signal,
            });
            if (res.status !== 206) {
              const e = new Error(`分段 ${i + 1}/${connections}：HTTP ${res.status}`);
              if (res.status === 200) e.noParallel = true; // 服务器忽略了 Range
              throw e;
            }
            for await (const piece of res.body) {
              if (signal?.aborted) throw new Error('已取消');
              wd.feed();
              await fh.write(piece, 0, piece.length, start + got);
              got += piece.length;
              bump(piece.length);
            }
            if (start + got !== end + 1) {
              throw new Error(`分段 ${i + 1}/${connections} 只收到 ${got}/${end - start + 1} 字节`);
            }
            return;
          } catch (e) {
            if (process.env.COLLECTOR_DEBUG_SEG) {
              console.error(`[seg ${i + 1}/${connections}] 第 ${attempt} 次失败（已收 ${got}B，阈值 ${ms}ms）：${e.message}`);
            }
            if (signal?.aborted || e.noParallel) throw e;
            if (attempt >= rounds.length) throw e;
            // 停滞/中断：从段内断点续传，别从头重来。退避要短，CDN 抖动往往几秒就恢复。
            if (backoff) await new Promise((r) => setTimeout(r, backoff * attempt));
          } finally {
            wd.stop();
          }
        }
      };

      const results = await Promise.allSettled(Array.from({ length: connections }, (_, i) => worker(i)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
      if (received !== total) throw new Error(`分段合计 ${received}/${total} 字节不符`);
      report(true);
      onProgress?.({ received, total, speed: 0 });
      return { size: received, connections };
    } finally {
      clearInterval(idleTimer);
      await fh.close().catch(() => {});
    }
  } finally {
    probe.body?.cancel?.().catch(() => {});
  }
}

async function downloadDirect({ item, dest, cookies, onProgress, signal }) {
  const cookieHeader = (cookies || [])
    .filter((c) => !c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const headers = browserHeaders(item.platform, item.page_url);
  if (cookieHeader) headers.cookie = cookieHeader;
  const tmp = `${dest}.part`;
  let done = false;

  try {
    // 大文件优先分段并行：单连接 300-500KB/s 的 CDN 上，长视频要十几分钟（观感＝卡住）。
    // 不支持 Range / 反复停滞时自动回退下面的单流。
    try {
      const r = await downloadParallel({
        url: item.video_url,
        dest: tmp,
        platform: item.platform,
        pageUrl: item.page_url,
        cookieHeader,
        signal,
        onProgress,
      });
      await fsp.rename(tmp, dest);
      done = true;
      return { path: dest, size: r.size, engine: `direct-x${r.connections}` };
    } catch (error) {
      if (signal?.aborted) throw error;
      // 回退单流：先清掉分段留下的半成品，避免残片与新写入交织
      await fsp.unlink(tmp).catch(() => {});
    }

    let received = 0;
    let total = 0;
    const wd = stallWatchdog({ signal, onIdle: () => onProgress?.({ received, total, speed: 0 }) });

    const response = await fetchWithConnectTimeout(item.video_url, { headers, signal: wd.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    total = Number(response.headers.get('content-length')) || 0;
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) throw new Error('返回的是网页不是视频');

    // 1MB 缓冲：视频是大块流，默认 16KB 太小，写盘容易成为瓶颈
    const file = fs.createWriteStream(tmp, { highWaterMark: 1024 * 1024 });
    let lastReport = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      wd.feed();
      received += chunk.length;
      // 进度节流到 120ms：原来每个 chunk 都回调，几十次/秒纯属浪费
      const now = Date.now();
      if (now - lastReport < 120) return;
      lastReport = now;
      // 用区间增量算瞬时速度：平均值会被开头的慢启动拖死，
      // 显示成 0.1MB/s 而实际已经跑到几 MB/s，看着像卡住。
      const dt = (now - lastTime) / 1000;
      const speed = dt > 0 ? (received - lastBytes) / dt : 0;
      lastBytes = received;
      lastTime = now;
      onProgress?.({ received, total, speed });
    });
    try {
      // pipeline 自带背压处理，比手动 write 更稳
      await pipeline(stream, file);
    } catch (error) {
      if (wd.fired() && !signal?.aborted) {
        throw new Error(`数据停滞超过 ${Math.round(Number(process.env.COLLECTOR_STALL_MS || 45000) / 1000)}s（单流兜底也停滞）`);
      }
      throw error;
    } finally {
      wd.stop();
    }
    onProgress?.({ received, total: total || received, speed: 0 });
    await fsp.rename(tmp, dest);
    done = true;
    return { path: dest, size: received, engine: 'direct' };
  } finally {
    // 失败/取消一律清掉 .part：否则半成品永久占盘（实测攒过 332MB），
    // 而且下次重试会拿残片当已有进度，越滚越乱。
    if (!done) await fsp.unlink(tmp).catch(() => {});
  }
}

function runCommand(cmd, args, { onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      stdout += text;
      onLine?.(text.trim());
    });
    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr += text;
      onLine?.(text.trim());
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `退出码 ${code}`));
    });
  });
}

async function downloadWithYtdlp({ item, dir, dest, cookies, onProgress, signal }) {
  const ytdlp = ytdlpPath();
  if (!ytdlp) throw new Error('没找到 yt-dlp，请先安装：pip install yt-dlp');

  const cookieFile = path.join(dir, '.cookies.txt');
  if (cookies?.length) {
    await fsp.writeFile(cookieFile, cookiesToNetscape(cookies), 'utf8');
  }

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '-o', dest,
    '--merge-output-format', 'mp4',
    '--add-header', `Referer:${REFERERS[item.platform] || ''}`,
    '--user-agent', UA,
    '--concurrent-fragments', '3',
  ];
  const ffmpeg = ffmpegPath();
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
  if (cookies?.length) args.push('--cookies', cookieFile);

  args.push(item.page_url || item.video_url);

  try {
    let lastPercent = 0;
    await runCommand(ytdlp, args, {
      signal,
      onLine: (line) => {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const percent = Number(m[1]);
          if (percent - lastPercent >= 2) {
            lastPercent = percent;
            onProgress?.({ percent, received: 0, total: 0, speed: 0 });
          }
        }
      },
    });
  } finally {
    // cookie 文件含明文登录态，无论成功失败都必须删（原来只在成功路径删）
    if (cookies?.length) fsp.unlink(cookieFile).catch(() => {});
  }

  if (!fs.existsSync(dest)) {
    // yt-dlp 可能改写扩展名
    const files = await fsp.readdir(dir);
    const guess = files.find((f) => f.startsWith(path.basename(dest, path.extname(dest))));
    if (!guess) throw new Error('下载完成但没找到文件');
    const full = path.join(dir, guess);
    const size = fs.statSync(full).size;
    await writeSidecars({ item, dir, name: guess, size });
    return { path: full, size, engine: 'yt-dlp' };
  }

  const size = fs.statSync(dest).size;
  await writeSidecars({ item, dir, name: path.basename(dest), size });
  return { path: dest, size, engine: 'yt-dlp' };
}

/** 写封面和元信息旁车 */
async function writeSidecars({ item, dir, name, size }) {
  const base = name.replace(/\.[^.]+$/, '');

  if (item.cover) {
    try {
      const res = await fetch(item.cover, {
        headers: { 'user-agent': UA, referer: REFERERS[item.platform] || '' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(path.join(dir, `${base}.jpg`), buf);
      }
    } catch {
      /* 封面失败不影响主流程 */
    }
  }

  const meta = {
    平台: PLATFORM_META[item.platform]?.label || item.platform,
    标题: item.title || '',
    文案: item.desc || '',
    话题标签: item.tags || '',
    BGM: item.music || '',
    作者: item.author || '',
    作者ID: item.author_id || '',
    点赞: item.likes || 0,
    评论: item.comments || 0,
    分享: item.shares || 0,
    收藏: item.collects || 0,
    时长秒: item.duration || 0,
    发布时间: item.published || '',
    采集关键词: item.keyword || '',
    原链接: item.page_url || '',
    视频地址: item.video_url || '',
    音频地址: item.audio_url || '',
    平台ID: item.platform_id || '',
    文件大小: size,
    采集时间: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(dir, `${base}.json`), JSON.stringify(meta, null, 2), 'utf8');
}

/** 完整性校验：文件是否存在且能读出时长 */
export async function probeFile(file) {
  const ffprobe = findFirst([
    `${process.env.LOCALAPPDATA || ''}/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffprobe.exe`,
    'ffprobe.exe',
  ]);
  if (!ffprobe) return null;
  try {
    const { stdout } = await runCommand(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
      '-of', 'json',
      file,
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
