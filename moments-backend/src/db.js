const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const dir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
-- 本地动态表（私人+公共都在这，靠scope区分，永远只软删除）
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('private','public')),
  created_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

-- 好友节点表
-- reply_mode: like_only(只点赞) / llm_decide(AI自行判断) / always_comment(总是评论)
-- remark: 本地备注，不参与联邦同步，纯本地展示
CREATE TABLE IF NOT EXISTS friends (
  friend_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  remark TEXT,
  server_url TEXT NOT NULL,
  shared_secret TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  reply_mode TEXT NOT NULL DEFAULT 'llm_decide' CHECK(reply_mode IN ('like_only','llm_decide','always_comment')),
  created_at INTEGER NOT NULL
);

-- 外部公共动态缓存表
CREATE TABLE IF NOT EXISTS public_feed_cache (
  moment_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_server TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

-- 点赞/评论互动表
CREATE TABLE IF NOT EXISTS moment_interactions (
  id TEXT PRIMARY KEY,
  target_moment_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('like','comment')),
  content TEXT,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

-- 防无限刷评论：记录某条动态里，两个participant之间的往返轮次
-- participant_low / participant_high 固定按字符串排序存，保证一对组合只有一行
CREATE TABLE IF NOT EXISTS interaction_state (
  moment_id TEXT NOT NULL,
  participant_low TEXT NOT NULL,
  participant_high TEXT NOT NULL,
  exchange_count INTEGER NOT NULL DEFAULT 0,
  last_actor_id TEXT,
  last_action_at INTEGER,
  PRIMARY KEY (moment_id, participant_low, participant_high)
);

-- 加好友请求临时表（握手用，含一次性token）
CREATE TABLE IF NOT EXISTS friend_requests (
  request_id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_server TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  token_used INTEGER DEFAULT 0,
  token_expires_at INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL
);
`);

module.exports = db;
