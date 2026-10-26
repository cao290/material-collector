/** 素材采集器 · 前端 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  platform: 'douyin',
  platforms: [],
  settings: {},
  jobs: [],
  selected: new Set(),
  page: 0,
  pageSize: 60,
  total: 0,
  login: null,
  timer: null,
};

const PLATFORM_COLORS = {
  douyin: '#fe2c55',
  xhs: '#ff2442',
  bilibili: '#00aeec',
  kuaishou: '#ff5000',
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-wrap').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 6000 : 3200);
}

const fmtNum = (n) => {
  if (!n) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  return String(n);
};

const fmtDur = (sec) => {
  if (!sec) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

const fmtSize = (bytes) => {
  if (!bytes) return '—';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};

const fmtTime = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ---------------- 视图切换 ---------------- */
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', async () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'copy') {
      renderCopyPlatformPicker();
      loadCopyJobs();
      loadCopyData();
    }
    if (btn.dataset.view === 'transcribe') {
      renderTrPlatforms();
      loadTrStatus();
      loadTranscriptions();
    }
    if (btn.dataset.view === 'browser') {
      await showBrowserPane();
      const busy = state.jobs.some((j) => j.status === 'running' || j.status === 'pending');
      $('#bw-task-view').classList.toggle('hidden', !busy);
    } else {
      if (viewingTask) toggleTaskView();
      // 无条件隐藏：面板可能由外部 API 打开，前端状态未同步
      await hideBrowserPane();
    }
    if (btn.dataset.view === 'results') loadResults();
    if (btn.dataset.view === 'library') loadLibrary();
    if (btn.dataset.view === 'copy') loadCopyData();
    if (btn.dataset.view === 'settings') loadSettings();
  });
});

/* ---------------- 内置浏览器面板 ---------------- */
const HOME_URLS = {
  douyin: 'https://www.douyin.com',
  xhs: 'https://www.xiaohongshu.com',
  bilibili: 'https://www.bilibili.com',
  kuaishou: 'https://www.kuaishou.com',
};

let paneVisible = false;
let paneTimer = null;

function paneRect() {
  const el = $('#browser-pane');
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

async function showBrowserPane() {
  try {
    // 等一帧，确保 view-browser 已 display:block、面板尺寸可量
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = paneRect();
    if (rect.width < 200 || rect.height < 200) {
      // 尺寸异常：稍后再试一次，避免用错误尺寸挂载盖住界面
      await new Promise((r) => setTimeout(r, 120));
    }
    const r = await api('/browser/show', { method: 'POST', body: { rect: paneRect() } });
    if (r && r.ok === false) {
      toast('浏览器面板还没准备好，再点一次「内置浏览器」', 'err');
      return;
    }
    paneVisible = true;
    if (!paneTimer) paneTimer = setInterval(pollPaneState, 1200);
    window.addEventListener('resize', syncPaneBounds);
    // 有任务在跑时给个入口看任务画面
    const busy = state.jobs.some((j) => j.status === 'running' || j.status === 'pending');
    $('#bw-task-view').classList.toggle('hidden', !busy);
  } catch (error) {
    toast(error.message, 'err');
  }
}

let viewingTask = false;
let taskShotTimer = null;

function toggleTaskView() {
  viewingTask = !viewingTask;
  const pane = $('#browser-pane');
  const img = $('#task-shot');
  $('#bw-task-view').textContent = viewingTask ? '返回我的浏览' : '看任务画面';
  if (viewingTask) {
    if (!img) {
      const el = document.createElement('img');
      el.id = 'task-shot';
      el.className = 'task-shot';
      pane.append(el);
    }
    img.style.display = 'block';
    const tick = async () => {
      if (!viewingTask) return;
      try {
        const res = await fetch('/api/task/shot');
        if (res.status === 200) {
          const blob = await res.blob();
          img.src = URL.createObjectURL(blob);
          setTimeout(() => URL.revokeObjectURL(img.src), 3000);
        }
      } catch {
        /* ignore */
      }
      taskShotTimer = setTimeout(tick, 1500);
    };
    tick();
  } else {
    if (img) img.style.display = 'none';
    if (taskShotTimer) {
      clearTimeout(taskShotTimer);
      taskShotTimer = null;
    }
  }
}

async function hideBrowserPane() {
  // 不要因为前端状态是 false 就跳过——面板可能是外部 API 打开的，
  // 此时前端 paneVisible 未同步，跳过会导致面板一直挂在界面上遮挡
  paneVisible = false;
  try {
    await api('/browser/hide', { method: 'POST' });
  } catch {
    /* ignore */
  }
  if (paneTimer) {
    clearInterval(paneTimer);
    paneTimer = null;
  }
  window.removeEventListener('resize', syncPaneBounds);
}

function syncPaneBounds() {
  if (!paneVisible) return;
  api('/browser/bounds', { method: 'POST', body: { rect: paneRect() } }).catch(() => {});
}

async function pollPaneState() {
  try {
    const st = await api('/browser/state');
    const input = $('#bw-url');
    // 用户正在地址栏打字时不覆盖
    if (st.url && document.activeElement !== input) input.value = st.url;
  } catch {
    /* ignore */
  }
}

async function openInPane(url) {
  try {
    await api('/browser/navigate', { method: 'POST', body: { url } });
    if (!paneVisible) await showBrowserPane();
  } catch (error) {
    toast(error.message, 'err');
  }
}

// 平台快捷按钮
function renderQuickPlatforms() {
  const wrap = $('#bw-quick');
  wrap.innerHTML = '';
  for (const p of state.platforms) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.addEventListener('click', () => openInPane(HOME_URLS[p.id] || 'about:blank'));
    wrap.append(b);
  }
}

$('#bw-go').addEventListener('click', () => {
  let v = $('#bw-url').value.trim();
  if (!v) return;
  if (!/^https?:\/\//i.test(v)) {
    v = v.includes('.') ? 'https://' + v : 'https://www.bing.com/search?q=' + encodeURIComponent(v);
  }
  openInPane(v);
});
$('#bw-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#bw-go').click();
});
$('#bw-back').addEventListener('click', () => api('/browser/back', { method: 'POST' }).catch(() => {}));
$('#bw-forward').addEventListener('click', () => api('/browser/forward', { method: 'POST' }).catch(() => {}));
$('#bw-reload').addEventListener('click', () => api('/browser/reload', { method: 'POST' }).catch(() => {}));
$('#bw-task-view').addEventListener('click', toggleTaskView);

let paneMuted = true;
$('#bw-mute').addEventListener('click', async () => {
  paneMuted = !paneMuted;
  try {
    await api('/browser/mute', { method: 'POST', body: { muted: paneMuted } });
    $('#bw-mute').textContent = paneMuted ? '🔇 静音中' : '🔊 有声音';
  } catch (error) {
    toast(error.message, 'err');
  }
});

$('#bw-login-check').addEventListener('click', async () => {
  await checkLogin();
  const strip = $('#bw-login-strip');
  if (state.login?.platforms) {
    strip.innerHTML = state.login.platforms
      .map((p) => `<span><i class="dot" style="background:${p.loggedIn ? 'var(--ok)' : 'var(--text-mute)'}"></i>${p.label} ${p.loggedIn ? '已登录' : '未登录'}</span>`)
      .join('');
  }
});

