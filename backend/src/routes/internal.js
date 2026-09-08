const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { localhostOnly } = require('../middleware/auth');
const { decideAction } = require('../services/replyControl');

const router = express.Router();

// 所有 /internal/* 路由都强制只允许本机访问，app.js里再兜底一次绑定127.0.0.1
router.use(localhostOnly);

// 聊天端AI发朋友圈的入口。默认scope强制回退为private，除非显式传public。
router.post('/post-from-chat', (req, res) => {
  const { content, scope } = req.body;
  if (!content) return res.status(400).json({ error: 'missing_content' });

  const finalScope = scope === 'public' ? 'public' : 'private'; // 默认锁定private
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO moments (id, author_id, content, scope, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, config.SELF_NODE_ID, content, finalScope, now);

  if (finalScope === 'public') {
    require('../services/federation').broadcastMoment({ id, content, created_at: now }).catch(() => {});
  }

  res.json({ ok: true, moment_id: id, scope: finalScope });
});

// 好友申请审批（管理员手动同意/拒绝）
router.post('/friends/review', (req, res) => {
  const { request_id, action } = req.body; // action: 'accept' | 'reject'
  const request = db.prepare(`SELECT * FROM friend_requests WHERE request_id=?`).get(request_id);
  if (!request) return res.status(404).json({ error: 'request_not_found' });

  if (action === 'reject') {
    db.prepare(`UPDATE friend_requests SET status='rejected' WHERE request_id=?`).run(request_id);
    return res.json({ ok: true, status: 'rejected' });
  }

  const sharedSecret = nanoid(48);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT OR REPLACE INTO friends (friend_id, display_name, server_url, shared_secret, status, reply_mode, created_at)
    VALUES (?, ?, ?, ?, 'accepted', 'llm_decide', ?)
  `).run(request.from_id, request.from_name, request.from_server, sharedSecret, now);

  db.prepare(`UPDATE friend_requests SET status='accepted' WHERE request_id=?`).run(request_id);

  // 实际实现里这里要去调对方的 /api/friends/accept-callback，带上 X-Handshake-Token
  // 并把 sharedSecret 传过去，完成双向互信。此处留给 federation.js 扩展。
  res.json({ ok: true, status: 'accepted', shared_secret: sharedSecret });
});

// 聊天后端在"要不要回这条评论"前调用这个接口，过两道闸再决定
// body: { moment_id, commenter_friend_id }
router.post('/should-comment', (req, res) => {
  const { moment_id, commenter_friend_id } = req.body;
  if (!moment_id || !commenter_friend_id) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const decision = decideAction(moment_id, config.SELF_NODE_ID, commenter_friend_id);
  res.json(decision);
});

module.exports = router;
