const express = require('express');
const config = require('./config');
require('./db'); // init schema

const momentsRouter = require('./routes/moments');
const friendsRouter = require('./routes/friends');
const internalRouter = require('./routes/internal');

const app = express();

// 保留 rawBody 供 HMAC 验签
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString('utf8') : '';
    },
  })
);
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

// PHASE>=2 才“逻辑上启用联邦”；实际公网暴露靠 nginx 白名单
// PHASE=1 时仍可本机调 receive/sync 做单测，但文档约定不开放公网
if (config.PHASE < 2) {
  console.log('[moments] PHASE=1：请勿将 /api/moments/receive|sync 与 /api/friends/* 暴露公网');
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