/* ---------------- 初始化 ---------------- */
async function boot() {
  try {
    const health = await api('/health');
    state.platforms = health.platforms;
    state.settings = health.settings;
    renderPlatformPicker();
    renderQuickPlatforms();
    renderCopyPlatformPicker();
    bindCopyView();
    bindTranscribeView();
    renderBanner(health);
    updateBrowserState(health.browser);
    $('#target').value = health.settings.defaultTarget || 50;
    fillPlatformSelects();
    // 启动时确保浏览器面板不残留遮挡（可能上次是外部 API 打开的）
    await hideBrowserPane().catch(() => {});
    await checkLogin();
    await loadJobs();
    startHeartbeat();
  } catch (error) {
    toast('无法连接后端：' + error.message, 'err');
  }
}

function updateBrowserState(alive) {
  const el = $('#browser-state');
  el.classList.toggle('on', !!alive);
  el.querySelector('span').textContent = alive ? '内核就绪' : '内核未就绪';
}

function renderBanner(health) {
  const s = health.stats;
  const downloaded = s.downloaded?.n || 0;
  const totalItems = s.total?.n || 0;
  $('#library-summary').textContent =
    totalItems === 0
      ? '还没有素材，先去「采集」抓一些。'
      : `共 ${totalItems} 条素材，已下载 ${downloaded} 条，占用 ${fmtSize(s.total?.size || 0)}`;
}

function renderPlatformPicker() {
  const wrap = $('#platform-picker');
  wrap.innerHTML = '';
  for (const p of state.platforms) {
    const chip = document.createElement('button');
    chip.className = `platform-chip${p.id === state.platform ? ' active' : ''}`;
    chip.dataset.id = p.id;
    chip.innerHTML = `<i style="background:${p.color || PLATFORM_COLORS[p.id]}"></i>${p.label}<span class="logindot" data-login="${p.id}"></span>`;
    chip.addEventListener('click', () => {
      state.platform = p.id;
      $$('.platform-chip').forEach((c) => c.classList.toggle('active', c.dataset.id === p.id));
    });
    wrap.append(chip);
  }
}

function fillPlatformSelects() {
  const opts = state.platforms.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#filter-platform').innerHTML = `<option value="">全部平台</option>${opts}`;
  $('#lib-platform').innerHTML = `<option value="">全部平台</option>${opts}`;
}

/* ---------------- 登录状态 ---------------- */
async function checkLogin() {
  const wrap = $('#login-status');
  try {
    const data = await api('/login-status');
    state.login = data;
    updateBrowserState(data.browser);
    renderSideLogin(data);
    if (!data.browser) {
      wrap.innerHTML = '<span class="muted">内核未就绪，请重启软件</span>';
      $$('.logindot').forEach((d) => d.classList.remove('on'));
      return;
    }
    wrap.innerHTML = data.platforms
      .map(
        (p) =>
          `<span title="${escapeHtml(p.note || '')}"><i class="dot" style="background:${p.loggedIn ? 'var(--ok)' : 'var(--text-mute)'}"></i>${p.label} ${p.loggedIn ? '已登录' : '未登录'}${!p.loggedIn && p.note ? ' ⚠' : ''}</span>`
      )
      .join('');
    for (const p of data.platforms) {
      const dot = document.querySelector(`.logindot[data-login="${p.id}"]`);
      if (dot) dot.classList.toggle('on', !!p.loggedIn);
    }
    // 登录态丢失且有备份 → 提示一键恢复（每平台只提示一次）
    if (data.lost?.length && data.canRestore && !window.__lostPrompted) {
      window.__lostPrompted = true;
      const names = data.lost.map((id) => state.platforms.find((p) => p.id === id)?.label || id).join('、');
      showRestoreBanner(names);
    }
  } catch (error) {
    wrap.innerHTML = `<span class="muted">${error.message}</span>`;
  }
}

/** 侧栏四平台登录灯 */
function renderSideLogin(data) {
  const el = $('#side-login');
  if (!el) return;
  if (!data.browser) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = data.platforms
    .map(
      (p) =>
        `<span title="${p.loggedIn ? '已登录' : '未登录'}"><i class="dot" style="width:6px;height:6px;background:${p.loggedIn ? 'var(--ok)' : 'var(--text-mute)'}"></i>${p.label}</span>`
    )
    .join('');
}

/** 登录状态与任务轮询（常开） */
function startHeartbeat() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    loadJobs();
    checkLogin();
    if (document.querySelector('#view-copy').classList.contains('active')) loadCopyJobs();
    pollCaptchaAlert();
  }, 5000);
}

$('#btn-check-login').addEventListener('click', checkLogin);

// 侧栏状态点：内核随软件启动，无需手动开

/* ---------------- 采集任务 ---------------- */
$('#btn-start').addEventListener('click', async () => {
  const keywords = $('#keywords')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keywords.length) {
    toast('先填关键词', 'err');
    return;
  }
  const target = Number($('#target').value) || 50;
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    await api('/jobs', { method: 'POST', body: { platform: state.platform, keywords, target } });
    toast(`已启动 ${keywords.length} 个采集任务`, 'ok');
    await loadJobs();
  } catch (error) {
    if (error.message.includes('BUSY') || error.message.includes('忙')) {
      const bar = document.createElement('div');
      bar.className = 'restore-banner';
      bar.innerHTML = '⚠ 内核被占用（上一个任务/外部自动化会话未释放） <button class="btn small primary" id="btn-release-kernel">强制释放内核</button> <button class="btn small ghost" id="btn-dismiss-k">忽略</button>';
      const main = document.querySelector('.main');
      const old = main.querySelector('.restore-banner.kernel');
      if (old) old.remove();
      bar.classList.add('kernel');
      main.prepend(bar);
      bar.querySelector('#btn-release-kernel').addEventListener('click', async () => {
        try {
          await api('/kernel/release', { method: 'POST', body: {} });
          bar.remove();
          toast('内核已释放，可以重新开始采集', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      });
      bar.querySelector('#btn-dismiss-k').addEventListener('click', () => bar.remove());
    } else {
      toast(error.message, 'err');
    }
  } finally {
    btn.disabled = false;
  }
});

const STATUS_TEXT = {
  pending: '排队中',
  running: '采集中',
  need_human: '需要你操作',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
};

async function loadJobs() {
  try {
    const data = await api('/jobs');
    state.jobs = data.jobs;
    renderJobs();
    const active = data.jobs.some((j) => j.status === 'running' || j.status === 'pending');
    const needHuman = data.jobs.some((j) => j.status === 'need_human');
    if (active || needHuman) {
      if (!state.timer) state.timer = setInterval(loadJobs, 3000);
    }
  } catch {
    /* ignore */
  }
}

function renderJobs() {
  const list = $('#job-list');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty">还没有任务</div>';
    return;
  }
  list.innerHTML = state.jobs
    .map((job) => {
      const label = state.platforms.find((p) => p.id === job.platform)?.label || job.platform;
      const pct = job.target ? Math.min(100, Math.round((job.found / job.target) * 100)) : 0;
      const actions =
        job.status === 'need_human'
          ? `<button class="btn small primary" data-resume="${job.id}">我已登录，继续</button>
             <button class="btn small ghost" data-cancel="${job.id}">取消</button>`
          : job.status === 'running' || job.status === 'pending'
            ? `<button class="btn small ghost" data-cancel="${job.id}">取消</button>`
            : `<button class="btn small ghost" data-viewresults="${job.id}">看结果</button>`;
      return `<div class="job ${job.status}">
        <div class="job-main">
          <div class="job-title">
            <span class="pform">${label}</span>${escapeHtml(job.keyword)}
          </div>
          <div class="job-msg">${escapeHtml(job.message || STATUS_TEXT[job.status] || '')}</div>
          <div class="job-meta">已采 ${job.found} / 目标 ${job.target} · ${pct}% · ${fmtTime(job.created_at)}</div>
        </div>
        <div class="job-actions">${actions}</div>
      </div>`;
    })
    .join('');

  $$('[data-resume]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api('/jobs/resume', { method: 'POST', body: { jobId: btn.dataset.resume } });
        toast('已继续采集', 'ok');
        loadJobs();
      } catch (error) {
        toast(error.message, 'err');
      }
    })
  );
  $$('[data-cancel]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('/jobs/cancel', { method: 'POST', body: { jobId: btn.dataset.cancel } });
      loadJobs();
    })
  );
  $$('[data-viewresults]').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'results'));
      $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-results'));
      loadResults();
    })
  );
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ==================== 文案·评论 ==================== */
const copyState = {
  platform: 'bilibili',
  tab: 'copies',
  selected: new Set(),
  jobs: [],
};

