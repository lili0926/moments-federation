const db = require('../db');
const config = require('../config');

/**
 * 防无限刷评论 —— 核心思路：
 *
 * 第一道闸：硬性往返上限（checkExchangeCap）
 *   不管AI多想回复，某条动态里"我"和"对方"之间的评论往返次数到了阈值，
 *   系统直接拒绝，这道闸不依赖AI的自觉，是保底刹车。
 *
 * 第二道闸：好友级别的回复策略（resolveReplyMode）
 *   reply_mode = 'like_only'   -> 压根不问AI要不要评论，自动点赞，直接返回
 *   reply_mode = 'always_comment' -> 跳过AI判断，强制走评论逻辑（不建议做默认值）
 *   reply_mode = 'llm_decide'  -> 前两道闸都放行后，才轮到调用你自己的AI/聊天逻辑
 *                                   去决定"这条到底要不要回"，prompt里要明确告诉AI
 *                                   "点赞是完整回应，不必每次都评论"
 */

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

function checkExchangeCap(momentId, myId, otherId) {
  const [low, high] = pairKey(myId, otherId);
  const row = db.prepare(
    `SELECT * FROM interaction_state WHERE moment_id=? AND participant_low=? AND participant_high=?`
  ).get(momentId, low, high);

  if (!row) return { allowed: true, currentCount: 0 };

  if (row.exchange_count >= config.MAX_EXCHANGE_ROUNDS) {
    return { allowed: false, currentCount: row.exchange_count, reason: 'exchange_cap_reached' };
  }
  return { allowed: true, currentCount: row.exchange_count };
}

function recordExchange(momentId, myId, otherId) {
  const [low, high] = pairKey(myId, otherId);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO interaction_state (moment_id, participant_low, participant_high, exchange_count, last_actor_id, last_action_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(moment_id, participant_low, participant_high)
    DO UPDATE SET exchange_count = exchange_count + 1, last_actor_id = excluded.last_actor_id, last_action_at = excluded.last_action_at
  `).run(momentId, low, high, myId, now);
}

function resolveReplyMode(friendId) {
  const friend = db.prepare(`SELECT reply_mode FROM friends WHERE friend_id=?`).get(friendId);
  return friend ? friend.reply_mode : 'llm_decide';
}

/**
 * 聊天后端在"要不要回这条评论"之前调这个函数（通过 /internal/should-comment 接口）
 * 返回 { action: 'like_only' | 'ask_llm' | 'blocked', reason }
 */
function decideAction(momentId, myId, commenterFriendId) {
  const cap = checkExchangeCap(momentId, myId, commenterFriendId);
  if (!cap.allowed) {
    return { action: 'blocked', reason: cap.reason };
  }

  const mode = resolveReplyMode(commenterFriendId);
  if (mode === 'like_only') {
    return { action: 'like_only', reason: 'friend_set_to_like_only' };
  }
  if (mode === 'always_comment') {
    return { action: 'ask_llm', forceComment: true };
  }
  // llm_decide：放行到AI自己判断，但仍然受第一道闸约束
  return { action: 'ask_llm', forceComment: false };
}

module.exports = { checkExchangeCap, recordExchange, resolveReplyMode, decideAction };
