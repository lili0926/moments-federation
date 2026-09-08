const { nanoid } = require('nanoid');
const db = require('../db');

/**
 * 第1层：关键词过滤（便宜兜底）
 * 返回 { ok:true } 或 { ok:false, reason:'keyword_blocked', keyword }
 */
function checkKeywords(text) {
  const content = String(text || '');
  const rows = db.prepare(`SELECT keyword FROM blocked_keywords`).all();
  for (const r of rows) {
    if (r.keyword && content.includes(r.keyword)) {
      return { ok: false, reason: 'keyword_blocked', keyword: r.keyword };
    }
  }
  return { ok: true };
}

/**
 * 第2层占位：二次 AI 审查应由聊天后端调用外部模型后，
 * 把结果传给 /internal/moderate-content 的 moderation_result。
 * 本函数只做关键词 + 记审计日志。
 */
function moderateLocal(content, contentType, targetMomentId) {
  const kw = checkKeywords(content);
  const result = kw.ok ? 'safe' : 'keyword_blocked';
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO public_audit_log (id, content_type, content, target_moment_id, moderation_result, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, contentType, String(content || '').slice(0, 2000), targetMomentId || null, result, now);

  if (!kw.ok) {
    return { safe: false, moderation_result: 'keyword_blocked', keyword: kw.keyword };
  }
  return { safe: true, moderation_result: 'safe' };
}

function auditExternalResult(content, contentType, targetMomentId, moderationResult) {
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const result = moderationResult || 'safe';
  db.prepare(
    `INSERT INTO public_audit_log (id, content_type, content, target_moment_id, moderation_result, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, contentType, String(content || '').slice(0, 2000), targetMomentId || null, result, now);
  return { safe: result === 'safe', moderation_result: result };
}

module.exports = { checkKeywords, moderateLocal, auditExternalResult };
