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
 * @returns {{ action: 'like_only'|'ask_llm'|'blocked', reason?: string, forceComment?: boolean }}
 */
function decideAction(momentId, myIdentityId, friendNodeId, friendIdentityId) {
  const cap = checkExchangeCap(momentId, myIdentityId, friendIdentityId);
  if (!cap.allowed) {
    return { action: 'blocked', reason: cap.reason };
  }

  const mode = resolveReplyMode(friendNodeId, friendIdentityId);
  if (mode === 'like_only') {
    return { action: 'like_only', reason: 'friend_set_to_like_only' };
  }
  if (mode === 'always_comment') {
    return { action: 'ask_llm', forceComment: true };
  }
  return { action: 'ask_llm', forceComment: false };
}

module.exports = {
  checkExchangeCap,
  recordExchange,
  resolveReplyMode,
  decideAction,
};
