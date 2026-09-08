const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { isRateLimited } = require('../services/rateLimit');
const { localhostOnly } = require('../middleware/auth');

const router = express.Router();

// 步骤一：收到好友申请（公网开放，PHASE>=2才真正启用，见app.js路由挂载）
router.post('/request', (req, res) => {
  const { from_id, from_name, from_server, message } = req.body;
  if (!from_id || !from_name || !from_server) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // 补丁⑤：按来源限流，防止无限刷加好友请求
  if (isRateLimited(`friend_req:${from_server}`)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }

  const requestId = nanoid();
  const verifyToken = nanoid(32); // 高熵随机，一次性
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO friend_requests (request_id, from_id, from_name, from_server, verify_token, token_expires_at, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(requestId, from_id, from_name, from_server, verifyToken, now + 600, message || '', now); // 10分钟有效期

  res.json({ request_id: requestId });
});

// 步骤三：回调确认互信（公网开放）——对方审批同意后会调这个接口，把它的shared_secret发过来
router.post('/accept-callback', (req, res) => {
  const handshakeToken = req.header('X-Handshake-Token');
  const { friend_id, friend_name, friend_server, shared_secret } = req.body;

  if (!handshakeToken) return res.status(401).json({ error: 'missing_handshake_token' });

  const request = db.prepare(
    `SELECT * FROM friend_requests WHERE verify_token = ? AND token_used = 0`
  ).get(handshakeToken);

  if (!request) return res.status(401).json({ error: 'invalid_or_used_token' });

  const now = Math.floor(Date.now() / 1000);
  if (now > request.token_expires_at) {
    return res.status(401).json({ error: 'token_expired' });
  }

  // token一次性，立即标记已用
  db.prepare(`UPDATE friend_requests SET token_used = 1 WHERE request_id = ?`).run(request.request_id);

  db.prepare(`
    INSERT OR REPLACE INTO friends (friend_id, display_name, server_url, shared_secret, status, reply_mode, created_at)
    VALUES (?, ?, ?, ?, 'accepted', 'llm_decide', ?)
  `).run(friend_id, friend_name, friend_server, shared_secret, now);

  res.json({ ok: true });
});

// —— 以下为本地专用（备注、回复策略调整），必须只允许本机访问 ——

// 给好友设置本地备注（不参与联邦同步，纯本地展示用）
router.post('/:friendId/remark', localhostOnly, (req, res) => {
  const { friendId } = req.params;
  const { remark } = req.body;
  const result = db.prepare(`UPDATE friends SET remark = ? WHERE friend_id = ?`).run(remark || null, friendId);
  if (result.changes === 0) return res.status(404).json({ error: 'friend_not_found' });
  res.json({ ok: true, friend_id: friendId, remark: remark || null });
});

// 设置某个好友的回复策略：like_only / llm_decide / always_comment
router.post('/:friendId/reply-mode', localhostOnly, (req, res) => {
  const { friendId } = req.params;
  const { reply_mode } = req.body;
  const valid = ['like_only', 'llm_decide', 'always_comment'];
  if (!valid.includes(reply_mode)) {
    return res.status(400).json({ error: 'invalid_reply_mode', valid_values: valid });
  }
  const result = db.prepare(`UPDATE friends SET reply_mode = ? WHERE friend_id = ?`).run(reply_mode, friendId);
  if (result.changes === 0) return res.status(404).json({ error: 'friend_not_found' });
  res.json({ ok: true, friend_id: friendId, reply_mode });
});

// 好友列表（本地专用，展示时remark优先于display_name）
router.get('/', localhostOnly, (req, res) => {
  const friends = db.prepare(`SELECT * FROM friends WHERE status='accepted'`).all();
  const withDisplay = friends.map(f => ({ ...f, shown_as: f.remark || f.display_name }));
  res.json(withDisplay);
});

module.exports = router;
