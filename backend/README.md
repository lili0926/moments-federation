# 朋友圈联邦后端（Node.js + Express + SQLite）

对应设计文档 V3。三阶段代码都在这一份仓库里，用环境变量 `PHASE` 控制开放到哪一步，
交给 Claude Code 时可以直接说"把 PHASE=1 跑起来，验证完再开 PHASE=2"。

## 快速开始

```bash
npm install
cp .env.example .env   # 改一下 PHASE、PORT、SELF_SERVER_URL
npm run dev
```

## 阶段说明

- **PHASE=1（单机闭环）**：只启动内网路由（发布/拉取/内部聊天接口），
  `/api/friends/*`、`/api/moments/receive`、`/api/moments/sync` 这些对外接口**不监听公网**，
  用来先跑通"私人/公共两个scope本地都能发能看"。
- **PHASE=2（双节点联调）**：打开对外路由，允许真实好友请求/推送/增量同步，
  但握手审批还是手动调 `/api/internal/friends/review`。
- **PHASE=3（自动化+防刷屏）**：加好友限流、reply_mode好友策略、备注功能全部生效。

## 目录结构

```
src/
  db.js                  数据库初始化（建表，含V3全部表+备注字段+互动计数表）
  config.js               环境变量读取
  middleware/auth.js       HMAC签名+时间戳校验（防重放）
  routes/friends.js        加好友全流程 + 备注接口
  routes/moments.js        发布/接收/拉取/同步/点赞评论/删除
  routes/internal.js       只允许127.0.0.1访问的内部接口（聊天打通、审批）
  services/federation.js   向好友节点推送的逻辑
  services/replyControl.js 防无限刷评论的核心逻辑（重点看这个文件）
  services/rateLimit.js    简单的内存限流器
  app.js                   组装所有路由，做公网/内网路由隔离
```

## 关于"防止AI无限刷评论"（重点）

看 `src/services/replyControl.js`，核心是两道闸：

1. `checkExchangeCap()`：硬性上限，某条动态里两人之间的往返次数到了阈值，
   直接返回 `allowed:false`，不管上层AI多想回复——这道闸不依赖AI的判断力。
2. `resolveReplyMode()`：读好友的 `reply_mode` 设置（`like_only` / `llm_decide` / `always_comment`），
   `like_only` 时压根不会走到"要不要评论"这一步的AI调用，直接自动点赞收工。

聊天后端调用 `/internal/should-comment` 这个接口，会依次过这两道闸，
只有都放行了才轮到你自己的AI逻辑去决定说什么。
