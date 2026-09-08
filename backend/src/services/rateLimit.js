/** 简单内存限流：key -> 时间戳数组 */
const buckets = new Map();

function allow(key, limit, windowMs = 3600 * 1000) {
  const now = Date.now();
  let arr = buckets.get(key) || [];
  arr = arr.filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

module.exports = { allow };
