const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

function signBody(secret, bodyString, timestamp) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(timestamp) + '.' + bodyString)
    .digest('hex');
}

/** 对外联邦请求：校验发送方 + HMAC + 时间窗 */
function verifyFederationRequest(req, res, next) {
  const senderId = req.get('X-Sender-ID');
  const timestamp = req.get('X-Timestamp');
  const signature = req.get('X-Signature');

  if (!senderId || !timestamp || !signature) {
    return res.status(401).json({ error: 'missing_auth_headers' });
  }

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!ts || Math.abs(now - ts) > config.SIGNATURE_WINDOW_SECONDS) {
    return res.status(401).json({ error: 'timestamp_out_of_window' });
  }

  const friend = db
    .prepare(`SELECT * FROM friends WHERE friend_id=? AND status='accepted'`)
    .get(senderId);
  if (!friend) {
    return res.status(401).json({ error: 'unknown_or_pending_friend' });
  }

  const raw = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const expected = signBody(friend.shared_secret, raw, ts);
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad_signature' });
    }
  } catch {
    return res.status(401).json({ error: 'bad_signature' });
  }

  req.friend = friend;
  req.senderId = senderId;
  next();
}

/** 仅本机 / 反向代理后的本地调用 */
function localhostOnly(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const ok =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1');
  if (!ok) {
    return res.status(403).json({ error: 'localhost_only' });
  }
  next();
}

/**
 * 前端管理通道鉴权。
 *
 * 与 localhostOnly 的关系：localhostOnly 保护的是 /internal/*（AI 代发圈等），
 * 那些口永远不出公网。adminOnly 保护的是本人从手机/浏览器操作的 /api/admin/*，
 * 走公网但必须持 ADMIN_TOKEN。两者不可互相替代。
 *
 * 注意：比较前先 sha256，使两边长度固定，避免 timingSafeEqual 因长度不等
 * 提前返回而泄漏 token 长度。
 */
function adminOnly(req, res, next) {
  if (!config.ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'admin_not_configured',
      hint: '在 .env 里设置 ADMIN_TOKEN 后重启',
    });
  }
  const presented = req.get('X-Admin-Token') || '';
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(config.ADMIN_TOKEN, 'utf8').digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad_admin_token' });
  }
  next();
}

module.exports = { verifyFederationRequest, localhostOnly, adminOnly, signBody };
