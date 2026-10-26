# -*- coding: utf-8 -*-
# 补丁：web/app.js 加文案·评论视图逻辑
import io

p = r'.\web\app.js'
s = io.open(p, encoding='utf-8').read()

marker = "/* ---------------- 下载进度条 ---------------- */"

addition = """/* ==================== 文案·评论 ==================== */
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
  const keywords = $('#copy-keywords').value.split('\\n').map((x) => x.trim()).filter(Boolean);
  if (!keywords.length) {
    toast('先填关键词', 'err');
    return;
  }
  try {
    await api('/copy/jobs', {
      method: 'POST',
      body: {
        platform: copyState.platform,
        keywords,
        target: Number($('#copy-target').value) || 30,
        withComments: $('#copy-with-comments').checked,
      },
    });
    toast('文案采集任务已启动', 'ok');
    loadCopyJobs();
  } catch (error) {
    toast(error.message.includes('BUSY') ? '内核忙：等视频采集/上一个任务结束' : error.message, 'err');
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
    try { await api('/copy/jobs/resume', { method: 'POST', body: { jobId: b.dataset.cresume } }); loadCopyJobs(); } catch (e) { toast(e.message, 'err'); }
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
    return `<div class="copy-item${sel ? ' selected' : ''}" data-id="${c.id}">
      <div class="ci-head">
        <span class="ci-plat" style="background:${color}">${label}</span>
        <span>@${escapeHtml(c.author || '—')}</span>
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

function bindCopyView() {
  $('#btn-copy-start').addEventListener('click', startCopyJob);
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
  document.querySelectorAll('.ai-btn').forEach((b) => b.addEventListener('click', () => runAiAction(b.dataset.action)));
}

/* ---------------- 下载进度条 ---------------- */"""

assert marker in s, 'marker not found'
s = s.replace(marker, addition, 1)

# 视图切换挂钩
old_switch = """    if (btn.dataset.view === 'browser') await showBrowserPane();"""
new_switch = """    if (btn.dataset.view === 'copy') {
      renderCopyPlatformPicker();
      loadCopyJobs();
      loadCopyData();
    }
    if (btn.dataset.view === 'browser') await showBrowserPane();"""
assert old_switch in s
s = s.replace(old_switch, new_switch)

# boot 里绑定 + 平台选择器
old_boot = """    renderPlatformPicker();
    renderQuickPlatforms();
    renderBanner(health);"""
new_boot = """    renderPlatformPicker();
    renderQuickPlatforms();
    renderCopyPlatformPicker();
    bindCopyView();
    renderBanner(health);"""
assert old_boot in s
s = s.replace(old_boot, new_boot)

# 心跳里带上文案任务
old_hb = """  state.timer = setInterval(() => {
    loadJobs();
    checkLogin();
  }, 5000);"""
new_hb = """  state.timer = setInterval(() => {
    loadJobs();
    checkLogin();
    if (document.querySelector('#view-copy').classList.contains('active')) loadCopyJobs();
  }, 5000);"""
assert old_hb in s
s = s.replace(old_hb, new_hb)

# 设置页 AI 配置逻辑
old_set = """$('#btn-save-settings').addEventListener('click', async () => {"""
new_set = """async function loadAiConfig() {
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

$('#btn-save-settings').addEventListener('click', async () => {"""
assert old_set in s
s = s.replace(old_set, new_set, 1)

# loadSettings 里带上 AI 配置
old_ls = """    $('#set-delayMin').value = s.delayMin;
    $('#set-delayMax').value = s.delayMax;
    checkTools();"""
new_ls = """    $('#set-delayMin').value = s.delayMin;
    $('#set-delayMax').value = s.delayMax;
    await loadAiConfig();
    checkTools();"""
assert old_ls in s
s = s.replace(old_ls, new_ls)

io.open(p, 'w', encoding='utf-8').write(s)
print('app.js patched')
