/**
 * 素材库数据库（node:sqlite，零依赖）
 * 表结构：
 *   items     —— 采集到的素材条目（含未下载的）
 *   downloads —— 下载任务与结果
 *   jobs      —— 采集任务
 *   keywords  —— 搜索记录（用于统计/复用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      keyword     TEXT NOT NULL,
      target      INTEGER NOT NULL DEFAULT 50,
      status      TEXT NOT NULL DEFAULT 'pending',
      found       INTEGER NOT NULL DEFAULT 0,
      message     TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      keyword     TEXT DEFAULT '',
      title       TEXT DEFAULT '',
      desc        TEXT DEFAULT '',
      tags        TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      author_id   TEXT DEFAULT '',
      cover       TEXT DEFAULT '',
      video_url   TEXT DEFAULT '',
      audio_url   TEXT DEFAULT '',
      play_url    TEXT DEFAULT '',
      duration    REAL DEFAULT 0,
      likes       INTEGER DEFAULT 0,
      comments    INTEGER DEFAULT 0,
      shares      INTEGER DEFAULT 0,
      collects    INTEGER DEFAULT 0,
      published   TEXT DEFAULT '',
      page_url    TEXT DEFAULT '',
      music       TEXT DEFAULT '',
      extra       TEXT DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'new',
      local_path  TEXT DEFAULT '',
      local_size  INTEGER DEFAULT 0,
      error       TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(platform, platform_id)
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      url         TEXT DEFAULT '',
      dest        TEXT DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'queued',
      received    INTEGER DEFAULT 0,
      total       INTEGER DEFAULT 0,
      speed       REAL DEFAULT 0,
      error       TEXT DEFAULT '',
      engine      TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS copy_jobs (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      keyword     TEXT NOT NULL,
      mode        TEXT NOT NULL DEFAULT 'search',
      target      INTEGER NOT NULL DEFAULT 30,
      with_comments INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',
      found       INTEGER NOT NULL DEFAULT 0,
      message     TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_items_platform ON items(platform);
    CREATE INDEX IF NOT EXISTS idx_items_keyword  ON items(keyword);
    CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status);
    CREATE INDEX IF NOT EXISTS idx_dl_item        ON downloads(item_id);
    CREATE INDEX IF NOT EXISTS idx_copies_platform ON copies(platform);
    CREATE INDEX IF NOT EXISTS idx_copies_keyword  ON copies(keyword);
    CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_id);
    CREATE INDEX IF NOT EXISTS idx_comments_platform ON comments(platform);
  `);
  // 兼容旧库：缺列就补（SQLite 不支持 IF NOT EXISTS 加列）
  const cols = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!cols.has('audio_url')) db.exec("ALTER TABLE items ADD COLUMN audio_url TEXT DEFAULT ''");
  return db;
}

const now = () => Date.now();

export function createJob(db, { platform, keyword, target }) {
  const id = `job-${now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO jobs (id, platform, keyword, target, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, platform, keyword, target, now(), now());
  return id;
}

export function updateJob(db, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const sql = `UPDATE jobs SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...fields.map((f) => patch[f]), now(), id);
}

export function listJobs(db, limit = 30) {
  return db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function getJob(db, id) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

export function upsertItem(db, item) {
  const ts = now();
  const existing = db
    .prepare(`SELECT id, status, local_path FROM items WHERE platform = ? AND platform_id = ?`)
    .get(item.platform, item.platform_id);

  if (existing) {
    // 只更新元信息，不覆盖已下载状态和本地路径
    db.prepare(
      `UPDATE items SET title = COALESCE(NULLIF(?, ''), title),
         desc = COALESCE(NULLIF(?, ''), desc),
         tags = COALESCE(NULLIF(?, ''), tags),
         author = COALESCE(NULLIF(?, ''), author),
         cover = COALESCE(NULLIF(?, ''), cover),
         video_url = COALESCE(NULLIF(?, ''), video_url),
         audio_url = COALESCE(NULLIF(?, ''), audio_url),
         duration = CASE WHEN ?> 0 THEN ? ELSE duration END,
         likes = CASE WHEN ?> 0 THEN ? ELSE likes END,
         page_url = COALESCE(NULLIF(?, ''), page_url),
         music = COALESCE(NULLIF(?, ''), music),
         extra = COALESCE(NULLIF(?, ''), extra),
         updated_at = ?
       WHERE id = ?`
    ).run(
      item.title || '',
      item.desc || '',
      item.tags || '',
      item.author || '',
      item.cover || '',
      item.video_url || '',
      item.audio_url || '',
      item.duration || 0,
      item.duration || 0,
      item.likes || 0,
      item.likes || 0,
      item.page_url || '',
      item.music || '',
      item.extra || '',
      ts,
      existing.id
    );
    return { id: existing.id, inserted: false };
  }

  const id = `${item.platform}_${item.platform_id}`;
  db.prepare(
    `INSERT INTO items (id, platform, platform_id, keyword, title, desc, tags, author, author_id,
       cover, video_url, audio_url, play_url, duration, likes, comments, shares, collects, published,
       page_url, music, extra, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)`
  ).run(
    id,
    item.platform,
    item.platform_id,
    item.keyword || '',
    item.title || '',
    item.desc || '',
    item.tags || '',
    item.author || '',
    item.author_id || '',
    item.cover || '',
    item.video_url || '',
    item.audio_url || '',
    item.play_url || '',
    item.duration || 0,
    item.likes || 0,
    item.comments || 0,
    item.shares || 0,
    item.collects || 0,
    item.published || '',
    item.page_url || '',
    item.music || '',
    item.extra || '',
    ts,
    ts
  );
  return { id, inserted: true };
}

export function queryItems(db, { platform, keyword, status, q, limit = 100, offset = 0, sort = 'new' } = {}) {
  const where = [];
  const params = [];
  if (platform) {
    where.push('platform = ?');
    params.push(platform);
  }
  if (keyword) {
    where.push('keyword = ?');
    params.push(keyword);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(title LIKE ? OR desc LIKE ? OR tags LIKE ? OR author LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const order = sort === 'likes' ? 'likes DESC, created_at DESC' : sort === 'duration' ? 'duration DESC' : 'created_at DESC';
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset);
  const countSql = `SELECT COUNT(*) AS n FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = db.prepare(countSql).get(...params).n;
  return { rows, total };
}

export function getItem(db, id) {
  return db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
}

export function updateItem(db, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  db.prepare(`UPDATE items SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...fields.map((f) => patch[f]),
    now(),
    id
  );
}

export function createDownload(db, { itemId, url, engine }) {
  const id = `dl-${now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO downloads (id, item_id, url, status, engine, created_at, updated_at)
     VALUES (?,?,?, 'queued', ?, ?, ?)`
  ).run(id, itemId, url || '', engine || '', now(), now());
  return id;
}

export function updateDownload(db, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  db.prepare(`UPDATE downloads SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...fields.map((f) => patch[f]),
    now(),
    id
  );
}

export function listDownloads(db, limit = 100) {
  return db
    .prepare(
      `SELECT d.*, i.title, i.platform, i.cover, i.author
       FROM downloads d JOIN items i ON i.id = d.item_id
       ORDER BY d.created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function stats(db) {
  const byPlatform = db.prepare(`SELECT platform, COUNT(*) n, SUM(status='done') done FROM items GROUP BY platform`).all();
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(local_size),0) size FROM items`).get();
  const downloaded = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(local_size),0) size FROM items WHERE status='done'`).get();
  return { byPlatform, total, downloaded };
}

export function keywordsOf(db) {
  return db
    .prepare(`SELECT keyword, platform, COUNT(*) n, MAX(created_at) last FROM items WHERE keyword != '' GROUP BY keyword, platform ORDER BY last DESC LIMIT 200`)
    .all();
}
