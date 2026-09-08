const express = require('express');
const config = require('./config');
require('./db'); // 确保建表先执行

const friendsRouter = require('./routes/friends');
const momentsRouter = require('./routes/moments');
const internalRouter = require('./routes/internal');

const app = express();
app.use(express.json());

// PHASE 1：只挂内网相关能力，先跑通本地闭环，好友/联邦相关路由不挂载，
// 相当于物理上都还没开放，连误开公网端口的可能性都没有。
if (config.PHASE >= 1) {
  app.use('/internal', internalRouter);
  app.use('/api/moments', momentsRouter); // publish/feed 是内网专用，receive/action有各自的签名校验
}

// PHASE 2+：好友相关的公网接口才挂上（request/accept-callback/receive/sync）
if (config.PHASE >= 2) {
  app.use('/api/friends', friendsRouter);
}

app.get('/healthz', (req, res) => res.json({ ok: true, phase: config.PHASE }));

app.listen(config.PORT, () => {
  console.log(`朋友圈联邦后端启动，PHASE=${config.PHASE}，端口=${config.PORT}`);
  if (config.PHASE === 1) {
    console.log('当前PHASE=1：好友/联邦相关路由未挂载，仅本地闭环可用。');
  }
});