let copyPlatformPickerDone = false;

function renderCopyPlatformPicker() {
  if (copyPlatformPickerDone || !state.platforms.length) return;
  const wrap = $('#copy-platform-picker');
  wrap.innerHTML = '';
  for (const p of state.platforms) {
    const chip = document.createElement('button');
    chip.className = `platform-chip${p.id === copyState.platform ? ' active' : ''}`;
    chip.dataset.id = p.id;
    chip.innerHTML = `<i style="background:${p.color || PLATFORM_COLORS[p.id]}"></i>${p.label}<span class="logindot" data-clogin="${p.id}"></span>`;
    chip.addEventListener('click', () => {
      copyState.platform = p.id;
      $$('#copy-platform-picker .platform-chip').forEach((c) => c.classList.toggle('active', c.dataset.id === p.id));
    });
    wrap.append(chip);
  }
  const opts = state.platforms.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#copy-filter-platform').innerHTML = `<option value="">全部平台</option>${opts}`;
  copyPlatformPickerDone = true;
}

async function startCopyJob() {
  const keywords = $('#copy-keywords').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!keywords.length) {
    toast('先填关键词', 'err');
    return;
  }
  try {
    const r = await api('/copy/jobs', {
      method: 'POST',
      body: {
        platform: copyState.platform,
        keywords,
        target: Number($('#copy-target').value) || 30,
        withComments: $('#copy-with-comments').checked,
        commentsPerVideo: Number($('#copy-cmt-limit').value) || 50,
      },
    });
    if (r.skipped?.length) {
      toast(r.message || `${r.skipped.length} 个关键词已有进行中任务`, 'err');
    } else if (r.jobIds?.length) {
      toast(`文案采集任务已启动（${r.jobIds.length} 个）`, 'ok');
    }
    loadCopyJobs();
  } catch (error) {
    toast(
      error.message.includes('BUSY')
        ? '内核忙：等上一个任务结束，或点「清理卡住的任务」'
        : error.message,
      'err'
    );
  }
}

