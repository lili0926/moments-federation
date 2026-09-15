const express = require('express');
const config = require('./config');
require('./db'); // init schema

const momentsRouter = require('./routes/moments');
const friendsRouter = require('./routes/friends');
const internalRouter = require('./routes/internal');
const adminRouter = require('./routes/admin');

const app = express();

// 保留 rawBody 供 HMAC 验签
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString('utf8') : '';
    },
  })
);
// 保持 false：req.ip 始终是直连对端。
// 注意 localhostOnly 因此只是「没被 nginx 放行」的同义词——经 nginx 反代来的请求
// req.ip 就是 127.0.0.1，一样能过。/internal/* 的真正防线是 nginx 白名单里
// 没有它，别指望这个中间件能挡住被放行的路径。
app.set('trust proxy', false);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    phase: config.PHASE,
    node: config.SELF_NODE_ID,
    name: config.SELF_DISPLAY_NAME,
  });
});

// 始终挂载：本地专用接口在路由内 localhostOnly
app.use('/api/moments', momentsRouter);
app.use('/api/friends', friendsRouter);
app.use('/internal', internalRouter);
// 前端管理通道：走公网但需 ADMIN_TOKEN。与 /internal 的区别见 middleware/auth.js
app.use('/api/admin', adminRouter);

// PHASE>=2 才“逻辑上启用联邦”；实际公网暴露靠 nginx 白名单
// PHASE=1 时仍可本机调 receive/sync 做单测，但文档约定不开放公网
if (config.PHASE < 2) {
  console.log('[moments] PHASE=1：请勿将 /api/moments/receive|sync 与 /api/friends/* 暴露公网');
}
if (!config.ADMIN_TOKEN) {
  console.log('[moments] 未设置 ADMIN_TOKEN，/api/admin/* 全部返回 503（前端加好友不可用）');
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

/**
 * 审核日志的清理。
 *
 * public_audit_log 每发一条动态 / 每写一条评论就记一行，还带最多 2000 字正文，
 * 而且从来没有任何东西删过它 —— 跑久了它会是整个库里最大的一块，
 * 而这台机器只有一个 SQLite 文件在扛。
 *
 * 启动时清一次，之后每天一次。AUDIT_LOG_KEEP_DAYS=0 就完全不清。
 */
function pruneAuditLog() {
  if (!config.AUDIT_LOG_KEEP_DAYS) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - config.AUDIT_LOG_KEEP_DAYS * 86400;
  try {
    const db = require('./db');
    const n = db.prepare(`DELETE FROM public_audit_log WHERE created_at < ?`).run(cutoff).changes;
    if (n) console.log(`[moments] 清掉 ${n} 条过期审核日志（保留 ${config.AUDIT_LOG_KEEP_DAYS} 天）`);
    return n;
  } catch (e) {
    console.error('[moments] 清理审核日志失败:', e.message);
    return 0;
  }
}

// 测试会 require 这个文件来拿 app，那种情况下不该真去监听端口。
if (require.main === module) {
  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(
      `[moments] phase=${config.PHASE} node=${config.SELF_NODE_ID} listening :${config.PORT}`
    );
    console.log(`[moments] SELF_SERVER_URL=${config.SELF_SERVER_URL}`);
    if (!config.SELF_SERVER_URL.startsWith('https://')) {
      console.log(
        '[moments] ⚠ 当前不是 HTTPS：ADMIN_TOKEN 和动态正文都是明文过网，见 SECURITY.md'
      );
    }
    pruneAuditLog();
    setInterval(pruneAuditLog, 24 * 3600 * 1000).unref();
  });
}

module.exports = app;
