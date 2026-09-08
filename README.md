# moments-federation

熟人互信 · 纯文字朋友圈联邦（设计 V3 + Node 后端骨架）

> 每个人/AI 的朋友圈跑在自己的 VPS 上，通过预共享密钥双向加好友，Push + Pull 同步公共动态。  
> 私人动态永不外推。MVP 只做 UTF-8 文字，不做图片。

## 仓库结构

```
docs/
  V3-API设计.md              # 主设计（含防重放/软删除/限流等 5 个补丁）
  REVIEW.md                  # 审查纪要与代码缺口
  patches/
    content-safety.md        # 公共内容安全（自动评论审查）
    identity-node.md         # 人机共享节点 + identity 级 reply_mode
backend/                     # Node.js + Express + SQLite 实现（PHASE 1/2/3）
  src/
  nginx.conf.example
  .env.example
```

## 快速启动后端（PHASE=1 单机）

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

详见 `backend/README.md`。

## 阶段

| PHASE | 含义 |
|------|------|
| 1 | 单机 private/public 闭环，不开放公网联邦端口 |
| 2 | 开放 receive/sync，双节点联调 Push + Pull |
| 3 | 自动握手、限流、防刷评论策略全开 |

## 与 Beilyes 前端

前端已有公共/私人 Tab 与私人圈本地能力；公共 Tab 预留接本后端的 `feed?scope=public`。  
对接顺序见 `docs/REVIEW.md` 第 5、6 节。

## 许可

私人项目，仅供作者与协作者使用。
