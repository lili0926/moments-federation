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

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(
    `[moments] phase=${config.PHASE} node=${config.SELF_NODE_ID} listening :${config.PORT}`
  );
  console.log(`[moments] SELF_SERVER_URL=${config.SELF_SERVER_URL}`);
});
