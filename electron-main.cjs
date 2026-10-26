/**
 * 素材采集器 · Electron 主进程
 * 软件本身内置浏览器（WebContentsView），登录和采集都在本窗口内完成。
 * 后端逻辑复用 server.mjs（同进程跑 HTTP API，界面照旧走 fetch）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, shell } = require('electron');

const ROOT = __dirname;
// 登录态放在程序目录，不进 AppData，拷走目录即带走登录
app.setPath('userData', path.join(ROOT, 'profile-electron'));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

let win = null;
let host = null;
let serverPort = 8343;

// 崩溃与异常落盘，便于排查
const crashLog = path.join(ROOT, 'data', 'crash.log');
function logCrash(tag, detail) {
  try {
    fs.mkdirSync(path.dirname(crashLog), { recursive: true });
    fs.appendFileSync(crashLog, `[${new Date().toISOString()}] ${tag}: ${detail}
`);
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err.stack || err.message));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', (err && (err.stack || err.message)) || String(err)));
app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', JSON.stringify(details)));
app.on('render-process-gone', (_e, _wc, details) => logCrash('render-process-gone', JSON.stringify(details)));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  console.log('[boot] step1 menu');
  // 启动先检查有没有待恢复的登录态备份（上次退出前请求的）
  try {
    const guard = await import('./lib/login-guard.mjs');
    const g = guard.createLoginGuard({ rootDir: ROOT });
    const r = g.applyPendingRestore();
    if (r.restored) console.log('[boot] 已从备份恢复登录态:', (r.platforms && Object.keys(r.platforms).filter(k => r.platforms[k]).join(', ')) || '');
  } catch (e) {
    console.warn('[boot] 登录态恢复检查失败:', e.message);
  }
  Menu.setApplicationMenu(null);

  console.log('[boot] step2 host import');
  const { createElectronHost } = await import('./lib/electron-host.mjs');

  console.log('[boot] step3 server import');
  // 先起 HTTP API（与界面同源），再建窗口
  const server = await import('./server.mjs');
  console.log('[boot] step4 server start');
  serverPort = await server.startServer();
  console.log('[boot] step5 server up:', serverPort);

  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: '素材采集器',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('closed', () => {
    win = null;
  });
  // 界面里的外链用系统浏览器开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  console.log('[boot] step6 host create');
  host = createElectronHost({
    electron: require('electron'),
    mainWindow: win,
    getUserDataDir: () => app.getPath('userData'),
  });
  server.setBrowserHost(host);
  console.log('[boot] step7 load UI');
  await win.loadURL(`http://127.0.0.1:${serverPort}/`);
  console.log('[boot] step8 UI loaded');
}

app.on('window-all-closed', () => {
  app.quit();
});