async function clearStuckCopyJobs() {
  try {
    const r = await api('/copy/jobs/clear-stuck', { method: 'POST', body: {} });
    toast(`已清理 ${r.cleared} 个卡住的任务`, 'ok');
    loadCopyJobs();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function loadCopyJobs() {
  try {
    const data = await api('/copy/jobs');
    copyState.jobs = data.jobs;
    renderCopyJobs();
  } catch {
    /* ignore */
  }
}

function renderCopyJobs() {
  const list = $('#copy-job-list');
  if (!copyState.jobs.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = copyState.jobs.slice(0, 6).map((job) => {
    const label = state.platforms.find((p) => p.id === job.platform)?.label || job.platform;
    const act =
      job.status === 'need_human'
        ? `<button class="btn small primary" data-cresume="${job.id}">我已登录，继续</button><button class="btn small ghost" data-ccancel="${job.id}">取消</button>`
        : job.status === 'running'
          ? `<button class="btn small ghost" data-ccancel="${job.id}">取消</button>`
          : '';
    return `<div class="job ${job.status}">
      <div class="job-main">
        <div class="job-title"><span class="pform">${label}</span>${escapeHtml(job.keyword)}${job.with_comments ? ' <small class="muted">含评论</small>' : ''}</div>
        <div class="job-msg">${escapeHtml(job.message || '')}</div>
        <div class="job-meta">文案 ${job.found} / ${job.target}</div>
      </div>
      <div class="job-actions">${act}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-cresume]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = '继续中…';
    try {
      const r = await api('/copy/jobs/resume', { method: 'POST', body: { jobId: b.dataset.cresume } });
      toast(r.ok ? '已继续采集（沿用原任务记录）' : (r.message || '继续失败'), r.ok ? 'ok' : 'err');
      await loadCopyJobs();
    } catch (e) {
      toast(e.message.includes('BUSY') ? '内核忙：先点「清理卡住的任务」' : e.message, 'err');
      b.disabled = false;
      b.textContent = '我已登录，继续';
    }
  }));
  document.querySelectorAll('[data-ccancel]').forEach((b) => b.addEventListener('click', async () => {
    await api('/copy/jobs/cancel', { method: 'POST', body: { jobId: b.dataset.ccancel } }).catch(() => {});
    loadCopyJobs();
  }));
}

async function loadCopyData() {
  const params = new URLSearchParams({
    platform: $('#copy-filter-platform').value,
    keyword: $('#copy-filter-keyword').value,
    q: $('#copy-q').value.trim(),
  });
  try {
    const kw = await api('/copy/keywords');
    const uniq = [...new Set(kw.keywords.map((k) => k.keyword))];
    $('#copy-filter-keyword').innerHTML = '<option value="">全部关键词</option>' + uniq.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    if (copyState.tab === 'copies') {
      params.set('sort', 'likes');
      params.set('limit', '100');
      const data = await api(`/copies?${params}`);
      renderCopies(data.rows);
    } else {
      params.set('sort', 'likes');
      params.set('limit', '300');
      const data = await api(`/comments?${params}`);
      renderComments(data.rows);
    }
  } catch (error) {
    toast(error.message, 'err');
  }
}

function renderCopies(rows) {
  const pane = $('#copy-pane-copies');
  if (!rows.length) {
    pane.innerHTML = '<div class="empty">还没有文案，先采集一轮</div>';
    return;
  }
  pane.innerHTML = rows.map((c) => {
    const color = PLATFORM_COLORS[c.platform] || '#666';
    const label = state.platforms.find((p) => p.id === c.platform)?.label || c.platform;
    const sel = copyState.selected.has(c.id);
    return `<div class="copy-item${sel ? ' selected' : ''}" data-id="${c.id}">
      <div class="ci-head">
        <span class="ci-plat" style="background:${color}">${label}</span>
        <span>${escapeHtml(c.title || '(无标题)')}</span>
        <span class="ci-stats"><span>♥ ${fmtNum(c.likes)}</span><span>⭐ ${fmtNum(c.collects)}</span><span>💬 ${fmtNum(c.comments)}</span></span>
      </div>
      <div class="ci-body">${escapeHtml(c.content || c.title || '')}</div>
      <div class="ci-foot">
        <span>@${escapeHtml(c.author || '—')}</span>
        ${c.tags ? `<span class="ci-tags">${escapeHtml(c.tags)}</span>` : ''}
        ${c.keyword ? `<span>关键词：${escapeHtml(c.keyword)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  bindCopySelection(pane);
}

function renderComments(rows) {
  const pane = $('#copy-pane-comments');
  if (!rows.length) {
    pane.innerHTML = '<div class="empty">还没有评论，采集时勾选「同时采评论」</div>';
    return;
  }
  pane.innerHTML = rows.map((c) => {
    const color = PLATFORM_COLORS[c.platform] || '#666';
    const label = state.platforms.find((p) => p.id === c.platform)?.label || c.platform;
    const sel = copyState.selected.has(c.id);
    const indent = c.parent_id ? ' style="margin-left:26px"' : '';
    return `<div class="copy-item${sel ? ' selected' : ''}" data-id="${c.id}"${indent}>
      <div class="ci-head">
        <span class="ci-plat" style="background:${color}">${label}</span>
        <span>${c.parent_id ? '↳ ' : ''}@${escapeHtml(c.author || '—')}</span>
        <span class="ci-stats"><span>♥ ${fmtNum(c.likes)}</span>${c.location ? `<span>${escapeHtml(c.location)}</span>` : ''}${c.parent_id ? '<span>↳ 回复</span>' : ''}</span>
      </div>
      <div class="ci-body">${escapeHtml(c.content)}</div>
      <div class="ci-foot"><span class="cmt-target">视频：${escapeHtml(c.target_id)}</span>${c.keyword ? `<span>关键词：${escapeHtml(c.keyword)}</span>` : ''}</div>
    </div>`;
  }).join('');
  bindCopySelection(pane);
}

function bindCopySelection(pane) {
  for (const el of pane.querySelectorAll('.copy-item')) {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (copyState.selected.has(id)) copyState.selected.delete(id);
      else copyState.selected.add(id);
      el.classList.toggle('selected', copyState.selected.has(id));
      $('#copy-selected-count').textContent = `已选 ${copyState.selected.size}`;
    });
  }
}

async function runAiAction(action) {
  const body = { action };
  if (action === 'commentSummary' || copyState.tab === 'comments') {
    // 评论加工：取选中评论的目标视频，总结整组
    const first = [...copyState.selected][0];
    let targetId = '';
    if (first) {
      const row = document.querySelector(`#copy-pane-comments .copy-item[data-id="${first}"] .cmt-target`);
      targetId = row ? row.textContent.replace('视频：', '').trim() : '';
    }
    if (!targetId) {
      const groups = await api('/comments/groups');
      if (groups.groups.length) targetId = groups.groups[0].target_id;
    }
    if (!targetId) {
      toast('先采集一批评论', 'err');
      return;
    }
    body.targetId = targetId;
  } else {
    if (!copyState.selected.size) {
      toast('先勾选要加工的文案', 'err');
      return;
    }
    body.ids = [...copyState.selected];
  }
  const theme = $('#ai-theme').value.trim();
  if (action === 'imitate' && !theme) {
    toast('仿写需要先填「主题」', 'err');
    return;
  }
  if (theme) body.theme = theme;

  const btn = document.querySelector(`.ai-btn[data-action="${action}"]`);
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'AI 思考中…';
  try {
    const r = await api('/ai/run', { method: 'POST', body });
    if (!r.ok) throw new Error(r.error || '失败');
    showAiResult(r.label || action, r.output);
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function showAiResult(title, output) {
  const modal = $('#preview-modal');
  const content = $('#preview-content');
  content.innerHTML = `
    <h3 style="margin:0 0 12px">${escapeHtml(title)} · AI 结果</h3>
    <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:14px;max-height:52vh;overflow:auto" id="ai-output">${escapeHtml(output)}</div>
    <div class="actions" style="margin-top:14px">
      <button class="btn primary" id="ai-copy-btn">复制全文</button>
    </div>`;
  modal.classList.add('open');
  $('#ai-copy-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#ai-output').textContent);
    toast('已复制到剪贴板', 'ok');
  });
}

let captchaBannerShown = 0;

async function pollCaptchaAlert() {
  try {
    const r = await api('/captcha/alert');
    if (!r.alert) return;
    if (r.alert.at === captchaBannerShown) {
      // 同一次告警：若已检测到验证通过，更新提示
      if (r.alert.passed) {
        const bar = document.querySelector('.restore-banner.captcha');
        if (bar) bar.innerHTML = '✓ 验证已通过，请点任务的「我已登录，继续」';
      }
      return;
    }
    captchaBannerShown = r.alert.at;
    showCaptchaBanner(r.alert);
  } catch {
    /* ignore */
  }
}

function showCaptchaBanner(alert) {
  const main = document.querySelector('.main');
  const old = main.querySelector('.restore-banner.captcha');
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.className = 'restore-banner captcha';
  const label = state.platforms.find((p) => p.id === alert.platform)?.label || alert.platform || '';

  // 自动切到「内置浏览器」视图——验证码就在那个面板里，用户能直接看到
  if (alert.shownInPane) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'browser'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-browser'));
    showBrowserPane().catch(() => {});
  }

  bar.innerHTML = `⚠ ${escapeHtml(label)} 需要过验证码（${escapeHtml(alert.reason || '')}）——${escapeHtml(alert.hint || '请在内置浏览器里完成验证')}
    <button class="btn small primary" id="btn-captcha-done">我已通过验证，继续</button>
    <button class="btn small ghost" id="btn-captcha-view">重新显示验证页</button>`;
  main.prepend(bar);
  bar.querySelector('#btn-captcha-done').addEventListener('click', async () => {
    const r = await api('/captcha/done', { method: 'POST', body: {} }).catch(() => ({}));
    bar.remove();
    // 切回文案页，方便用户点「继续」
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'copy'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-copy'));
    hideBrowserPane().catch(() => {});
    loadCopyJobs();
    toast(r.resumed ? '已确认，任务正在自动继续…' : '已确认，请点任务的「我已登录，继续」', 'ok');
  });
  bar.querySelector('#btn-captcha-view').addEventListener('click', async () => {
    try {
      const r = await api('/captcha/bring-front', { method: 'POST', body: {} });
      if (!r.ok) toast(r.error || '没检测到验证码，可能已通过', 'err');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

function showRestoreBanner(names) {
  const bar = document.createElement('div');
  bar.className = 'restore-banner';
  bar.innerHTML = `⚠ 检测到 ${escapeHtml(names)} 登录态丢失，但发现之前的自动备份。<button class="btn small primary" id="btn-restore-login">一键恢复登录态</button> <button class="btn small ghost" id="btn-dismiss-restore">忽略</button>`;
  document.querySelector('.main').prepend(bar);
  bar.querySelector('#btn-restore-login').addEventListener('click', async () => {
    try {
      const r = await api('/login/restore', { method: 'POST', body: {} });
      if (r.ok) {
        bar.innerHTML = '✓ 正在恢复登录态，软件 3 秒后自动重启…';
        setTimeout(() => location.reload(), 8000);
      } else toast(r.error, 'err');
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  bar.querySelector('#btn-dismiss-restore').addEventListener('click', () => bar.remove());
}

function bindCopyView() {
  $('#btn-copy-start').addEventListener('click', startCopyJob);
  $('#btn-clear-stuck').addEventListener('click', clearStuckCopyJobs);
  document.querySelectorAll('.copy-toolbar .tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.copy-toolbar .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      copyState.tab = t.dataset.tab;
      copyState.selected.clear();
      $('#copy-selected-count').textContent = '已选 0';
      $('#copy-pane-copies').classList.toggle('hidden', copyState.tab !== 'copies');
      $('#copy-pane-comments').classList.toggle('hidden', copyState.tab !== 'comments');
      loadCopyData();
    })
  );
  ['copy-filter-platform', 'copy-filter-keyword'].forEach((id) => $(`#${id}`).addEventListener('change', loadCopyData));
  let copyTimer;
  $('#copy-q').addEventListener('input', () => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(loadCopyData, 350);
  });
  $('#btn-copy-select-all').addEventListener('click', () => {
    const items = [...document.querySelectorAll(copyState.tab === 'copies' ? '#copy-pane-copies .copy-item' : '#copy-pane-comments .copy-item')];
    const all = items.every((el) => copyState.selected.has(el.dataset.id));
    for (const el of items) {
      if (all) copyState.selected.delete(el.dataset.id);
      else copyState.selected.add(el.dataset.id);
      el.classList.toggle('selected', !all);
    }
    $('#copy-selected-count').textContent = `已选 ${copyState.selected.size}`;
  });
  document.querySelectorAll('#ai-bar .ai-btn').forEach((b) => b.addEventListener('click', () => runAiAction(b.dataset.action)));
}

/* ---------------- 视频转写 ---------------- */
const trState = {
  selected: new Set(),
  rows: [],
  taskId: '',
  timer: null,
  platDone: false,
};

function renderTrPlatforms() {
  if (trState.platDone || !state.platforms.length) return;
  const opts = state.platforms.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#tr-filter-platform').innerHTML = `<option value="">全部平台</option>${opts}`;
  $('#tr-scope-platform').innerHTML = `<option value="">全部平台</option>${opts}`;
  trState.platDone = true;
}

async function loadTrStatus() {
  const el = $('#tr-service-status');
  try {
    const s = await api('/transcribe/status');
    const audioOnly = $('#tr-audio-only').checked || $('#tr-scope').value === 'audio';
    const platform = $('#tr-scope-platform').value || '';
    const pending = await api(
      `/transcribe/pending?platform=${encodeURIComponent(platform)}${audioOnly ? '&audioOnly=1' : ''}`
    ).catch(() => ({ pending: '?' }));
    if (s.up) {
      const isGpu = s.device === 'cuda';
      const dev = isGpu ? `GPU×${s.cudaDevices}` : 'CPU';
      const warn = s.wantDevice === 'cuda' && !isGpu;
      el.innerHTML =
        `<span style="color:${warn ? 'var(--warn)' : 'var(--ok, #3c3)'}">服务运行中 · ${dev}/${s.compute} · 模型 ${s.model}</span>` +
        (warn ? ' <span style="color:var(--warn)">（CUDA 库缺失，已回退 CPU）</span>' : '') +
        ` · 待转写 ${pending.pending} 条${audioOnly ? '（含未下载素材）' : ''}`;
    } else {
      el.innerHTML = `<span style="color:var(--text-mute)">服务未启动（首次转写会自动拉起，加载模型约 10-30 秒）</span> · 待转写 ${pending.pending} 条`;
    }
  } catch (error) {
    el.textContent = `状态获取失败：${error.message}`;
  }
}

async function startTranscribe() {
  const scope = $('#tr-scope').value;
  const audioOnly = $('#tr-audio-only').checked;
  const body = {
    scope,
    limit: Number($('#tr-limit').value) || 5,
    language: $('#tr-language').value,
    model: $('#tr-model').value,
    audioOnly,
    dropAfter: $('#tr-drop-after').checked,
  };
  if (scope === 'platform') body.platform = $('#tr-scope-platform').value;
  const btn = $('#btn-tr-start');
  btn.disabled = true;
  btn.textContent = '准备中…';
  try {
    const r = await api('/transcribe', { method: 'POST', body });
    if (r.taskId) {
      trState.taskId = r.taskId;
      toast(`已开始转写 ${r.total} 条${audioOnly ? '（仅取音频）' : ''}`, 'ok');
      pollTrTask();
    }
  } catch (error) {
    toast(error.message, 'err');
    btn.disabled = false;
    btn.textContent = '开始转写';
  }
}

async function pollTrTask() {
  if (trState.timer) clearInterval(trState.timer);
  const btn = $('#btn-tr-start');
  trState.timer = setInterval(async () => {
    try {
      const t = await api(`/transcribe/task?id=${encodeURIComponent(trState.taskId)}`);
      btn.textContent = `转写中 ${t.done}/${t.total}…`;
      if (t.status === 'done') {
        clearInterval(trState.timer);
        trState.timer = null;
        btn.disabled = false;
        btn.textContent = '开始转写';
        toast(`转写完成：成功 ${t.ok}，失败 ${t.failed}`, t.failed ? '' : 'ok');
        loadTranscriptions();
        loadTrStatus();
      } else {
        renderTrJobs(t);
      }
    } catch {
      clearInterval(trState.timer);
      trState.timer = null;
      btn.disabled = false;
      btn.textContent = '开始转写';
    }
  }, 2000);
}

function renderTrJobs(t) {
  const list = $('#tr-job-list');
  const cur = t.current ? `<div class="job-msg">${escapeHtml(t.current)}</div>` : '';
  const audio = t.audioBytes ? `<div class="job-msg">已取音频 ${fmtSize(t.audioBytes)}</div>` : '';
  list.innerHTML = `<div class="job running">
    <div class="job-main">
      <div class="job-title">转写任务${t.audioOnly ? ' <small class="muted">仅取音频</small>' : ''}</div>
      ${cur}
      <div class="job-msg">成功 ${t.ok} · 失败 ${t.failed}</div>
      <div class="job-meta">进度 ${t.done} / ${t.total}</div>
    </div>
  </div>${audio}`;
}

async function restartTranscribeService() {
  const btn = $('#btn-tr-restart');
  btn.disabled = true;
  btn.textContent = '重启中…';
  try {
    const r = await api('/transcribe/restart', { method: 'POST', body: {} });
    toast(r.ok ? '转写服务已重启' : (r.error || '重启失败'), r.ok ? 'ok' : 'err');
    loadTrStatus();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '重启转写服务';
  }
}

async function loadTranscriptions() {
  const params = new URLSearchParams({
    platform: $('#tr-filter-platform').value,
    q: $('#tr-q').value.trim(),
    limit: '100',
  });
  try {
    const data = await api(`/transcriptions?${params}`);
    trState.rows = data.rows;
    renderTranscriptions(data.rows);
  } catch (error) {
    toast(error.message, 'err');
  }
}

function renderTranscriptions(rows) {
  const pane = $('#tr-list');
  if (!rows.length) {
    pane.innerHTML = '<div class="empty">还没有转写结果。上面选好范围点「开始转写」。</div>';
    return;
  }
  pane.innerHTML = rows.map((r) => {
    const color = PLATFORM_COLORS[r.platform] || '#666';
    const label = state.platforms.find((p) => p.id === r.platform)?.label || r.platform || '本地';
    const sel = trState.selected.has(r.id);
    const ok = r.status === 'done';
    return `<div class="copy-item${sel ? ' selected' : ''}" data-id="${r.id}">
      <div class="ci-head">
        <span class="ci-plat" style="background:${color}">${label}</span>
        <span>${escapeHtml(r.title || r.file_path.split(/[\\/]/).pop() || '(无标题)')}</span>
        <span class="ci-stats">
          ${r.duration ? `<span>⏱ ${fmtDur(r.duration)}</span>` : ''}
          <span>${r.char_count || 0} 字</span>
          <span>${r.device === 'cuda' ? 'GPU' : (r.device || '')}</span>
        </span>
      </div>
      <div class="ci-body">${
        ok
          ? escapeHtml((r.preview || '').slice(0, 240) || '(无口播内容)')
          : `<span style="color:var(--err)">${escapeHtml(r.error || '转写失败')}</span>`
      }</div>
      <div class="ci-foot">
        <span>${r.segment_count || 0} 段 · ${r.model || ''} ${r.elapsed ? `· ${r.elapsed}s` : ''}</span>
        <span class="tr-actions">
          <a class="tr-link" href="/api/transcriptions/get?id=${encodeURIComponent(r.id)}" data-tr-open="${r.id}">查看时间轴</a>
          <a class="tr-link" href="/api/transcriptions/srt?id=${encodeURIComponent(r.id)}">SRT</a>
          <a class="tr-link" href="/api/transcriptions/txt?id=${encodeURIComponent(r.id)}">TXT</a>
        </span>
      </div>
    </div>`;
  }).join('');
  bindTrSelection(pane);
}

function bindTrSelection(pane) {
  for (const el of pane.querySelectorAll('.copy-item')) {
    el.addEventListener('click', (event) => {
      if (event.target.closest('.tr-link')) return;
      const id = el.dataset.id;
      if (trState.selected.has(id)) trState.selected.delete(id);
      else trState.selected.add(id);
      el.classList.toggle('selected', trState.selected.has(id));
      $('#tr-selected-count').textContent = `已选 ${trState.selected.size}`;
    });
  }
  for (const link of pane.querySelectorAll('[data-tr-open]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const row = await api(`/transcriptions/get?id=${encodeURIComponent(link.dataset.trOpen)}`);
        showTranscript(row);
      } catch (error) {
        toast(error.message, 'err');
      }
    });
  }
}

function showTranscript(row) {
  const segs = Array.isArray(row.segments) ? row.segments : [];
  const tl = segs.length
    ? segs
        .map(
          (s) =>
            `<div class="tr-seg"><span class="tr-ts">${fmtDur(s.start)}</span><span class="tr-tx">${escapeHtml(s.text)}</span></div>`
        )
        .join('')
    : `<div style="white-space:pre-wrap">${escapeHtml(row.text || '(空)')}</div>`;
  const modal = $('#preview-modal');
  $('#preview-content').innerHTML = `
    <h3 style="margin:0 0 4px">${escapeHtml(row.title || '转写结果')}</h3>
    <div class="muted small" style="margin-bottom:12px">${row.language || ''} · ${fmtDur(row.duration || 0)} · ${row.char_count || 0} 字 · ${segs.length} 段</div>
    <div class="tr-timeline">${tl}</div>
    <div class="actions" style="margin-top:14px">
      <button class="btn primary" id="tr-copy-all">复制全文</button>
      <a class="btn ghost" href="/api/transcriptions/srt?id=${encodeURIComponent(row.id)}">下载 SRT</a>
      <a class="btn ghost" href="/api/transcriptions/txt?id=${encodeURIComponent(row.id)}">下载 TXT</a>
    </div>`;
  modal.classList.add('open');
  $('#tr-copy-all').addEventListener('click', async () => {
    await navigator.clipboard.writeText(row.text || '');
    toast('已复制全文', 'ok');
  });
}

async function runTrAiAction(action) {
  if (!trState.selected.size) {
    toast('先勾选转写结果', 'err');
    return;
  }
  const body = { action, transcriptIds: [...trState.selected] };
  const btn = document.querySelector(`#tr-ai-bar .ai-btn[data-tra="${action}"]`);
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'AI 思考中…';
  try {
    const r = await api('/ai/run', { method: 'POST', body });
    if (!r.ok) throw new Error(r.error || '失败');
    showAiResult(r.label || action, r.output);
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function bindTranscribeView() {
  $('#btn-tr-start').addEventListener('click', startTranscribe);
  $('#btn-tr-restart').addEventListener('click', restartTranscribeService);
  $('#btn-tr-refresh').addEventListener('click', () => {
    loadTrStatus();
    loadTranscriptions();
  });
  $('#tr-scope').addEventListener('change', () => {
    const scope = $('#tr-scope').value;
    $('#tr-scope-platform').classList.toggle('hidden', scope !== 'platform');
    loadTrStatus();
  });
  $('#tr-audio-only').addEventListener('change', loadTrStatus);
  $('#tr-scope-platform').addEventListener('change', loadTrStatus);
  $('#tr-filter-platform').addEventListener('change', loadTranscriptions);
  let t;
  $('#tr-q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(loadTranscriptions, 350);
  });
  document.querySelectorAll('#tr-ai-bar .ai-btn').forEach((b) => b.addEventListener('click', () => runTrAiAction(b.dataset.tra)));
}

/* ---------------- 下载进度条 ---------------- */
let dlTimer = null;

function startDlPolling() {
  if (dlTimer) return;
  dlTimer = setInterval(async () => {
    try {
      const data = await api('/downloads');
      const active = data.downloads.filter((d) => d.status === 'downloading');
      const strip = $('#dl-strip');
      if (!active.length) {
        strip.classList.add('hidden');
        clearInterval(dlTimer);
        dlTimer = null;
        return;
      }
      strip.classList.remove('hidden');
      const total = active.reduce((acc, d) => acc + (d.total || 0), 0);
      const received = active.reduce((acc, d) => acc + (d.received || 0), 0);
      const speed = active.reduce((acc, d) => acc + (d.speed || 0), 0);
      const first = active[0];
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        $('#dl-fill').style.width = pct + '%';
        $('#dl-info').textContent = `下载中 ${active.length} 个 · ${fmtSize(received)} / ${fmtSize(total)} · ${fmtSize(speed)}/s · ${first.title || ''}`;
      } else {
        $('#dl-fill').style.width = '30%';
        $('#dl-info').textContent = `下载中 ${active.length} 个 · 已取 ${fmtSize(received)} · ${fmtSize(speed)}/s · ${first.title || ''}`;
      }
    } catch {
      /* ignore */
    }
  }, 1200);
}

/* ---------------- 结果视图 ---------------- */
let resultsLoaded = false;
async function loadResults() {
  if (!resultsLoaded) {
    resultsLoaded = true;
    await loadKeywords();
  }
  const params = new URLSearchParams({
    platform: $('#filter-platform').value,
    keyword: $('#filter-keyword').value,
    status: $('#filter-status').value,
    q: $('#search-q').value.trim(),
    sort: $('#sort-by').value,
    limit: state.pageSize,
    offset: state.page * state.pageSize,
  });
  try {
    const data = await api(`/items?${params}`);
    state.total = data.total;
    renderResults(data.rows);
    renderPager();
    renderBanner({ stats: { total: { n: data.total, size: 0 }, downloaded: { n: data.rows.filter((r) => r.status === 'done').length } } });
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function loadKeywords() {
  try {
    const data = await api('/keywords');
    const uniq = [...new Set(data.keywords.map((k) => k.keyword))];
    $('#filter-keyword').innerHTML =
      `<option value="">全部关键词</option>` + uniq.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
  } catch {
    /* ignore */
  }
}

function renderResults(rows) {
  const grid = $('#result-grid');
  if (!rows.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">没有素材，先去「采集」抓一些</div>';
    return;
  }
  grid.innerHTML = rows.map((item, index) => tileHtml(item, true, index)).join('');
  bindTiles(grid, rows);
}

function tileHtml(item, selectable, index = 99) {
  const color = PLATFORM_COLORS[item.platform] || '#666';
  const label = state.platforms.find((p) => p.id === item.platform)?.label || item.platform;
  const selected = state.selected.has(item.id);
  const done = item.status === 'done';
  return `<div class="tile${selected ? ' selected' : ''}" data-id="${item.id}">
    <div class="thumb">
      ${item.cover ? `<img loading="${index < 24 ? 'eager' : 'lazy'}" src="/api/proxy/image?url=${encodeURIComponent(item.cover)}" alt="" />` : ''}
      ${item.video_url ? `<video muted loop preload="none" poster="${escapeHtml(item.cover)}" src="/api/proxy/video?url=${encodeURIComponent(item.video_url)}&platform=${item.platform}"></video>` : ''}
      <span class="plat" style="background:${color}">${label}</span>
      ${item.duration ? `<span class="dur">${fmtDur(item.duration)}</span>` : ''}
      ${selectable ? `<span class="check">${selected ? '✓' : ''}</span>` : ''}
      ${done ? `<span class="mark">✓</span>` : ''}
    </div>
    <div class="info">
      <div class="title">${escapeHtml(item.title || '(无标题)')}</div>
      <div class="sub">
        <span class="author">${escapeHtml(item.author || '—')}</span>
        ${item.likes ? `<span>♥ ${fmtNum(item.likes)}</span>` : ''}
        ${item.status === 'error' ? '<span style="color:var(--err)">失败</span>' : ''}
      </div>
    </div>
  </div>`;
}

const freshUrlCache = new Map();

async function ensureFreshUrl(item) {
  if (item.platform !== 'bilibili' || !item.video_url) return item.video_url;
  if (freshUrlCache.has(item.id)) return freshUrlCache.get(item.id);
  try {
    const r = await api(`/items/fresh-url?id=${encodeURIComponent(item.id)}`);
    if (r.ok && r.video_url) {
      item.video_url = r.video_url;
      freshUrlCache.set(item.id, r.video_url);
      return r.video_url;
    }
  } catch {
    /* 409/失败回退旧直链 */
  }
  return item.video_url;
}

function bindTiles(grid, rows) {
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const tile of grid.querySelectorAll('.tile')) {
    const id = tile.dataset.id;
    const item = map.get(id);

    tile.querySelector('.thumb')?.addEventListener('mouseenter', async (event) => {
      const video = tile.querySelector('video');
      if (!video) return;
      if (item.platform === 'bilibili' && !freshUrlCache.has(item.id)) {
        await ensureFreshUrl(item);
        video.src = `/api/proxy/video?url=${encodeURIComponent(item.video_url)}&platform=${item.platform}`;
      }
      video.play().catch(() => {});
    });
    tile.addEventListener('mouseleave', () => {
      const video = tile.querySelector('video');
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
    });

    tile.querySelector('.check')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      tile.classList.toggle('selected', state.selected.has(id));
      const check = tile.querySelector('.check');
      if (check) check.textContent = state.selected.has(id) ? '✓' : '';
      $('#selected-count').textContent = state.selected.size;
    });

    tile.addEventListener('click', () => openPreview(item));
  }
}

function renderPager() {
  const pages = Math.ceil(state.total / state.pageSize);
  const pager = $('#result-pager');
  if (pages <= 1) {
    pager.innerHTML = '';
    return;
  }
  pager.innerHTML = `
    <button class="btn small ghost" ${state.page === 0 ? 'disabled' : ''} data-page="${state.page - 1}">上一页</button>
    <span>${state.page + 1} / ${pages} · 共 ${state.total} 条</span>
    <button class="btn small ghost" ${state.page >= pages - 1 ? 'disabled' : ''} data-page="${state.page + 1}">下一页</button>`;
  $$('[data-page]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.page = Number(btn.dataset.page);
      loadResults();
    })
  );
}

['filter-platform', 'filter-keyword', 'filter-status', 'sort-by'].forEach((id) =>
  $(`#${id}`).addEventListener('change', () => {
    state.page = 0;
    loadResults();
  })
);

let searchTimer;
$('#search-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.page = 0;
    loadResults();
  }, 350);
});

