/**
 * 文案 / 评论 / AI 结果的数据层（独立于 db.mjs，共用同一个 SQLite 文件）
 */
import { DatabaseSync } from 'node:sqlite';

const now = () => Date.now();

export function ensureCopySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_jobs (
      id            TEXT PRIMARY KEY,
      platform      TEXT NOT NULL,
      keyword       TEXT NOT NULL,
      mode          TEXT NOT NULL DEFAULT 'search',
      target        INTEGER NOT NULL DEFAULT 30,
      with_comments INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      found         INTEGER NOT NULL DEFAULT 0,
      message       TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS copies (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      keyword     TEXT DEFAULT '',
      title       TEXT DEFAULT '',
      content     TEXT DEFAULT '',
      tags        TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      likes       INTEGER DEFAULT 0,
      collects    INTEGER DEFAULT 0,
      comments    INTEGER DEFAULT 0,
      duration    REAL DEFAULT 0,
      page_url    TEXT DEFAULT '',
      music       TEXT DEFAULT '',
      published   TEXT DEFAULT '',
      extra       TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(platform, platform_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      comment_id  TEXT NOT NULL,
      parent_id   TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      content     TEXT DEFAULT '',
      likes       INTEGER DEFAULT 0,
      replies     INTEGER DEFAULT 0,
      location    TEXT DEFAULT '',
      page_url    TEXT DEFAULT '',
      keyword     TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      UNIQUE(platform, comment_id)
    );

    CREATE TABLE IF NOT EXISTS ai_results (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      action      TEXT NOT NULL,
      model       TEXT DEFAULT '',
      input_ids   TEXT DEFAULT '',
      input_text  TEXT DEFAULT '',
      output      TEXT DEFAULT '',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_copies_platform ON copies(platform);
    CREATE INDEX IF NOT EXISTS idx_copies_keyword  ON copies(keyword);
    CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_id);
    CREATE INDEX IF NOT EXISTS idx_comments_platform ON comments(platform);
  `);
}

/* ---------- 文案任务 ---------- */

export function createCopyJob(db, { platform, keyword, mode, target, withComments }) {
  const id = `cjob-${now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO copy_jobs (id, platform, keyword, mode, target, with_comments, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?)`
  ).run(id, platform, keyword, mode || 'search', target || 30, withComments ? 1 : 0, now(), now());
  return id;
}

export function updateCopyJob(db, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  db.prepare(`UPDATE copy_jobs SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...fields.map((f) => patch[f]),
    now(),
    id
  );
}

export function listCopyJobs(db, limit = 30) {
  return db.prepare(`SELECT * FROM copy_jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function getCopyJob(db, id) {
  return db.prepare(`SELECT * FROM copy_jobs WHERE id = ?`).get(id);
}

/* ---------- 文案 ---------- */

export function upsertCopy(db, copy) {
  const ts = now();
  const existing = db
    .prepare(`SELECT id FROM copies WHERE platform = ? AND platform_id = ?`)
    .get(copy.platform, copy.platform_id);
  if (existing) {
    db.prepare(
      `UPDATE copies SET title = COALESCE(NULLIF(?, ''), title),
         content = COALESCE(NULLIF(?, ''), content),
         tags = COALESCE(NULLIF(?, ''), tags),
         author = COALESCE(NULLIF(?, ''), author),
         likes = CASE WHEN ?> 0 THEN ? ELSE likes END,
         collects = CASE WHEN ?> 0 THEN ? ELSE collects END,
         comments = CASE WHEN ?> 0 THEN ? ELSE comments END,
         page_url = COALESCE(NULLIF(?, ''), page_url),
         music = COALESCE(NULLIF(?, ''), music),
         published = COALESCE(NULLIF(?, ''), published),
         extra = COALESCE(NULLIF(?, ''), extra),
         updated_at = ?
       WHERE id = ?`
    ).run(
      copy.title || '',
      copy.content || '',
      copy.tags || '',
      copy.author || '',
      copy.likes || 0, copy.likes || 0,
      copy.collects || 0, copy.collects || 0,
      copy.comments || 0, copy.comments || 0,
      copy.page_url || '',
      copy.music || '',
      copy.published || '',
      copy.extra || '',
      ts,
      existing.id
    );
    return { id: existing.id, inserted: false };
  }
  const id = `copy_${copy.platform}_${copy.platform_id}`;
  db.prepare(
    `INSERT INTO copies (id, platform, platform_id, keyword, title, content, tags, author,
       likes, collects, comments, duration, page_url, music, published, extra, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    copy.platform,
    copy.platform_id,
    copy.keyword || '',
    copy.title || '',
    copy.content || '',
    copy.tags || '',
    copy.author || '',
    copy.likes || 0,
    copy.collects || 0,
    copy.comments || 0,
    copy.duration || 0,
    copy.page_url || '',
    copy.music || '',
    copy.published || '',
    copy.extra || '',
    ts,
    ts
  );
  return { id, inserted: true };
}

export function queryCopies(db, { platform, keyword, q, limit = 100, offset = 0, sort = 'likes' } = {}) {
  const where = [];
  const params = [];
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (keyword) { where.push('keyword = ?'); params.push(keyword); }
  if (q) {
    where.push('(title LIKE ? OR content LIKE ? OR tags LIKE ? OR author LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const order = sort === 'new' ? 'created_at DESC' : sort === 'comments' ? 'comments DESC' : 'likes DESC';
  const rows = db.prepare(
    `SELECT * FROM copies ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(
    `SELECT COUNT(*) n FROM copies ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(...params).n;
  return { rows, total };
}

/* ---------- 评论 ---------- */

export function upsertComment(db, c) {
  const ts = now();
  const id = `cmt_${c.platform}_${c.comment_id}`;
  const existing = db.prepare(`SELECT id FROM comments WHERE id = ?`).get(id);
  if (existing) return { id: existing.id, inserted: false };
  db.prepare(
    `INSERT INTO comments (id, platform, target_id, comment_id, parent_id, author, content,
       likes, replies, location, page_url, keyword, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    c.platform,
    c.target_id || '',
    c.comment_id,
    c.parent_id || '',
    c.author || '',
    c.content || '',
    c.likes || 0,
    c.replies || 0,
    c.location || '',
    c.page_url || '',
    c.keyword || '',
    ts
  );
  return { id, inserted: true };
}

export function queryComments(db, { platform, targetId, q, minLikes = 0, limit = 200, offset = 0, sort = 'likes' } = {}) {
  const where = [];
  const params = [];
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (targetId) { where.push('target_id = ?'); params.push(targetId); }
  if (q) { where.push('content LIKE ?'); params.push(`%${q}%`); }
  if (minLikes > 0) { where.push('likes >= ?'); params.push(minLikes); }
  const order = sort === 'new' ? 'created_at DESC' : 'likes DESC';
  const rows = db.prepare(
    `SELECT * FROM comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(
    `SELECT COUNT(*) n FROM comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(...params).n;
  return { rows, total };
}

export function commentTargetGroups(db, { platform, limit = 50 } = {}) {
  const where = platform ? 'WHERE platform = ?' : '';
  const params = platform ? [platform] : [];
  return db.prepare(
    `SELECT c.target_id, c.platform, c.keyword, COUNT(*) n, MAX(c.likes) max_likes,
       (SELECT content FROM comments c2 WHERE c2.target_id = c.target_id ORDER BY c2.likes DESC LIMIT 1) top_comment
     FROM comments c ${where} GROUP BY c.target_id ORDER BY MAX(c.created_at) DESC LIMIT ?`
  ).all(...params, limit);
}

/* ---------- AI 结果 ---------- */

export function saveAiResult(db, { kind, action, model, inputIds, inputText, output }) {
  const id = `ai-${now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO ai_results (id, kind, action, model, input_ids, input_text, output, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, kind, action, model || '', JSON.stringify(inputIds || []), inputText || '', output || '', now());
  return id;
}

export function listAiResults(db, limit = 30) {
  return db.prepare(`SELECT * FROM ai_results ORDER BY created_at DESC LIMIT ?`).all(limit);
}

/** 兼容旧库：copies 缺列就补 */
export function migrateCopySchema(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(copies)').all().map((c) => c.name));
  if (!cols.has('published')) db.exec("ALTER TABLE copies ADD COLUMN published TEXT DEFAULT ''");
}
