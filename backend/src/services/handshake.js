const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const INVITE_PREFIX = 'MF1:';

/** 规范化对方节点地址：只收 http/https，去掉尾斜杠，保留路径前缀 */
function normalizeServerUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + path;
}

/** 邀请码：把「我是谁 + 我在哪」打成一串可以微信发出去的文本 */
function encodeInviteCode(info) {
  const payload = JSON.stringify({
    v: 1,
    n: info.node_id,
    s: info.server_url,
    d: info.display_name,
  });
  return INVITE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeInviteCode(code) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(INVITE_PREFIX)) return null;
  let obj;
  try {
    const json = Buffer.from(raw.slice(INVITE_PREFIX.length), 'base64url').toString('utf8');
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || obj.v !== 1) return null;
  const server_url = normalizeServerUrl(obj.s);
  if (!server_url) return null;
  return {
    node_id: obj.n || null,
    server_url,
    display_name: obj.d || null,
  };
}

function selfInviteCode() {
  return encodeInviteCode({
    node_id: config.SELF_NODE_ID,
    server_url: config.SELF_SERVER_URL,
    display_name: config.SELF_DISPLAY_NAME,
  });
}

/**
 * 主动发起好友申请。
 *
 * 本机生成 verify_token 存为 direction='out'，对方审批后会凭它回调
 * /api/friends/accept-callback —— 那个口只认 'out' 方向的 token，
 * 所以别人发来的申请无法自己把自己批准掉。
 */
async function sendFriendRequest({ target_server, message, peer_name, peer_node_id }) {
  const serverUrl = normalizeServerUrl(target_server);
  if (!serverUrl) {
    return { ok: false, status: 400, error: 'bad_target_server' };
  }
  if (serverUrl === normalizeServerUrl(config.SELF_SERVER_URL)) {
    return { ok: false, status: 400, error: 'cannot_add_self' };
  }

  const { localIdentitiesPayload } = require('../routes/friends');
  const verify_token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const expires = now + config.HANDSHAKE_TOKEN_TTL_SECONDS;

  // from_id / from_name 在 'out' 记录里存的是「对方是谁」，来自邀请码；
  // 只是给待办列表显示用，真正的身份以对方回调时带的为准
  db.prepare(
    `INSERT INTO handshake_tokens
      (token, from_id, from_name, from_server, identities_json, message, created_at, expires_at, used, direction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'out')`
  ).run(
    verify_token,
    peer_node_id || null,
    peer_name || null,
    serverUrl,
    JSON.stringify(localIdentitiesPayload()),
    String(message || ''),
    now,
    expires
  );

  const body = {
    from_id: config.SELF_NODE_ID,
    from_name: config.SELF_DISPLAY_NAME,
    from_server: config.SELF_SERVER_URL,
    verify_token,
    message: String(message || ''),
    identities: localIdentitiesPayload(),
  };

  try {
    const r = await fetch(serverUrl + '/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      db.prepare(`DELETE FROM handshake_tokens WHERE token=?`).run(verify_token);
      return {
        ok: false,
        status: r.status === 429 ? 429 : 502,
        error: r.status === 429 ? 'peer_rate_limited' : 'peer_rejected',
        detail: text.slice(0, 300),
      };
    }
  } catch (e) {
    db.prepare(`DELETE FROM handshake_tokens WHERE token=?`).run(verify_token);
    return { ok: false, status: 502, error: 'peer_unreachable', detail: e.message };
  }

  return {
    ok: true,
    status: 200,
    sent_to: serverUrl,
    expires_at: expires,
  };
}

/**
 * 审批别人发来的申请（direction='in'）。
 *
 * accept 的步骤顺序是刻意的：先回调对方成功，再落本地库。
 * 反过来的话，回调失败会留下「我方 accepted、对方毫不知情」的单边关系，
 * 而且 token 已被标记 used，重试都没得重试。
 */
async function reviewFriendRequest({ token, action }) {
  if (!token || !['accept', 'reject'].includes(action)) {
    return { ok: false, status: 400, error: 'need_token_and_action' };
  }

  const row = db.prepare(`SELECT * FROM handshake_tokens WHERE token=?`).get(token);
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.used || row.expires_at < now) {
    return { ok: false, status: 404, error: 'token_invalid' };
  }
  if (row.direction !== 'in') {
    return { ok: false, status: 400, error: 'not_an_incoming_request' };
  }

  if (action === 'reject') {
    db.prepare(`UPDATE handshake_tokens SET used=1 WHERE token=?`).run(token);
    db.prepare(`DELETE FROM friends WHERE friend_id=? AND status='pending'`).run(row.from_id);
    db.prepare(`DELETE FROM friend_identities WHERE friend_node_id=?`).run(row.from_id);
    return { ok: true, status: 200, action: 'reject', friend_id: row.from_id };
  }

  const { localIdentitiesPayload, upsertFriendIdentities } = require('../routes/friends');
  const shared_secret = crypto.randomBytes(32).toString('hex');

  // 先回调对方；失败则原样返回，token 未消耗，可以重试
  try {
    const url = String(row.from_server).replace(/\/$/, '') + '/api/friends/accept-callback';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Handshake-Token': token,
      },
      body: JSON.stringify({
        from_id: config.SELF_NODE_ID,
        from_name: config.SELF_DISPLAY_NAME,
        from_server: config.SELF_SERVER_URL,
        shared_secret,
        identities: localIdentitiesPayload(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, status: 502, error: 'callback_failed', detail: t.slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, status: 502, error: 'callback_error', detail: e.message };
  }

  // 对方已确认，落本地
  let identities = [];
  try {
    identities = JSON.parse(row.identities_json || '[]');
  } catch {
    identities = [];
  }

  db.transaction(() => {
    db.prepare(`UPDATE handshake_tokens SET used=1 WHERE token=?`).run(token);
    db.prepare(
      `INSERT INTO friends (friend_id, display_name, server_url, shared_secret, status, created_at)
       VALUES (?, ?, ?, ?, 'accepted', ?)
       ON CONFLICT(friend_id) DO UPDATE SET
         shared_secret=excluded.shared_secret,
         status='accepted',
         display_name=excluded.display_name,
         server_url=excluded.server_url`
    ).run(row.from_id, row.from_name, row.from_server, shared_secret, now);
    upsertFriendIdentities(row.from_id, identities);
  })();

  return { ok: true, status: 200, action: 'accept', friend_id: row.from_id };
}

/** 待处理的握手：收到的待审 + 我发出去还没回音的 */
function listPendingHandshakes() {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT token, from_id, from_name, from_server, identities_json, message,
              created_at, expires_at, direction
       FROM handshake_tokens
       WHERE used=0 AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .all(now);

  const shape = (r) => {
    let identities = [];
    try {
      identities = JSON.parse(r.identities_json || '[]');
    } catch {
      identities = [];
    }
    return {
      request_token: r.token,
      node_id: r.from_id,
      display_name: r.from_name,
      server_url: r.from_server,
      message: r.message,
      identities,
      created_at: r.created_at,
      expires_at: r.expires_at,
    };
  };

  return {
    incoming: rows.filter((r) => r.direction === 'in').map(shape),
    outgoing: rows.filter((r) => r.direction === 'out').map(shape),
  };
}

module.exports = {
  INVITE_PREFIX,
  normalizeServerUrl,
  encodeInviteCode,
  decodeInviteCode,
  selfInviteCode,
  sendFriendRequest,
  reviewFriendRequest,
  listPendingHandshakes,
};
