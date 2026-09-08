const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

function sign(sharedSecret, bodyString, timestamp) {
  return crypto
    .createHmac('sha256', sharedSecret)
    .update(bodyString + timestamp)
    .digest('hex');
}

// 校验来自好友节点的联邦请求：X-Sender-ID / X-Timestamp / X-Signature
function verifyFederationRequest(req, res, next) {
  const senderId = req.header('X-Sender-ID');
  const timestamp = req.header('X-Timestamp');
  const signature = req.header('X-Signature');

  if (!senderId || !timestamp || !signature) {
    return res.status(401).json({ error: 'missing_auth_headers' });
  }

  const friend = db.prepare(
    `SELECT * FROM friends WHERE friend_id = ? AND status = 'accepted'`
  ).get(senderId);

  if (!friend) {
    return res.status(401).json({ error: 'unknown_sender' });
  }

  // 时间窗口校验，防重放
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Math.abs(now - ts) > config.SIGNATURE_WINDOW_SECONDS) {
    return res.status(401).json({ error: 'timestamp_expired' });
  }

  // 签名重算校验
  const bodyString = JSON.stringify(req.body);
  const expected = sign(friend.shared_secret, bodyString, timestamp);
  if (expected !== signature) {
    return res.status(401).json({ error: 'signature_mismatch' });
  }

  req.federationFriend = friend;
  next();
}

// 只允许本机/内网访问（聊天打通接口、内部审批接口用这个）
function localhostOnly(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'internal_route_forbidden_from_public' });
  }
  next();
}

module.exports = { sign, verifyFederationRequest, localhostOnly };
