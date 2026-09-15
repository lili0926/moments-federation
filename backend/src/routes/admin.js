const express = require('express');
const db = require('../db');
const config = require('../config');
const { adminOnly } = require('../middleware/auth');
const { allow } = require('../services/rateLimit');
const {
  selfInviteCode,
  decodeInviteCode,
  sendFriendRequest,
  reviewFriendRequest,
  listPendingHandshakes,
} = require('../services/handshake');
const { localIdentitiesPayload } = require('./friends');
const { decideAction, recordExchange } = require('../services/replyControl');
const { moderateLocal } = require('../services/moderation');
const { postSigned, broadcastMoment, broadcastAction } = require('../services/federation');
const { nanoid } = require('nanoid');

const router = express.Router();

/**
 * CORS：前端跑在手机 App / 浏览器里，跨域调本口。
 * X-Admin-Token 是自定义头，必然触发预检，而预检不带该头，
 * 所以这段必须排在 adminOnly 前面。
 *
 * 只在这里加一份 ACAO —— nginx 侧千万别再 add_header 一次，
 * 浏览器见到两个 Access-Control-Allow-Origin 会直接判 CORS 失败。
 */
router.use((req, res, next) => {
  const origin = req.get('Origin');
  const allowed = config.ADMIN_CORS_ORIGINS;
  // '*' 放行任意来源。真正的鉴权是 X-Admin-Token，CORS 只是纵深防御；
  // Capacitor WebView 的 Origin 随 androidScheme 变（https://localhost、
  // capacitor://localhost、file:// 都可能），列举容易漏，所以给个通配。
  if (origin && (allowed.includes('*') || allowed.includes(origin.replace(/\/$/, '')))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 爆破防护：admin token 是长期凭据，按来源 IP 限流
router.use((req, res, next) => {
  if (!allow(`admin:${req.ip}`, config.ADMIN_RATE_LIMIT)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
});

router.use(adminOnly);

// 本节点信息 + 我的邀请码（前端展示二维码用）
router.get('/me', (req, res) => {
  res.json({
    node_id: config.SELF_NODE_ID,
    display_name: config.SELF_DISPLAY_NAME,
    server_url: config.SELF_SERVER_URL,
    phase: config.PHASE,
    invite_code: selfInviteCode(),
    identities: localIdentitiesPayload(),
  });
});

// 解析别人的邀请码，给前端做「确认要加这个人吗」的预览
router.post('/invite/parse', (req, res) => {
  const parsed = decodeInviteCode((req.body || {}).code);
  if (!parsed) return res.status(400).json({ error: 'bad_invite_code' });
  res.json(parsed);
});

// 发起好友申请：贴邀请码，或直接给对方地址
router.post('/friends/invite', async (req, res) => {
  const body = req.body || {};
  let target = body.target_server;
  let peerName = null;
  let peerNodeId = null;

  if (body.code) {
    const parsed = decodeInviteCode(body.code);
    if (!parsed) return res.status(400).json({ error: 'bad_invite_code' });
    target = parsed.server_url;
    peerName = parsed.display_name;
    peerNodeId = parsed.node_id;
  }
  if (!target) return res.status(400).json({ error: 'need_code_or_target_server' });

  const r = await sendFriendRequest({
    target_server: target,
    message: body.message,
    peer_name: peerName,
    peer_node_id: peerNodeId,
  });
  const { status, ...rest } = r;
  res.status(status).json(rest);
});

// 待办：收到的申请 + 我发出去还没回音的
router.get('/friends/requests', (req, res) => {
  res.json(listPendingHandshakes());
});

// 审批：accept / reject
router.post('/friends/review', async (req, res) => {
  const body = req.body || {};
  const token = body.request_token || body.request_id;
  const r = await reviewFriendRequest({ token, action: body.action });
  const { status, ...rest } = r;
  res.status(status).json(rest);
});

// 好友列表（与 /api/friends/ 同结构，区别只是鉴权方式）
router.get('/friends', (req, res) => {
  const friends = db
    .prepare(`SELECT friend_id, display_name, server_url, status, created_at FROM friends`)
    .all();
  res.json(
    friends.map((f) => ({
      friend_node_id: f.friend_id,
      node_display_name: f.display_name,
      server_url: f.server_url,
      status: f.status,
      created_at: f.created_at,
      identities: db
        .prepare(
          `SELECT identity_id, display_name, type, remark, reply_mode
           FROM friend_identities WHERE friend_node_id=?`
        )
        .all(f.friend_id),
    }))
  );
});

router.post('/friends/:friendId/:identityId/remark', (req, res) => {
  const { friendId, identityId } = req.params;
  const remark = (req.body && req.body.remark) || null;
  const info = db
    .prepare(`UPDATE friend_identities SET remark=? WHERE friend_node_id=? AND identity_id=?`)
    .run(remark, friendId, identityId);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/**
 * 公共朋友圈时间线：好友推过来的 + 我自己发的 public，合成一条。
 *
 * 为什么要在 admin 下再开一个口：`/api/moments/feed` 是 localhostOnly，
 * 而且不在 nginx 白名单里 —— 手机上的 App 根本够不到。
 */
router.get('/feed', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10) || 30, 1), 100);

  const nameOf = (identityId) => {
    const r = db
      .prepare(`SELECT display_name FROM local_identities WHERE identity_id=?`)
      .get(identityId);
    return r ? r.display_name : config.SELF_DISPLAY_NAME;
  };

  const fromFriends = db
    .prepare(
      `SELECT moment_id, author_id, author_identity_id, author_name, author_server, content, created_at
       FROM public_feed_cache WHERE is_deleted=0 ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => Object.assign({}, r, { from: 'friend' }));

  const fromSelf = db
    .prepare(
      `SELECT id, identity_id, content, created_at
       FROM moments WHERE scope='public' AND is_deleted=0 ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => ({
      moment_id: r.id,
      author_id: config.SELF_NODE_ID,
      author_identity_id: r.identity_id,
      author_name: nameOf(r.identity_id),
      author_server: config.SELF_SERVER_URL,
      content: r.content,
      created_at: r.created_at,
      from: 'self',
    }));

  const interactionsOf = db.prepare(
    `SELECT operator_id, operator_identity_id, operator_name, action_type, content, reply_to_name, created_at
     FROM moment_interactions WHERE target_moment_id=? AND is_deleted=0 ORDER BY created_at ASC`
  );

  const items = fromFriends
    .concat(fromSelf)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((m) => {
      const acts = interactionsOf.all(m.moment_id);
      return Object.assign({}, m, {
        likes: acts.filter((a) => a.action_type === 'like'),
        comments: acts.filter((a) => a.action_type === 'comment'),
        // 前端据此跳过已经处理过的，别每次刷新都再问一遍模型
        acted_identities: [
          ...new Set(acts.filter((a) => a.operator_id === config.SELF_NODE_ID)
            .map((a) => a.operator_identity_id)),
        ],
      });
    });

  res.json({ items, threshold: config.REPLY_WILLINGNESS_THRESHOLD });
});

/**
 * 发一条公共动态并广播给好友。
 *
 * `/api/moments/publish` 是 localhostOnly，手机上的 App 够不到 ——
 * 没有这个口，她在公共朋友圈里发的东西一辈子出不了这台机器。
 * 这里只发 public：private 的动态本来就该留在 App 本地，不该上 VPS。
 */
router.post('/publish', async (req, res) => {
  const body = req.body || {};
  const content = String(body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'empty_content' });

  let identity_id = body.identity_id || config.SELF_HUMAN_ID;
  const idRow = db
    .prepare(`SELECT identity_id, display_name FROM local_identities WHERE identity_id=?`)
    .get(identity_id);
  if (!idRow) identity_id = config.SELF_HUMAN_ID;

  const mod = moderateLocal(content, 'moment', null);
  if (!mod.safe) return res.status(400).json({ error: 'content_blocked', moderation: mod });

  const id = `${config.SELF_NODE_ID}_${nanoid(12)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moments (id, author_id, identity_id, content, scope, created_at, is_deleted)
     VALUES (?, ?, ?, ?, 'public', ?, 0)`
  ).run(id, config.SELF_NODE_ID, identity_id, content, now);

  // 广播失败不回滚：动态已经是自己的了，好友那边下次 sync 还能补上
  let broadcast = null;
  try {
    broadcast = await broadcastMoment({
      id,
      identity_id,
      content,
      created_at: now,
      author_name: idRow ? idRow.display_name : config.SELF_DISPLAY_NAME,
    });
  } catch (e) {
    broadcast = { error: e.message };
  }

  res.json({ ok: true, moment: { id, identity_id, content, scope: 'public', created_at: now }, broadcast });
});

