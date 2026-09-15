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

/**
 * 这个地址是不是内网 / 回环 / 云厂商元数据。
 *
 * 为什么要管：审批别人的申请时，服务端会主动去 fetch 对方**在申请里自报的**
 * from_server（回调 /api/friends/accept-callback）。不挡的话，任何人发一条申请、
 * 把 from_server 指向 http://127.0.0.1:xxxx 或 http://100.100.100.200/（阿里云
 * 元数据服务），机主一点「同意」，这台机器就会带着刚生成的 shared_secret 去打那个地址 ——
 * 一个由陌生人指定目标的内网请求。响应虽然不回显，但足以探测内网端口、触发副作用。
 *
 * **默认拦住，用 ALLOW_PRIVATE_PEERS=1 放开** —— 本机自测（两个节点都在
 * 127.0.0.1 上）和局域网部署需要它。给别人用的正式节点别开。
 */
function isPrivateHost(urlStr) {
  let host;
  try {
    host = new URL(String(urlStr)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true; // 解析不了的一律当不安全
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv6 私有 / 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;       // 链路本地（AWS/GCP 元数据也在这）
    if (a === 100 && b === 100) return true;       // 阿里云元数据 100.100.100.200
    if (a >= 224) return true;                     // 组播 / 保留
  }
  return false;
}

/** 允许往这个地址发请求吗（默认不许内网，见 isPrivateHost 的注释）。 */
function peerAddressAllowed(urlStr) {
  if (process.env.ALLOW_PRIVATE_PEERS === '1') return true;
  return !isPrivateHost(urlStr);
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
  if (!peerAddressAllowed(serverUrl)) {
    return { ok: false, status: 400, error: 'private_address_not_allowed' };
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

  // 回调的目标地址是**申请方自报的**，同意之前先确认它不是内网/元数据地址 ——
  // 否则陌生人可以让这台机器带着新生成的 secret 去打她自己的内网（见 isPrivateHost）。
  if (!peerAddressAllowed(row.from_server)) {
    return { ok: false, status: 400, error: 'private_address_not_allowed' };
  }

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
  isPrivateHost,
  peerAddressAllowed,
  encodeInviteCode,
  decodeInviteCode,
  selfInviteCode,
  sendFriendRequest,
  reviewFriendRequest,
  listPendingHandshakes,
};
