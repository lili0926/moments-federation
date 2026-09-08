const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { verifyFederationRequest, localhostOnly } = require('../middleware/auth');
const { broadcastMoment, broadcastAction } = require('../services/federation');
const { recordExchange } = require('../services/replyControl');

const router = express.Router();

// 发动态（本地专用：只信任前端/内网调用）
router.post('/publish', localhostOnly, (req, res) => {
  const { content, scope } = req.body;
  if (!content || !['private', 'public'].includes(scope)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO moments (id, author_id, content, scope, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, config.SELF_NODE_ID, content, scope, now);

  if (scope === 'public') {
    // 异步广播，不阻塞发布响应
    broadcastMoment({ id, content, created_at: now }).catch(() => {});
  }

  res.json({ ok: true, moment_id: id });
});

// 接收好友推送的动态（公网开放，走签名校验）
router.post('/receive', verifyFederationRequest, (req, res) => {
  const { moment_id, author_id, author_name, author_server, content, created_at } = req.body;
  db.prepare(`
    INSERT OR IGNORE INTO public_feed_cache (moment_id, author_id, author_name, author_server, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(moment_id, author_id, author_name, author_server, content, created_at);
  res.json({ ok: true });
});

// 增量同步：好友重新上线/刷新时拉取错过的动态
router.get('/sync', verifyFederationRequest, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const rows = db.prepare(`
    SELECT id as moment_id, author_id, content, created_at FROM moments
    WHERE scope='public' AND is_deleted=0 AND created_at > ?
    ORDER BY created_at ASC
  `).all(since);
  res.json({ moments: rows });
});

// 拉取朋友圈（本地专用，前端调用）
router.get('/feed', localhostOnly, (req, res) => {
  const scope = req.query.scope;
  if (scope === 'private') {
    const rows = db.prepare(`
      SELECT id, content, created_at FROM moments
      WHERE scope='private' AND is_deleted=0 ORDER BY created_at DESC
    `).all();
    return res.json(rows);
  }

  // public：本地public动态 + 好友推送缓存，合并按时间倒序
  const own = db.prepare(`
    SELECT id as moment_id, ? as author_id, ? as author_name, ? as author_server, content, created_at
    FROM moments WHERE scope='public' AND is_deleted=0
  `).all(config.SELF_NODE_ID, config.SELF_DISPLAY_NAME, config.SELF_SERVER_URL);

  const fromFriends = db.prepare(`
    SELECT moment_id, author_id, author_name, author_server, content, created_at
    FROM public_feed_cache WHERE is_deleted=0
  `).all();

  const merged = [...own, ...fromFriends].sort((a, b) => b.created_at - a.created_at);
  res.json(merged);
});

// 点赞/评论/删除（公网开放，签名校验；本地自己触发的走内部逻辑记录往返计数）
router.post('/action', verifyFederationRequest, (req, res) => {
  const { target_moment_id, operator_id, operator_name, action_type, content } = req.body;

  if (action_type === 'delete') {
    db.prepare(`UPDATE public_feed_cache SET is_deleted=1 WHERE moment_id=?`).run(target_moment_id);
    return res.json({ ok: true });
  }

  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO moment_interactions (id, target_moment_id, operator_id, operator_name, action_type, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, target_moment_id, operator_id, operator_name, action_type, content || null, now);

  // 记一次往返，供 replyControl 的往返上限判断使用
  if (action_type === 'comment') {
    recordExchange(target_moment_id, config.SELF_NODE_ID, operator_id);
  }

  res.json({ ok: true, interaction_id: id });
});

module.exports = router;