$('#btn-select-all').addEventListener('click', () => {
  const tiles = $$('#result-grid .tile');
  const allSelected = tiles.every((t) => state.selected.has(t.dataset.id));
  for (const tile of tiles) {
    if (allSelected) state.selected.delete(tile.dataset.id);
    else state.selected.add(tile.dataset.id);
    tile.classList.toggle('selected', state.selected.has(tile.dataset.id));
    const check = tile.querySelector('.check');
    if (check) check.textContent = state.selected.has(tile.dataset.id) ? '✓' : '';
  }
  $('#selected-count').textContent = state.selected.size;
});

async function runDownload(ids, btn) {
  const start = await api('/download', { method: 'POST', body: { ids } });
  if (!start.taskId) throw new Error('没有拿到下载任务');
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const task = await api(`/download/task?id=${start.taskId}`);
        if (btn) btn.textContent = `下载中 ${task.done}/${task.total}`;
        if (task.status === 'running') {
          setTimeout(tick, 2000);
          return;
        }
        resolve(task);
      } catch (error) {
        resolve({ status: 'error', ok: 0, failed: ids.length, results: [], error: error.message });
      }
    };
    setTimeout(tick, 1200);
  });
}

$('#btn-download-selected').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('先勾选要下载的素材', 'err');
    return;
  }
  const btn = $('#btn-download-selected');
  btn.disabled = true;
  btn.textContent = '下载中…';
  startDlPolling();
  try {
    const task = await runDownload(ids, btn);
    const fail = task.failed || 0;
    const okCount = task.ok || 0;
    toast(`下载完成：成功 ${okCount}${fail ? `，失败 ${fail}` : ''}`, fail ? 'err' : 'ok');
    loadKeywords();
    if (fail) {
      const failed = (task.results || []).filter((r) => !r.ok);
      if (failed.length) console.warn('失败明细', failed);
    }
    state.selected.clear();
    $('#selected-count').textContent = '0';
    loadResults();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '下载选中 (<span id="selected-count">0</span>)';
    $('#selected-count').textContent = state.selected.size;
  }
});

