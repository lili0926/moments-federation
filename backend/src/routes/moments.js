const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { verifyFederationRequest, localhostOnly } = require('../middleware/auth');
const { broadcastMoment, broadcastAction } = require('../services/federation');
const { recordExchange } = require('../services/replyControl');
const { moderateLocal } = require('../services/moderation');

const router = express.Router();

function newMomentId() {
  return `${config.SELF_NODE_ID}_${nanoid(12)}`;
}

function identityName(identityId) {
  const row = db.prepare(`SELECT display_name FROM local_identities WHERE identity_id=?`).get(identityId);
  return row ? row.display_name : config.SELF_DISPLAY_NAME;
}

// 发布（本地）
router.post('/publish', localhostOnly, async (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  let scope = (req.body && req.body.scope) || 'private';
  if (scope !== 'public') scope = 'private';
  let identity_id = (req.body && req.body.identity_id) || config.SELF_HUMAN_ID;

  if (!content) return res.status(400).json({ error: 'empty_content' });

  const idRow = db.prepare(`SELECT identity_id FROM local_identities WHERE identity_id=?`).get(identity_id);
  if (!idRow) identity_id = config.SELF_HUMAN_ID;

  if (scope === 'public') {
    const mod = moderateLocal(content, 'moment', null);
    if (!mod.safe) {
      return res.status(400).json({ error: 'content_blocked', moderation: mod });
    }
  }

  const id = newMomentId();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moments (id, author_id, identity_id, content, scope, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(id, config.SELF_NODE_ID, identity_id, content, scope, now);

  let broadcast = null;
  if (scope === 'public') {
    try {
      broadcast = await broadcastMoment({
        id,
        identity_id,
        content,
        created_at: now,
        author_name: identityName(identity_id),
      });
    } catch (e) {
      broadcast = { error: e.message };
    }
  }

  res.json({
    ok: true,
    moment: { id, identity_id, content, scope, created_at: now },
    broadcast,
  });
});

// 接收好友推送
router.post('/receive', verifyFederationRequest, (req, res) => {
  const {
    moment_id,
    author_id,
    author_identity_id,
    author_name,
    author_server,
    content,
    created_at,
  } = req.body || {};

  if (!moment_id || !content) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const aid = author_id || req.senderId;
  const aname = author_name || req.friend?.display_name || aid;
  const aserver = author_server || req.friend?.server_url || '';
  const aident = author_identity_id || 'unknown';
  const cat = parseInt(created_at, 10) || Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO public_feed_cache
      (moment_id, author_id, author_identity_id, author_name, author_server, content, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(moment_id) DO UPDATE SET
       author_id=excluded.author_id,
       author_identity_id=excluded.author_identity_id,
       author_name=excluded.author_name,
       author_server=excluded.author_server,
       content=excluded.content,
       created_at=excluded.created_at,
       is_deleted=0`
  ).run(moment_id, aid, aident, aname, aserver, content, cat);

  res.json({ ok: true });
});

// 增量同步（Pull）
router.get('/sync', verifyFederationRequest, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const rows = db
    .prepare(
      `SELECT id as moment_id, author_id, identity_id as author_identity_id, content, created_at, is_deleted
       FROM moments
       WHERE scope='public' AND created_at > ?
       ORDER BY created_at ASC`
    )
    .all(since);

  const moments = rows.map((r) => ({
    moment_id: r.moment_id,
    author_id: config.SELF_NODE_ID,
    author_identity_id: r.author_identity_id,
    author_name: identityName(r.author_identity_id),
    author_server: config.SELF_SERVER_URL,
    content: r.content,
    created_at: r.created_at,
    is_deleted: !!r.is_deleted,
  }));

  res.json({ moments });
});

// 前端拉取 feed
router.get('/feed', localhostOnly, (req, res) => {
  const scope = req.query.scope === 'public' ? 'public' : 'private';

  if (scope === 'private') {
    const rows = db
      .prepare(
        `SELECT id, identity_id, content, created_at FROM moments
         WHERE scope='private' AND is_deleted=0 ORDER BY created_at DESC`
      )
      .all();
    return res.json(
      rows.map((r) => ({
        ...r,
        author_id: config.SELF_NODE_ID,
        author_name: identityName(r.identity_id),
        scope: 'private',
      }))
    );
  }

  const own = db
    .prepare(
      `SELECT id as moment_id, identity_id as author_identity_id, content, created_at
       FROM moments WHERE scope='public' AND is_deleted=0`
    )
    .all()
    .map((r) => ({
      moment_id: r.moment_id,
      author_id: config.SELF_NODE_ID,
      author_identity_id: r.author_identity_id,
      author_name: identityName(r.author_identity_id),
      author_server: config.SELF_SERVER_URL,
      content: r.content,
      created_at: r.created_at,
      scope: 'public',
    }));

  const fromFriends = db
    .prepare(
      `SELECT moment_id, author_id, author_identity_id, author_name, author_server, content, created_at
       FROM public_feed_cache WHERE is_deleted=0`
    )
    .all()
    .map((r) => ({ ...r, scope: 'public' }));

  const merged = [...own, ...fromFriends].sort((a, b) => b.created_at - a.created_at);
  res.json(merged);
});

// 互动 / 墓碑（联邦）
router.post('/action', verifyFederationRequest, (req, res) => {
  const {
    target_moment_id,
    operator_id,
    operator_identity_id,
    operator_name,
    action_type,
    content,
  } = req.body || {};

  if (!target_moment_id || !action_type) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  if (action_type === 'delete') {
    // 好友侧：只软删 cache；若误推到作者库也尝试软删（幂等）
    db.prepare(`UPDATE public_feed_cache SET is_deleted=1 WHERE moment_id=?`).run(target_moment_id);
    db.prepare(`UPDATE moments SET is_deleted=1 WHERE id=? AND author_id=?`).run(
      target_moment_id,
      req.senderId
    );
    return res.json({ ok: true });
  }

  if (action_type !== 'like' && action_type !== 'comment') {
    return res.status(400).json({ error: 'bad_action_type' });
  }

  const id = `${config.SELF_NODE_ID}_${nanoid(10)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moment_interactions
      (id, target_moment_id, operator_id, operator_identity_id, operator_name, action_type, content, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    id,
    target_moment_id,
    operator_id || req.senderId,
    operator_identity_id || null,
    operator_name || req.friend?.display_name || 'friend',
    action_type,
    content || null,
    now
  );

  if (action_type === 'comment') {
    recordExchange(
      target_moment_id,
      config.SELF_AI_ID,
      operator_identity_id || operator_id || req.senderId
    );
  }

  res.json({ ok: true, interaction_id: id });
});

// 本地删除自己的动态（软删 + 若 public 则广播墓碑）
router.post('/delete', localhostOnly, async (req, res) => {
  const momentId = req.body && req.body.moment_id;
  if (!momentId) return res.status(400).json({ error: 'missing_moment_id' });

  const row = db.prepare(`SELECT * FROM moments WHERE id=?`).get(momentId);
  if (!row) return res.status(404).json({ error: 'not_found' });

  db.prepare(`UPDATE moments SET is_deleted=1 WHERE id=?`).run(momentId);

  let broadcast = null;
  if (row.scope === 'public') {
    try {
      broadcast = await broadcastAction({
        target_moment_id: momentId,
        operator_id: config.SELF_NODE_ID,
        operator_identity_id: row.identity_id,
        operator_name: identityName(row.identity_id),
        action_type: 'delete',
        content: null,
      });
    } catch (e) {
      broadcast = { error: e.message };
    }
  }

  res.json({ ok: true, broadcast });
});

// 本地点赞/评论（写库；public 评论可选择是否外推——MVP 只落本地作者节点）
router.post('/local-action', localhostOnly, (req, res) => {
  const { target_moment_id, action_type, content, identity_id } = req.body || {};
  if (!target_moment_id || !action_type) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  if (action_type !== 'like' && action_type !== 'comment') {
    return res.status(400).json({ error: 'bad_action_type' });
  }

  let ident = identity_id || config.SELF_HUMAN_ID;
  if (action_type === 'comment') {
    const mod = moderateLocal(content || '', 'comment', target_moment_id);
    if (!mod.safe) {
      return res.json({ ok: true, downgraded: true, action: 'like_only', moderation: mod });
    }
  }

  const id = `${config.SELF_NODE_ID}_${nanoid(10)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moment_interactions
      (id, target_moment_id, operator_id, operator_identity_id, operator_name, action_type, content, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    id,
    target_moment_id,
    config.SELF_NODE_ID,
    ident,
    identityName(ident),
    action_type === 'comment' && !(content || '').trim() ? 'like' : action_type,
    content || null,
    now
  );

  res.json({ ok: true, interaction_id: id });
});

module.exports = router;
