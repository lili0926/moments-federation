const db = require('../db');
const config = require('../config');

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

/** identity 级往返上限 */
function checkExchangeCap(momentId, myIdentityId, otherIdentityId) {
  const [low, high] = pairKey(String(myIdentityId), String(otherIdentityId));
  const row = db
    .prepare(
      `SELECT * FROM interaction_state WHERE moment_id=? AND participant_low=? AND participant_high=?`
    )
    .get(momentId, low, high);

  if (!row) return { allowed: true, currentCount: 0 };
  if (row.exchange_count >= config.MAX_EXCHANGE_ROUNDS) {
    return { allowed: false, currentCount: row.exchange_count, reason: 'exchange_cap_reached' };
  }
  return { allowed: true, currentCount: row.exchange_count };
}

function recordExchange(momentId, myIdentityId, otherIdentityId) {
  const [low, high] = pairKey(String(myIdentityId), String(otherIdentityId));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO interaction_state (moment_id, participant_low, participant_high, exchange_count, last_actor_id, last_action_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(moment_id, participant_low, participant_high)
     DO UPDATE SET exchange_count = exchange_count + 1,
       last_actor_id = excluded.last_actor_id,
       last_action_at = excluded.last_action_at`
  ).run(momentId, low, high, myIdentityId, now);
}

/**
 * 按对方 identity 取 reply_mode；无记录时：human→llm_decide，ai→like_only
 */
function resolveReplyMode(friendNodeId, friendIdentityId) {
  const row = db
    .prepare(
      `SELECT reply_mode, type FROM friend_identities WHERE friend_node_id=? AND identity_id=?`
    )
    .get(friendNodeId, friendIdentityId);
  if (row) return row.reply_mode;
  // 回退：查 type
  const t = db
    .prepare(`SELECT type FROM friend_identities WHERE friend_node_id=? AND identity_id=?`)
    .get(friendNodeId, friendIdentityId);
  if (t && t.type === 'ai') return 'like_only';
  return 'llm_decide';
}

/**
 * 把「想回复的程度」规整成 0–100 的整数；给不出数就返回 null（当作没提供）
 */
function normalizeWillingness(v) {
  if (v === undefined || v === null || v === '') return null;
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  // 容错：模型有时给 0–1 的小数
  if (n > 0 && n <= 1) n = n * 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * @param {number|string} [willingness] 聊天端模型给的「想回复的程度」0–100。
 *   不传就还是老行为（交给模型自己决定），传了就在这里过一道阈值。
 * @returns {{ action: 'like_only'|'ask_llm'|'blocked', reason?: string,
 *             forceComment?: boolean, willingness?: number, threshold?: number }}
 */
function decideAction(momentId, myIdentityId, friendNodeId, friendIdentityId, willingness) {
  const threshold = config.REPLY_WILLINGNESS_THRESHOLD;
  const cap = checkExchangeCap(momentId, myIdentityId, friendIdentityId);
  if (!cap.allowed) {
    return { action: 'blocked', reason: cap.reason, threshold };
  }

  const mode = resolveReplyMode(friendNodeId, friendIdentityId);
  if (mode === 'like_only') {
    return { action: 'like_only', reason: 'friend_set_to_like_only', threshold };
  }
  // always_comment 是她对这个好友的显式设定，比阈值优先 —— 设了「总是评论」还被分数挡下来会很怪
  if (mode === 'always_comment') {
    return { action: 'ask_llm', forceComment: true, threshold };
  }

  const w = normalizeWillingness(willingness);
  if (w !== null && w < threshold) {
    return {
      action: 'like_only',
      reason: 'below_willingness_threshold',
      willingness: w,
      threshold,
    };
  }

  return { action: 'ask_llm', forceComment: false, willingness: w === null ? undefined : w, threshold };
}

module.exports = {
  checkExchangeCap,
  recordExchange,
  resolveReplyMode,
  normalizeWillingness,
  decideAction,
};
