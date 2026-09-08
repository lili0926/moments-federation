# moments-federation backend

熟人互信 · 纯文字朋友圈联邦后端（可部署版 v0.2）

## Claude Code / 部署快速指令

```bash
cd backend
npm install
cp .env.example .env
# 编辑 .env：SELF_NODE_ID / SELF_SERVER_URL / SELF_HUMAN_* / SELF_AI_* / PHASE
npm start
# 健康检查
curl -s http://127.0.0.1:3000/health
```

PHASE=1 时只在本机用；公网用 nginx 白名单（见 `nginx.conf.example`），**不要**把 `/internal` 和 `/api/moments/publish` 暴露出去。

## 主要 API

| 方法 | 路径 | 访问 | 说明 |
|------|------|------|------|
| POST | `/api/moments/publish` | 仅本机 | 发动态 `{content, scope, identity_id}` |
| GET | `/api/moments/feed?scope=` | 仅本机 | private / public 信息流 |
| POST | `/api/moments/delete` | 仅本机 | 软删并广播墓碑 |
| POST | `/api/moments/receive` | 联邦鉴权 | 收好友动态 |
| GET | `/api/moments/sync?since=` | 联邦鉴权 | 增量拉取 |
| POST | `/api/moments/action` | 联邦鉴权 | like/comment/delete |
| POST | `/api/friends/request` | 公网 | 加好友申请 |
| POST | `/internal/friends/review` | 仅本机 | 审批通过并回调 |
| GET | `/api/friends` | 仅本机 | 好友列表（node+identities） |
| POST | `/internal/post-from-chat` | 仅本机 | AI 发圈，默认 private |
| POST | `/internal/should-comment` | 仅本机 | 防刷闸 |
| POST | `/internal/moderate-content` | 仅本机 | 关键词/审计 |

## 设计文档

见仓库根目录 `docs/`。
