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

/** 一条动态在缓存里能占多长。超了直接拒，不截断 ——
 *  截断会把别人的话改成半截，那比丢掉更糟。 */
const MAX_FEED_CONTENT = 10000;

/** 每个好友在本机缓存里最多留多少条。超了删他最旧的。
 *  不设上限的话，一个坏掉的好友节点可以慢慢把这台机器的磁盘写满
 *  （单条有 express.json 的 100KB 限制，但条数原来是无限的）。 */
const MAX_FEED_PER_FRIEND = 500;

function trimFriendFeed(authorId) {
  const n = db
    .prepare(`SELECT COUNT(*) c FROM public_feed_cache WHERE author_id=?`)
    .get(authorId).c;
  if (n <= MAX_FEED_PER_FRIEND) return 0;
  return db
    .prepare(
      `DELETE FROM public_feed_cache WHERE moment_id IN (
         SELECT moment_id FROM public_feed_cache WHERE author_id=?
         ORDER BY created_at ASC LIMIT ?
       )`
    )
    .run(authorId, n - MAX_FEED_PER_FRIEND).changes;
}

// 接收好友推送
router.post('/receive', verifyFederationRequest, (req, res) => {
  const {
    moment_id,
    author_identity_id,
    author_name,
    content,
    created_at,
  } = req.body || {};

  if (!moment_id || !content) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  if (String(content).length > MAX_FEED_CONTENT) {
    return res.status(413).json({ error: 'content_too_long', max: MAX_FEED_CONTENT });
  }

  // **author_id 一律取签名证明的那个发送方，不收 body 里自报的。**
  // 原来是 `author_id || req.senderId` —— 于是任何一个已加的好友都能推一条
  // author_id 写成别人的动态，在她的时间线里显示成那个人发的（实测可复现）。
  // author_server 同理：只认好友表里记着的那个地址。
  const aid = req.senderId;
  const aserver = req.friend?.server_url || '';

  // 身份（谁家的人/AI）可以自报，但必须**确实是这个节点名下的身份** ——
  // 握手时对方把 identities 给过来了，存在 friend_identities 里。
  // 不校验的话，A 可以用 A 的节点身份推一条、却标成 B 家 AI 说的。
  let aident = String(author_identity_id || '').trim() || 'unknown';
  let aname = req.friend?.display_name || aid;
  if (aident !== 'unknown') {
    const idRow = db
      .prepare(
        `SELECT display_name, remark FROM friend_identities
         WHERE friend_node_id=? AND identity_id=?`
      )
      .get(aid, aident);
    if (!idRow) aident = 'unknown';
    else aname = idRow.remark || idRow.display_name || aname;
  }
  // **显示名同样不收自报的。** 只修 author_id 是不够的：一条动态里写着「Alice」、
  // 实际是 Bob 推来的，她在时间线上看到的仍然是 Alice —— 眼睛看到的才是她的判断依据。
  // 名字一律取握手时存下来的那份（她自己设的备注优先）。
  // 代价：对方改了昵称这边不会自动更新，要重新握手或她自己改备注。这个交换值得。
  const cat = parseInt(created_at, 10) || Math.floor(Date.now() / 1000);

  // 一条动态只属于推它来的那个节点：别人已经推过的 moment_id 不许被覆盖。
  const prior = db.prepare(`SELECT author_id FROM public_feed_cache WHERE moment_id=?`).get(moment_id);
  if (prior && prior.author_id !== aid) {
    return res.status(409).json({ error: 'moment_id_owned_by_another_node' });
  }

  db.prepare(
    `INSERT INTO public_feed_cache
      (moment_id, author_id, author_identity_id, author_name, author_server, content, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(moment_id) DO UPDATE SET
       author_identity_id=excluded.author_identity_id,
       author_name=excluded.author_name,
       author_server=excluded.author_server,
       content=excluded.content,
       created_at=excluded.created_at,
       is_deleted=0`
  ).run(moment_id, aid, aident, aname, aserver, content, cat);

  trimFriendFeed(aid);
  res.json({ ok: true });
});

// 增量同步（Pull）
router.get('/sync', verifyFederationRequest, (req, res) => {
  let since = parseInt(req.query.since || '0', 10);
  if (!Number.isFinite(since) || since < 0) since = 0;

  // `since` 是对方给的，传 0 就是要全部历史 —— 也就是说**新加的好友默认能看到
  // 你加他之前发的所有公共动态**。这是联邦同步的常规做法，但不是每个人都想要。
  // 开了这个开关就以「成为好友的时间」为地板。
  if (config.SYNC_ONLY_AFTER_FRIENDSHIP && req.friend && req.friend.created_at) {
    // 减 1 秒是必须的，不是保守：时间戳只到秒，而下面是严格 `>`。
    // 不减的话，**加上好友那一秒里发的动态会永远同步不过去** ——
    // 地板一直是那个时刻，下次再拉也照样被排除掉。
    since = Math.max(since, req.friend.created_at - 1);
  }

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
    reply_to_name,
  } = req.body || {};

  if (!target_moment_id || !action_type) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  if (action_type === 'delete') {
    // 好友侧：只软删 cache。**必须带上 author_id** —— 原来这句没认作者，
    // 于是任何一个已加的好友都能删掉别的好友推来的动态（实测可复现）。
    // 下面那句本来就认（作者只可能是发送方自己），保持原样。
    db.prepare(`UPDATE public_feed_cache SET is_deleted=1 WHERE moment_id=? AND author_id=?`).run(
      target_moment_id,
      req.senderId
    );
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
  // 「回复某人：」既可能在 content 前缀里，也可能在 reply_to_name 字段里 ——
  // 发送方为了兼容旧节点会**两样都发**。所以前缀要无条件剥，不能因为
  // reply_to_name 有值就跳过（跳过的话本机库里存的就是带前缀的正文 +
  // 一个同样的 reply_to_name，渲染时得再拆一次，而且两处一旦不一致就对不上）。
  let pureContent = content || null;
  let rto = reply_to_name || null;
  if (pureContent) {
    const m = String(pureContent).match(/^回复\s*([^：:：]{1,40})\s*[：:]\s*([\s\S]*)$/);
    if (m) {
      if (!rto) rto = m[1].trim();   // 显式给的优先
      pureContent = m[2].trim();
    }
  }
  if (pureContent && pureContent.length > 1000) {
    return res.status(413).json({ error: 'comment_too_long' });
  }

  // **operator_id 一律取签名证明的那个发送方**，和 /receive 同一个理由：
  // 原来是 `operator_id || req.senderId`，于是一个已加的好友能用别人的名义
  // 在她的时间线里点赞和评论（实测可复现）。
  // 身份同样要校验是不是这个节点名下的。
  const opId = req.senderId;
  let opIdent = String(operator_identity_id || '').trim() || null;
  let opName = req.friend?.display_name || 'friend';
  if (opIdent) {
    const idRow = db
      .prepare(
        `SELECT display_name, remark FROM friend_identities
         WHERE friend_node_id=? AND identity_id=?`
      )
      .get(opId, opIdent);
    if (!idRow) opIdent = null;
    else opName = idRow.remark || idRow.display_name || opName;
  }

  db.prepare(
    `INSERT INTO moment_interactions
      (id, target_moment_id, operator_id, operator_identity_id, operator_name, action_type, content, reply_to_name, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    id,
    target_moment_id,
    opId,
    opIdent,
    opName,
    action_type,
    pureContent,
    rto,
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
