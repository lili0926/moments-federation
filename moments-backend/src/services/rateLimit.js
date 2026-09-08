const config = require('../config');

// 内存版限流：key -> [timestamps]。生产环境好友量大了建议换Redis，MVP阶段够用。
const buckets = new Map();

function isRateLimited(key, limitPerHour = config.FRIEND_REQUEST_RATE_LIMIT) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (list.length >= limitPerHour) {
    buckets.set(key, list);
    return true;
  }

  list.push(now);
  buckets.set(key, list);
  return false;
}

module.exports = { isRateLimited };