/* ---------------- 素材库 ---------------- */
async function loadLibrary() {
  const params = new URLSearchParams({
    platform: $('#lib-platform').value,
    q: $('#lib-q').value.trim(),
    status: 'done',
    limit: 300,
    sort: 'new',
  });
  try {
    const data = await api(`/items?${params}`);
    const grid = $('#library-grid');
    if (!data.rows.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">素材库还是空的</div>';
      return;
    }
    grid.innerHTML = data.rows
      .map(
        (item, index) => `<div class="tile" data-id="${item.id}">
          <div class="thumb">
            ${item.local_path
              ? `<img loading="${index < 24 ? 'eager' : 'lazy'}" src="/media/${encodeURIComponent(item.local_path.replace(/\.mp4$/i, '.jpg'))}" onerror="this.onerror=null;this.src='/api/proxy/image?url=${encodeURIComponent(item.cover)}'" alt="" />`
              : item.cover
                ? `<img loading="lazy" src="/api/proxy/image?url=${encodeURIComponent(item.cover)}" alt="" />`
                : ''}
            <span class="plat" style="background:${PLATFORM_COLORS[item.platform] || '#666'}">${state.platforms.find((p) => p.id === item.platform)?.label || item.platform}</span>
            ${item.duration ? `<span class="dur">${fmtDur(item.duration)}</span>` : ''}
          </div>
          <div class="info">
            <div class="title">${escapeHtml(item.title)}</div>
            <div class="sub">
              <span class="author">${escapeHtml(item.author || '—')}</span>
              <span>${fmtSize(item.local_size)}</span>
            </div>
          </div>
        </div>`
      )
      .join('');

    const map = new Map(data.rows.map((r) => [r.id, r]));
    for (const tile of grid.querySelectorAll('.tile')) {
      tile.addEventListener('click', () => openPreview(map.get(tile.dataset.id), true));
    }
  } catch (error) {
    toast(error.message, 'err');
  }
}

