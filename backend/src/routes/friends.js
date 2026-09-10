const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { verifyFederationRequest, localhostOnly } = require('../middleware/auth');
const { allow } = require('../services/rateLimit');
const { normalizeServerUrl } = require('../services/handshake');

const router = express.Router();

function localIdentitiesPayload() {
  return db
    .prepare(`SELECT identity_id, display_name, type FROM local_identities`)
    .all();
}

function upsertFriendIdentities(friendNodeId, identities) {
  if (!Array.isArray(identities)) return;
  const stmt = db.prepare(
    `INSERT INTO friend_identities (friend_node_id, identity_id, display_name, type, remark, reply_mode)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(friend_node_id, identity_id) DO UPDATE SET
       display_name=excluded.display_name,
       type=excluded.type`
  );
  for (const id of identities) {
    if (!id || !id.identity_id) continue;
    const type = id.type === 'ai' ? 'ai' : 'human';
    const reply_mode = type === 'ai' ? 'like_only' : 'llm_decide';
    stmt.run(friendNodeId, id.identity_id, id.display_name || id.identity_id, type, reply_mode);
  }
}

// 发起好友申请（公网）
router.post('/request', (req, res) => {
  const body = req.body || {};
  const from_id = body.from_id;
  const from_server = body.from_server;
  const key = `freq:${from_server || req.ip}`;
  if (!allow(key, config.FRIEND_REQUEST_RATE_LIMIT)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  if (!from_id || !from_server || !body.verify_token) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const now = Math.floor(Date.now() / 1000);
  const expires = now + config.HANDSHAKE_TOKEN_TTL_SECONDS;

  // 不许外来申请覆盖本机发出的 token（那会把 'out' 记录改写成 'in'，
  // 等于让对方决定自己该走哪条校验路径）
  const clash = db.prepare(`SELECT direction FROM handshake_tokens WHERE token=?`).get(body.verify_token);
  if (clash && clash.direction === 'out') {
    return res.status(409).json({ error: 'token_conflict' });
  }

  db.prepare(
    `INSERT OR REPLACE INTO handshake_tokens
      (token, from_id, from_name, from_server, identities_json, message, created_at, expires_at, used, direction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'in')`
  ).run(
    body.verify_token,
    from_id,
    body.from_name || from_id,
    from_server,
    JSON.stringify(body.identities || []),
    body.message || '',
    now,
    expires
  );

  // pending 好友行（尚无 secret）
  db.prepare(
    `INSERT INTO friends (friend_id, display_name, server_url, shared_secret, status, created_at)
     VALUES (?, ?, ?, '', 'pending', ?)
     ON CONFLICT(friend_id) DO UPDATE SET
       display_name=excluded.display_name,
       server_url=excluded.server_url,
       status='pending'`
  ).run(from_id, body.from_name || from_id, from_server, now);

  upsertFriendIdentities(from_id, body.identities || []);

  res.json({ ok: true, status: 'pending_review' });
});

// 回调确认（公网）
router.post('/accept-callback', (req, res) => {
  const token = req.get('X-Handshake-Token') || (req.body && req.body.verify_token);
  const shared_secret = req.body && req.body.shared_secret;
  if (!token || !shared_secret) {
    return res.status(400).json({ error: 'missing_token_or_secret' });
  }

  const row = db.prepare(`SELECT * FROM handshake_tokens WHERE token=?`).get(token);
  const now = Math.floor(Date.now() / 1000);
  // direction 必须是 'out'：只有本机主动发起的申请才该收到回调。
  // 若放行 'in'，任何人都能先调 /request 塞一个自己生成的 token，
  // 再拿同一个 token 调本口，直接把自己写成 accepted 并自选 shared_secret——
  // 整个人工审批环节就被绕过了。
  if (!row || row.used || row.expires_at < now || row.direction !== 'out') {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }

  const friendId = (req.body && req.body.from_id) || row.from_id;
  if (!friendId) {
    return res.status(400).json({ error: 'missing_from_id' });
  }

  // friend_id 由对方在 body 里自报，而下面是 ON CONFLICT DO UPDATE。
  // 若不拦，一个我主动加的节点可以自称是我已有的好友（比如 alice_node），
  // 把那一行的 server_url 和 shared_secret 覆盖成它自己的——等于顶替了 Alice。
  // 规则：已 accepted 的好友，只允许来自它原本那台服务器的回调更新。
  const existing = db.prepare(`SELECT * FROM friends WHERE friend_id=?`).get(friendId);
  if (
    existing &&
    existing.status === 'accepted' &&
    normalizeServerUrl(existing.server_url) !== normalizeServerUrl(row.from_server)
  ) {
    return res.status(409).json({ error: 'friend_id_taken_by_another_server' });
  }

  db.prepare(`UPDATE handshake_tokens SET used=1 WHERE token=?`).run(token);
  db.prepare(
    `INSERT INTO friends (friend_id, display_name, server_url, shared_secret, status, created_at)
     VALUES (?, ?, ?, ?, 'accepted', ?)
     ON CONFLICT(friend_id) DO UPDATE SET
       shared_secret=excluded.shared_secret,
       status='accepted',
       display_name=excluded.display_name,
       server_url=excluded.server_url`
  ).run(
    friendId,
    // 'out' 记录发起时还不知道对方是谁，from_name 为 NULL，
    // 这里必须兜住，否则 display_name 的 NOT NULL 约束会炸
    (req.body && req.body.from_name) || row.from_name || friendId,
    // 地址只认本机当初主动握手的那个，不接受对方在 body 里自报。
    // 否则它可以让我把好友地址记成第三方，之后我的 public 动态
    // 就会被签名后推到一个我从没同意过的服务器上。
    row.from_server,
    shared_secret,
    now
  );

  let identities = req.body && req.body.identities;
  if (!identities) {
    try {
      identities = JSON.parse(row.identities_json || '[]');
    } catch {
      identities = [];
    }
  }
  upsertFriendIdentities(friendId, identities);

  res.json({ ok: true });
});

// 好友列表（本地）
router.get('/', localhostOnly, (req, res) => {
  const friends = db.prepare(`SELECT friend_id, display_name, server_url, status, created_at FROM friends`).all();
  const out = friends.map((f) => {
    const identities = db
      .prepare(
        `SELECT identity_id, display_name, type, remark, reply_mode
         FROM friend_identities WHERE friend_node_id=?`
      )
      .all(f.friend_id);
    return {
      friend_node_id: f.friend_id,
      node_display_name: f.display_name,
      server_url: f.server_url,
      status: f.status,
      identities,
    };
  });
  res.json(out);
});

// 设置备注
router.post('/:friendId/:identityId/remark', localhostOnly, (req, res) => {
  const { friendId, identityId } = req.params;
  const remark = (req.body && req.body.remark) || null;
  const info = db
    .prepare(`UPDATE friend_identities SET remark=? WHERE friend_node_id=? AND identity_id=?`)
    .run(remark, friendId, identityId);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// 设置 reply_mode
router.post('/:friendId/:identityId/reply-mode', localhostOnly, (req, res) => {
  const { friendId, identityId } = req.params;
  const mode = req.body && req.body.reply_mode;
  if (!['like_only', 'llm_decide', 'always_comment'].includes(mode)) {
    return res.status(400).json({ error: 'bad_reply_mode' });
  }
  const info = db
    .prepare(`UPDATE friend_identities SET reply_mode=? WHERE friend_node_id=? AND identity_id=?`)
    .run(mode, friendId, identityId);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// 本机身份列表
router.get('/local-identities', localhostOnly, (req, res) => {
  res.json(localIdentitiesPayload());
});

module.exports = router;
module.exports.localIdentitiesPayload = localIdentitiesPayload;
module.exports.upsertFriendIdentities = upsertFriendIdentities;