/**
 * 替本机身份对好友的一条动态出手：点赞 / 评论。
 *
 * **闸门放在服务端，不放在 App**：往返上限和阈值都在这儿判，
 * 前端就算改了也绕不过去（而且计数本来就只有服务端有）。
 * body: { identity_id?, willingness?, comment? }
 * - willingness 低于阈值 / 好友被设成 like_only  → 只点赞
 * - 往返数满 MAX_EXCHANGE_ROUNDS               → 什么都不做
 * - 判定该评论但没给 comment 正文               → 退化成点赞
 */
router.post('/moments/:momentId/react', async (req, res) => {
  const { momentId } = req.params;
  const body = req.body || {};
  const identity_id = body.identity_id || config.SELF_AI_ID;
  let comment = String(body.comment || '').trim().slice(0, 500);
  let replyToName = String(body.reply_to_name || body.replyToName || '').trim().slice(0, 40);
  // 兼容旧客户端把「回复X：」写在正文里
  if (!replyToName && comment) {
    const m = comment.match(/^回复\s*([^：:：]{1,40})\s*[：:]\s*([\s\S]*)$/);
    if (m) {
      replyToName = m[1].trim();
      comment = m[2].trim();
    }
  }
  // 广播给旧节点：content 可带前缀；本机库 content 存纯正文 + reply_to_name
  const commentForPeer = replyToName && comment && !/^回复/.test(comment)
    ? (`回复${replyToName}：` + comment).slice(0, 500)
    : comment;

  // 好友推来的动态在 public_feed_cache；自己发的在 moments。
  // 只查前者的话，AI 连她自己发的公共动态都评论不了（实测 moment_not_found）。
  let target = db
    .prepare(`SELECT * FROM public_feed_cache WHERE moment_id=? AND is_deleted=0`)
    .get(momentId);
  let isOwn = false;
  if (!target) {
    const own = db
      .prepare(`SELECT id, identity_id FROM moments WHERE id=? AND scope='public' AND is_deleted=0`)
      .get(momentId);
    if (own) {
      isOwn = true;
      target = {
        moment_id: own.id,
        author_id: config.SELF_NODE_ID,
        author_identity_id: own.identity_id,
        author_server: config.SELF_SERVER_URL,
      };
    }
  }
  if (!target) return res.status(404).json({ error: 'moment_not_found' });

  // 自己发的不用找好友（作者就是本机）；好友的才需要拿共享密钥去推
  let friend = null;
  if (!isOwn) {
    friend = db
      .prepare(`SELECT * FROM friends WHERE friend_id=? AND status='accepted'`)
      .get(target.author_id);
    if (!friend) return res.status(400).json({ error: 'not_a_friend' });
  }
  // 自己给自己：不能点赞；但可以在自己动态下评论（微信同款，方便回别人的评论）
  if (isOwn && identity_id === target.author_identity_id && !comment) {
    return res.status(400).json({ error: 'cannot_like_own', message: '不能给自己点赞' });
  }

  const decision = decideAction(
    momentId,
    identity_id,
    target.author_id,
    target.author_identity_id,
    body.willingness
  );
  // 用户主动写了评论：以评论为准，不被 willingness / like_only 降成只点赞。
  // **但往返上限照拦** —— 那是防两个 AI 在一条动态底下无限来回的硬闸，不是口味设定。
  //
  // 注意这里判的是 action 而不是 reason：decideAction 里 blocked 只有一个来源
  // （checkExchangeCap），它给的 reason 是 'exchange_cap_reached'。
  // 原来写的是 `decision.reason === 'max_rounds'` —— 那个字符串谁都不会返回，
  // 于是这道闸对手写评论一次都没生效过（测试抓出来的）。
  if (decision.action === 'blocked') {
    return res.json({ ok: true, did: 'nothing', reason: decision.reason, decision });
  }

  let action_type = comment ? 'comment' : 'like';

  if (action_type === 'comment') {
    const mod = moderateLocal(comment, 'comment', momentId);
    if (!mod.safe) return res.status(400).json({ error: 'content_blocked', moderation: mod });
  } else {
    // 同一个身份别重复点赞（前端重试、她手滑刷新都可能重来一次）
    const dup = db
      .prepare(
        `SELECT id FROM moment_interactions
         WHERE target_moment_id=? AND operator_id=? AND operator_identity_id=?
           AND action_type='like' AND is_deleted=0`
      )
      .get(momentId, config.SELF_NODE_ID, identity_id);
    if (dup) return res.json({ ok: true, did: 'nothing', reason: 'already_liked', decision });
  }

  const operator_name = (() => {
    const r = db
      .prepare(`SELECT display_name FROM local_identities WHERE identity_id=?`)
      .get(identity_id);
    return r ? r.display_name : config.SELF_DISPLAY_NAME;
  })();

  const payload = {
    target_moment_id: momentId,
    operator_id: config.SELF_NODE_ID,
    operator_identity_id: identity_id,
    operator_name,
    action_type,
    content: action_type === 'comment' ? commentForPeer : null,
    reply_to_name: action_type === 'comment' ? (replyToName || null) : null,
  };

  if (isOwn) {
    // 动态在本机，不用推给作者。但要广播给所有好友，否则他们看到的那条底下是空的。
    // 广播失败不算失败：互动已经记在本机了，别为了对方掉线就丢掉这条评论。
    try {
      await broadcastAction(payload);
    } catch (e) {
      /* 好友不可达就算了 */
    }
  } else {
    // 只发给作者那台，不广播 —— 动态在人家的库里，别的好友那儿没有这条
    try {
      await postSigned(friend.server_url, '/api/moments/action', friend.shared_secret, payload);
    } catch (e) {
      return res.status(502).json({ error: 'peer_unreachable', detail: e.message });
    }
  }

  const id = `${config.SELF_NODE_ID}_a${Date.now().toString(36)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO moment_interactions
      (id, target_moment_id, operator_id, operator_identity_id, operator_name, action_type, content, reply_to_name, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    id, momentId, config.SELF_NODE_ID, identity_id, operator_name, action_type,
    action_type === 'comment' ? comment : null,
    action_type === 'comment' ? (replyToName || null) : null,
    now
  );

  // 本机这边的往返数也要涨，否则只有对方在数，闸门是瘸的
  if (action_type === 'comment') {
    recordExchange(momentId, identity_id, target.author_identity_id);
  }

  res.json({ ok: true, did: action_type, interaction_id: id, decision });
});


/**
 * 删除本机发的公共动态（软删 + 广播墓碑给好友）。
 * body 可选：无。只能删自己 moments 表里的。
 */
router.post('/moments/:momentId/delete', async (req, res) => {
  const { momentId } = req.params;
  if (!momentId) return res.status(400).json({ error: 'missing_moment_id' });

  const row = db.prepare(`SELECT * FROM moments WHERE id=? AND is_deleted=0`).get(momentId);
  if (!row) return res.status(404).json({ error: 'moment_not_found' });
  if (row.scope !== 'public') {
    // 私人动态不在联邦库对外删；前端私人圈本地处理
    return res.status(400).json({ error: 'not_public_moment' });
  }

  db.prepare(`UPDATE moments SET is_deleted=1 WHERE id=?`).run(momentId);
  // 本机 feed 缓存里若有镜像也软删
  try {
    db.prepare(`UPDATE public_feed_cache SET is_deleted=1 WHERE moment_id=?`).run(momentId);
  } catch (e) {}

  let broadcast = null;
  try {
    broadcast = await broadcastAction({
      target_moment_id: momentId,
      operator_id: config.SELF_NODE_ID,
      operator_identity_id: row.identity_id,
      operator_name: (() => {
        const r = db.prepare(`SELECT display_name FROM local_identities WHERE identity_id=?`).get(row.identity_id);
        return r ? r.display_name : config.SELF_DISPLAY_NAME;
      })(),
      action_type: 'delete',
      content: null,
    });
  } catch (e) {
    broadcast = { error: e.message };
  }

  res.json({ ok: true, broadcast });
});

router.post('/friends/:friendId/:identityId/reply-mode', (req, res) => {
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

module.exports = router;