$('#lib-platform').addEventListener('change', loadLibrary);
let libTimer;
$('#lib-q').addEventListener('input', () => {
  clearTimeout(libTimer);
  libTimer = setTimeout(loadLibrary, 350);
});

$('#btn-open-folder').addEventListener('click', async () => {
  try {
    await api('/reveal', { method: 'POST', body: { path: state.settings.downloadDir } });
  } catch (error) {
    toast(error.message, 'err');
  }
});

$('#btn-export').addEventListener('click', () => {
  window.open('/api/export', '_blank');
});

/* ---------------- 预览 ---------------- */
function openPreview(item, isLibrary = false) {
  if (!item) return;
  const modal = $('#preview-modal');
  const content = $('#preview-content');
  const src = isLibrary && item.local_path
    ? `/media/${encodeURIComponent(item.local_path)}`
    : item.video_url || '';
  const meta = [
    ['平台', state.platforms.find((p) => p.id === item.platform)?.label || item.platform],
    ['标题', item.title],
    ['文案', item.desc],
    ['话题', item.tags],
    ['BGM', item.music],
    ['作者', item.author],
    ['点赞', fmtNum(item.likes)],
    ['时长', fmtDur(item.duration)],
    ['发布', item.published],
    ['关键词', item.keyword],
    ['原链接', item.page_url ? `<a href="${escapeHtml(item.page_url)}" target="_blank" rel="noreferrer">打开原页</a>` : ''],
    ['本地文件', item.local_path || '未下载'],
  ].filter(([, v]) => v);

  content.innerHTML = `
    ${src ? `<video class="preview-video" src="${escapeHtml(src)}" controls playsinline ${item.cover && !isLibrary ? `poster="${escapeHtml(item.cover)}"` : ''}></video>` : '<div class="empty">没有可播放的地址（可能直链未取到）</div>'}
    <dl class="preview-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${k === '原链接' ? v : escapeHtml(String(v))}</dd>`).join('')}</dl>
    <div class="actions" style="margin-top:16px">
      ${!isLibrary ? `<button class="btn primary" id="preview-download">下载这条</button>` : ''}
      ${item.local_path ? `<button class="btn ghost" id="preview-reveal">打开所在文件夹</button>` : ''}
    </div>`;
  modal.classList.add('open');

  $('#preview-download')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = '下载中…';
    startDlPolling();
    try {
      const task = await runDownload([item.id], btn);
      if (task.ok) toast('已下载', 'ok');
      else toast(`下载失败：${(task.results?.[0]?.error || '').slice(0, 120)}`, 'err');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '下载这条';
    }
  });
  $('#preview-reveal')?.addEventListener('click', async () => {
    const dir = item.local_path.replace(/[\\/][^\\/]+$/, '');
    await api('/reveal', { method: 'POST', body: { path: dir } });
  });
}

$('#modal-close').addEventListener('click', () => {
  $('#preview-modal').classList.remove('open');
  $('#preview-content').innerHTML = '';
});
$('#preview-modal').addEventListener('click', (event) => {
  if (event.target.id === 'preview-modal') {
    $('#preview-modal').classList.remove('open');
    $('#preview-content').innerHTML = '';
  }
});

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  try {
    const s = await api('/settings');
    state.settings = s;
    $('#set-downloadDir').value = s.downloadDir;
    $('#set-concurrency').value = s.concurrency;
    $('#set-defaultTarget').value = s.defaultTarget;
    $('#set-delayMin').value = s.delayMin;
    $('#set-delayMax').value = s.delayMax;
    $('#set-webhookUrl').value = s.webhookUrl || '';
    await loadAiConfig();
    checkTools();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function checkTools() {
  const el = $('#tool-status');
  try {
    const health = await api('/health');
    const rows = [
      ['浏览器', health.browser ? '已连接（调试端口就绪）' : '未启动'],
      ['素材总数', `${health.stats.total.n} 条`],
      ['已下载', `${health.stats.downloaded.n} 条`],
      ['占用空间', fmtSize(health.stats.total.size)],
    ];
    el.innerHTML = rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`)
      .join('');
  } catch (error) {
    el.innerHTML = `<span style="color:var(--err)">${error.message}</span>`;
  }
}

