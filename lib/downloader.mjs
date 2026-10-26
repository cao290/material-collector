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
  await Promise.all([fsp.unlink(vTmp).catch(() => {}), fsp.unlink(aTmp).catch(() => {})]);
  const size = fs.statSync(dest).size;
  return { path: dest, size, engine: 'dash+ffmpeg' };
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
  await runCommand(ffmpeg, ['-y', '-loglevel', 'error', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '128k', tmp], {
    signal,
    onLine: () => {},
  });
  await fsp.rename(tmp, audioDest);
}

/**
 * 拉取到文件：优先一条 Range=0- 的流式长连接（B站不给无 Range 请求，但接受全量 Range）。
 * 失败时自动重试备用 CDN 域名。
 */
async function fetchToFile({ url, dest, platform, cookies, signal, onProgress, phase, pageUrl, backups = [], inPageFetch }) {
  const cookieHeader = (cookies || [])
    .filter((c) => !c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const candidates = [url, ...backups].filter(Boolean);
  const errors = [];

  for (const candidate of candidates) {
    try {
      return await streamToFile({ url: candidate, dest, platform, pageUrl, cookieHeader, signal, onProgress, phase });
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(error.message);
    }
  }

  // 全部失败：退回页面上下文下载
  if (inPageFetch) {
    const buf = await inPageFetch(url, phase);
    await fsp.writeFile(dest, buf);
    onProgress?.({ received: buf.length, total: buf.length, speed: 0, phase });
    return buf.length;
  }
  throw new Error(`${phase} 下载失败：${errors.join(' / ')}`);
}

async function streamToFile({ url, dest, platform, pageUrl, cookieHeader, signal, onProgress, phase }) {
  const headers = browserHeaders(platform, pageUrl);
  if (cookieHeader) headers.cookie = cookieHeader;
  headers.range = 'bytes=0-';

  const response = await fetch(url, { headers, signal, redirect: 'follow' });
  if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`);
  const cr = response.headers.get('content-range');
  const m = cr && cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
  const total = m ? Number(m[1]) : Number(response.headers.get('content-length')) || 0;
  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) throw new Error('返回网页而不是视频');

  const file = fs.createWriteStream(dest);
  let received = 0;
  const started = Date.now();
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('已取消');
      file.write(chunk);
      received += chunk.length;
      const elapsed = (Date.now() - started) / 1000;
      onProgress?.({
        received,
        total: total || received,
        speed: elapsed > 0 ? received / elapsed : 0,
        phase,
      });
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }
  if (received < 1024) throw new Error(`${phase} 流为空`);
  if (total && received < total * 0.98) throw new Error(`${phase} 只下到 ${received}/${total}`);
  return received;
}

async function downloadDirect({ item, dest, cookies, onProgress, signal }) {
  const cookieHeader = (cookies || [])
    .filter((c) => !c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const headers = browserHeaders(item.platform, item.page_url);
  if (cookieHeader) headers.cookie = cookieHeader;

  const response = await fetch(item.video_url, { headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) throw new Error('返回的是网页不是视频');

  const tmp = `${dest}.part`;
  const file = fs.createWriteStream(tmp);
  let received = 0;
  const started = Date.now();
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => {
    received += chunk.length;
    const elapsed = (Date.now() - started) / 1000;
    onProgress?.({
      received,
      total,
      speed: elapsed > 0 ? received / elapsed : 0,
    });
  });
  await pipeline(stream, file);
  await fsp.rename(tmp, dest);
  return { path: dest, size: received, engine: 'direct' };
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

  if (cookies?.length) {
    fsp.unlink(cookieFile).catch(() => {});
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
