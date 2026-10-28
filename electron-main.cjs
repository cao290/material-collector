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
// 强杀/正常退出时，Electron 也会给每个子进程报 child-process-gone(crashed, exitCode -1)。
// 这些记录和真崩溃长得一模一样，害得排查时以为 NetworkService/AudioService 一直在崩。
// 用一个标记把「我们自己在退出」和「真崩」分开。
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});
process.on('uncaughtException', (err) => logCrash('uncaughtException', err.stack || err.message));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', (err && (err.stack || err.message)) || String(err)));
app.on('child-process-gone', (_e, details) => {
  if (quitting) return;
  logCrash('child-process-gone', JSON.stringify(details));
});
// 记下是哪个页面挂的（主窗口 or 内置浏览器的 WebContentsView），否则只知道「有个渲染进程崩了」
app.on('render-process-gone', (_e, wc, details) => {
  if (quitting) return;
  let where = '';
  try {
    where = ` url=${wc?.getURL?.() || '?'} type=${wc?.getType?.() || '?'}`;
  } catch {
    /* webContents 可能已销毁 */
  }
  logCrash('render-process-gone', JSON.stringify(details) + where);
});

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
  // 启动先把已有登录态备份读进守护内存，这样「一键恢复」从一开始就可用
  try {
    const guard = await import('./lib/login-guard.mjs');
    const g = guard.createLoginGuard({ getSession: () => null });
    const f = path.join(ROOT, 'data', 'login-backup', 'latest.json');
    if (fs.existsSync(f)) {
      const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
      g.prefillMeta(meta);
      if (meta?.count) console.log('[boot] 已载入登录态备份:', meta.count, '条 cookie（', meta.at, '）');
    }
  } catch (e) {
    console.warn('[boot] 登录态备份载入失败:', e.message);
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
