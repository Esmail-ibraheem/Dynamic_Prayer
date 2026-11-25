// Feed storage on Node's built-in SQLite (no native add-ons to compile).
//
// Two capabilities per feed:
//   feed token  – read-only, lives in the calendar subscription URL
//   edit token  – the private "manage" link; only its SHA-256 is stored, so a
//                 leaked database cannot be used to change anyone's feed.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const token = (prefix, bytes) => `${prefix}${randomBytes(bytes).toString('base64url')}`;
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_token TEXT NOT NULL UNIQUE,
      edit_hash TEXT NOT NULL UNIQUE,
      uid TEXT NOT NULL,
      settings TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_fetch_at TEXT,
      last_fetch_client TEXT,
      fetch_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  const q = {
    insert: db.prepare('INSERT INTO feeds (feed_token, edit_hash, uid, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    byFeed: db.prepare('SELECT * FROM feeds WHERE feed_token = ?'),
    byEdit: db.prepare('SELECT * FROM feeds WHERE edit_hash = ?'),
    update: db.prepare('UPDATE feeds SET settings = ?, revision = revision + 1, updated_at = ? WHERE id = ?'),
    fetch: db.prepare('UPDATE feeds SET last_fetch_at = ?, last_fetch_client = ?, fetch_count = fetch_count + 1 WHERE id = ?'),
    rotate: db.prepare('UPDATE feeds SET feed_token = ?, revision = revision + 1, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM feeds WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM feeds'),
  };

  const parse = (row) => (row ? { ...row, settings: JSON.parse(row.settings) } : null);
  const now = () => new Date().toISOString();

  return {
    /** @returns {{feedToken: string, editToken: string, row: any}} */
    create(settings) {
      const feedToken = token('f_', 16);
      const editToken = token('k_', 24);
      const ts = now();
      q.insert.run(feedToken, hashToken(editToken), randomBytes(6).toString('hex'), JSON.stringify(settings), ts, ts);
      return { feedToken, editToken, row: parse(q.byFeed.get(feedToken)) };
    },
    byFeedToken: (t) => parse(q.byFeed.get(String(t))),
    byEditToken: (t) => parse(q.byEdit.get(hashToken(t))),
    update(id, settings) {
      q.update.run(JSON.stringify(settings), now(), id);
    },
    recordFetch(id, client) {
      q.fetch.run(now(), client, id);
    },
    rotateFeedToken(id) {
      const feedToken = token('f_', 16);
      q.rotate.run(feedToken, now(), id);
      return feedToken;
    },
    remove: (id) => q.remove.run(id).changes > 0,
    count: () => q.count.get().n,
    close: () => db.close(),
  };
}
