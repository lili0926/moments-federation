const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const dir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  identity_id TEXT NOT NULL DEFAULT 'unknown',
  content TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('private','public')),
  created_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS friends (
  friend_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  shared_secret TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_feed_cache (
  moment_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_identity_id TEXT NOT NULL DEFAULT 'unknown',
  author_name TEXT NOT NULL,
  author_server TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS moment_interactions (
  id TEXT PRIMARY KEY,
  target_moment_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_identity_id TEXT,
  operator_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('like','comment')),
  content TEXT,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interaction_state (
  moment_id TEXT NOT NULL,
  participant_low TEXT NOT NULL,
  participant_high TEXT NOT NULL,
  exchange_count INTEGER NOT NULL DEFAULT 0,
  last_actor_id TEXT,
  last_action_at INTEGER,
  PRIMARY KEY (moment_id, participant_low, participant_high)
);

CREATE TABLE IF NOT EXISTS local_identities (
  identity_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('human','ai'))
);

CREATE TABLE IF NOT EXISTS friend_identities (
  friend_node_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('human','ai')),
  remark TEXT,
  reply_mode TEXT NOT NULL DEFAULT 'llm_decide'
    CHECK(reply_mode IN ('like_only','llm_decide','always_comment')),
  PRIMARY KEY (friend_node_id, identity_id)
);

CREATE TABLE IF NOT EXISTS handshake_tokens (
  token TEXT PRIMARY KEY,
  from_id TEXT,
  from_name TEXT,
  from_server TEXT,
  identities_json TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blocked_keywords (
  keyword TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public_audit_log (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK(content_type IN ('moment','comment')),
  content TEXT NOT NULL,
  target_moment_id TEXT,
  moderation_result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// 轻量迁移：旧库缺列时补上
function ensureColumn(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}
try {
  ensureColumn('moments', 'identity_id', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn('public_feed_cache', 'author_identity_id', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn('public_feed_cache', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('moment_interactions', 'operator_identity_id', 'TEXT');
  ensureColumn('moment_interactions', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  console.warn('[db migrate]', e.message);
}

// 种子：本机人 + AI 身份
const ins = db.prepare(
  `INSERT OR IGNORE INTO local_identities (identity_id, display_name, type) VALUES (?, ?, ?)`
);
ins.run(config.SELF_HUMAN_ID, config.SELF_HUMAN_NAME, 'human');
ins.run(config.SELF_AI_ID, config.SELF_AI_NAME, 'ai');

// 少量默认敏感词（可自行增删）
const kw = db.prepare(`INSERT OR IGNORE INTO blocked_keywords (keyword) VALUES (?)`);
['去死', '你妈', '智障', '脑残', '垃圾人'].forEach((k) => kw.run(k));

module.exports = db;
