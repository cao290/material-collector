/**
 * 登录态守护（Electron session 版）
 *
 * 背景：Chromium 对 Cookies 文件持有持续文件锁，磁盘级复制在运行期必 EBUSY。
 * 正确做法：走 session.cookies API——备份 = get 全量 JSON 落盘；恢复 = set 逐条写回，
 * 不碰文件锁，且恢复**无需重启**。
 *
 * 备份文件 data/login-backup/latest.json 含 cookie 明文（与本机 Cookies 库同安全级，
 * 只存本机程序目录，README 已注明）。
 */

const now = () => Date.now();

export function createLoginGuard({ getSession }) {
  let lastState = {}; // platform -> boolean
  let lastMeta = null;

  function metaPath(backupDir) {
    return `${backupDir}/latest.json`;
  }

  async function doBackup(backupDir) {
    const ses = getSession();
    if (!ses) return null;
    const raw = await ses.cookies.get({});
    const cookies = raw.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expirationDate: c.expirationDate,
      sameSite: c.sameSite,
    }));
    const meta = { at: new Date().toISOString(), count: cookies.length, cookies };
    // 滚动：上一份留作 prev
    try {
      const latest = `${backupDir}/latest.json`;
      if (await exists(latest)) await copyIfExists(latest, `${backupDir}/prev.json`);
    } catch {
      /* ignore */
    }
    await ensureDir(backupDir);
    await writeText(metaPath(backupDir), JSON.stringify(meta));
    lastMeta = meta;
    return meta;
  }

  async function doRestore(backupDir) {
    const meta = lastMeta || JSON.parse((await readText(metaPath(backupDir))) || 'null');
    if (!meta?.cookies?.length) return { ok: false, error: '没有可用备份' };
    const ses = getSession();
    if (!ses) return { ok: false, error: '内核未就绪' };
    let ok = 0;
    let fail = 0;
    for (const c of meta.cookies) {
      try {
        const host = (c.domain || '').replace(/^\./, '');
        if (!host) {
          fail += 1;
          continue;
        }
        const param = {
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        };
        if (c.expirationDate && c.expirationDate > 0) param.expirationDate = c.expirationDate;
        if (c.sameSite === 'no_restriction' || c.sameSite === 'lax' || c.sameSite === 'strict') {
          param.sameSite = c.sameSite;
        }
        await ses.cookies.set(param);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    return { ok: true, restored: ok, failed: fail, total: meta.cookies.length };
  }

  /**
   * 心跳调用：翻转检测
   * @returns {{backup?:string, lost?:string[], canRestore?:boolean}}
   */
  function onLoginStatus(statusMap, backupDir) {
    const events = {};
    for (const [platform, loggedIn] of Object.entries(statusMap)) {
      const prev = lastState[platform];
      if (prev === undefined) {
        lastState[platform] = loggedIn;
        continue;
      }
      if (!prev && loggedIn) {
        events.backup = platform;
      }
      if (prev && !loggedIn) {
        events.lost = events.lost || [];
        events.lost.push(platform);
      }
      lastState[platform] = loggedIn;
    }
    if (events.lost) {
      events.canRestore = !!lastMeta;
    }
    return events;
  }

  function hasBackup() {
    return !!lastMeta;
  }

  function prefillMeta(meta) {
    lastMeta = meta;
  }

  return { doBackup, doRestore, onLoginStatus, hasBackup, prefillMeta };
}

/* ---- 小工具（避免依赖 fs/promises 顶层 await） ---- */
async function exists(p) {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function ensureDir(p) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(p, { recursive: true });
}
async function writeText(p, text) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(p, text, 'utf8');
}
async function readText(p) {
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}
async function copyIfExists(from, to) {
  const fs = await import('node:fs/promises');
  await fs.copyFile(from, to);
}
