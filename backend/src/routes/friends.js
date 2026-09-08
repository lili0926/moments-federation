const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { verifyFederationRequest, localhostOnly } = require('../middleware/auth');
const { allow } = require('../services/rateLimit');

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
  db.prepare(
    `INSERT OR REPLACE INTO handshake_tokens
      (token, from_id, from_name, from_server, identities_json, message, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
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
  if (!row || row.used || row.expires_at < now) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }

  db.prepare(`UPDATE handshake_tokens SET used=1 WHERE token=?`).run(token);

  const friendId = (req.body && req.body.from_id) || row.from_id;
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
    (req.body && req.body.from_name) || row.from_name,
    (req.body && req.body.from_server) || row.from_server,
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