async function loadAiConfig() {
  try {
    const c = await api('/ai/config');
    $('#set-aiBaseUrl').value = c.aiBaseUrl || '';
    $('#set-aiModel').value = c.aiModel || '';
    $('#set-aiApiKey').value = '';
    $('#set-aiApiKey').placeholder = c.hasKey ? '已保存（留空保持不变）' : 'sk-…（本地服务可留空）';
    $('#ai-config-status').textContent = c.hasKey || c.aiBaseUrl ? '已配置' : '未配置：填好后点「测试连接」';
  } catch {
    /* ignore */
  }
}

$('#btn-ai-test').addEventListener('click', async () => {
  const btn = $('#btn-ai-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    await api('/ai/config', {
      method: 'POST',
      body: {
        aiBaseUrl: $('#set-aiBaseUrl').value.trim(),
        aiModel: $('#set-aiModel').value.trim(),
        ...( $('#set-aiApiKey').value ? { aiApiKey: $('#set-aiApiKey').value } : {}),
      },
    });
    const r = await api('/ai/test', { method: 'POST', body: {} });
    $('#ai-config-status').textContent = r.ok ? `连接成功：${r.reply || 'OK'}` : `失败：${r.error}`;
    toast(r.ok ? '模型接口可用' : '连接失败，看设置页提示', r.ok ? 'ok' : 'err');
  } catch (error) {
    $('#ai-config-status').textContent = error.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
});

$('#btn-ai-models').addEventListener('click', async () => {
  try {
    await api('/ai/config', {
      method: 'POST',
      body: {
        aiBaseUrl: $('#set-aiBaseUrl').value.trim(),
        aiModel: $('#set-aiModel').value.trim(),
        ...( $('#set-aiApiKey').value ? { aiApiKey: $('#set-aiApiKey').value } : {}),
      },
    });
    const r = await api('/ai/models');
    if (!r.ok || !r.models.length) {
      $('#ai-config-status').textContent = `拉取失败：${r.error || '没有模型'}`;
      return;
    }
    $('#ai-config-status').textContent = `共 ${r.models.length} 个模型`;
    const input = $('#set-aiModel');
    const dl = document.createElement('div');
    dl.style.cssText = 'max-height:140px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px;margin-top:6px;font-size:12px';
    dl.innerHTML = r.models.slice(0, 50).map((m) => `<div style="cursor:pointer;padding:3px 6px" class="ai-model-opt">${escapeHtml(m)}</div>`).join('');
    const old = document.querySelector('#ai-model-list');
    if (old) old.remove();
    dl.id = 'ai-model-list';
    input.after(dl);
    dl.addEventListener('click', (e) => {
      if (e.target.classList.contains('ai-model-opt')) {
        input.value = e.target.textContent;
        dl.remove();
      }
    });
  } catch (error) {
    $('#ai-config-status').textContent = error.message;
  }
});

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    const body = {
      downloadDir: $('#set-downloadDir').value.trim(),
      concurrency: Number($('#set-concurrency').value),
      defaultTarget: Number($('#set-defaultTarget').value),
      delayMin: Number($('#set-delayMin').value),
      delayMax: Number($('#set-delayMax').value),
      webhookUrl: $('#set-webhookUrl').value.trim(),
    };
    state.settings = await api('/settings', { method: 'POST', body });
    toast('设置已保存', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
});

boot();
