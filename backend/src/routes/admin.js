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
