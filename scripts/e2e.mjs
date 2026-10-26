/**
 * 端到端测试：采集 → 入库 → 下载
 * 用 Node 发请求，避免 shell 编码把中文搞坏
 */
const BASE = 'http://127.0.0.1:8343';

async function post(path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function get(path) {
  const res = await fetch(BASE + '/api' + path);
  return res.json();
}

const mode = process.argv[2] || 'collect';
const platform = process.argv[3] || 'bilibili';
const keyword = process.argv[4] || '城市夜景';
const target = Number(process.argv[5]) || 20;

if (mode === 'collect') {
  console.log(`[1] 登录状态`);
  console.log(JSON.stringify(await get('/login-status')));
  console.log(`[2] 发起采集 ${platform} / ${keyword} / ${target}`);
  const started = await post('/jobs', { platform, keywords: [keyword], target });
  console.log(started);
  const jobId = started.jobIds[0];
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const { jobs } = await get('/jobs');
    const job = jobs.find((j) => j.id === jobId);
    console.log(`  ${job.status} found=${job.found} ${job.message}`);
    if (['done', 'error', 'need_human', 'cancelled'].includes(job.status)) break;
  }
  const items = await get(`/items?platform=${platform}&keyword=${encodeURIComponent(keyword)}&limit=5`);
  console.log(`[3] 入库 ${items.total} 条，前 5：`);
  for (const r of items.rows) {
    console.log(`  ${r.platform_id} | ${r.title.slice(0, 40)} | ${r.author} | ${r.duration}s | likes=${r.likes}`);
  }
  const ids = items.rows.slice(0, 2).map((r) => r.id);
  if (ids.length && process.argv.includes('--download')) {
    console.log(`[4] 下载 ${ids.length} 条`);
    const dl = await post('/download', { ids });
    console.log(JSON.stringify(dl, null, 1));
  }
}

if (mode === 'download') {
  const items = await get(`/items?platform=${platform}&status=new&limit=2`);
  console.log('待下载', items.total);
  if (items.rows.length) {
    const dl = await post('/download', { ids: items.rows.map((r) => r.id) });
    console.log(JSON.stringify(dl, null, 1));
  }
}

if (mode === 'reset') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('./data/library.db');
  db.exec('DELETE FROM items; DELETE FROM jobs; DELETE FROM downloads;');
  console.log('已清空测试数据');
}
