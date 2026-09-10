const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { localhostOnly } = require('../middleware/auth');
const { decideAction } = require('../services/replyControl');
const { moderateLocal, auditExternalResult } = require('../services/moderation');
const { broadcastMoment } = require('../services/federation');
const { reviewFriendRequest } = require('../services/handshake');
const { localIdentitiesPayload } = require('./friends');

const router = express.Router();
router.use(localhostOnly);

// 审批好友申请（与 /api/admin/friends/review 共用同一份实现）
router.post('/friends/review', async (req, res) => {
  const body = req.body || {};
  const token = body.request_token || body.request_id;
  const r = await reviewFriendRequest({ token, action: body.action || 'accept' });
  const { status, ...rest } = r;
  res.status(status).json(rest);
});

// 聊天后端：AI 是否应评论
router.post('/should-comment', (req, res) => {
  const {
    moment_id,
    my_identity_id,
    friend_node_id,
    friend_identity_id,
  } = req.body || {};

  if (!moment_id || !friend_node_id) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const result = decideAction(
    moment_id,
    my_identity_id || config.SELF_AI_ID,
    friend_node_id,
    friend_identity_id || friend_node_id
  );
  res.json(result);
});

// 内容审查（关键词 + 可选外部结果写入）
router.post('/moderate-content', (req, res) => {
  const { content, content_type, target_moment_id, external_result } = req.body || {};
  if (external_result) {
    const r = auditExternalResult(
      content,
      content_type === 'moment' ? 'moment' : 'comment',
      target_moment_id,
      external_result
    );
    return res.json(r);
  }
  const r = moderateLocal(
    content,
    content_type === 'moment' ? 'moment' : 'comment',
    target_moment_id
  );
  res.json(r);
});

// 聊天侧发动态（默认 private）
router.post('/post-from-chat', async (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  let scope = (req.body && req.body.scope) || 'private';
  if (scope !== 'public') scope = 'private';
  const identity_id = (req.body && req.body.identity_id) || config.SELF_AI_ID;
  const confirmed_public = !!(req.body && req.body.confirmed_public);

  if (!content) return res.status(400).json({ error: 'empty_content' });
  if (scope === 'public' && !confirmed_public) {
    return res.status(403).json({
      error: 'public_needs_confirmation',
      hint: '发公共动态必须 confirmed_public=true（前端弹确认）',
    });
  }

  if (scope === 'public') {
    const mod = moderateLocal(content, 'moment', null);
    if (!mod.safe) {
      return res.status(400).json({ error: 'content_blocked', moderation: mod });
    }
  }

  const id = `${config.SELF_NODE_ID}_${nanoid(12)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moments (id, author_id, identity_id, content, scope, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(id, config.SELF_NODE_ID, identity_id, content, scope, now);

  let broadcast = null;
  if (scope === 'public') {
    try {
      const nameRow = db.prepare(`SELECT display_name FROM local_identities WHERE identity_id=?`).get(identity_id);
      broadcast = await broadcastMoment({
        id,
        identity_id,
        content,
        created_at: now,
        author_name: nameRow ? nameRow.display_name : config.SELF_DISPLAY_NAME,
      });
    } catch (e) {
      broadcast = { error: e.message };
    }
  }

  res.json({ ok: true, moment_id: id, scope, broadcast });
});

// 健康检查也允许 internal 前缀下访问
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    phase: config.PHASE,
    node: config.SELF_NODE_ID,
    identities: localIdentitiesPayload(),
  });
});

module.exports = router;
