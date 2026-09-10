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

## 前端加好友通道 `/api/admin/*`

在这条通道出现之前，加好友只做了「被动接收」那一半：能收申请、能审批（但绑 127.0.0.1），
**没有任何代码能主动向别人发起申请**。所以每加一个好友都得 SSH 上 VPS 手敲 curl。
现在前端（手机 App / 浏览器）带 `X-Admin-Token` 就能全程操作。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/me` | 本节点信息 + **我的邀请码**（`MF1:` 开头，发给对方） |
| POST | `/api/admin/invite/parse` | 解析对方邀请码，做「确认要加 TA 吗」的预览 |
| POST | `/api/admin/friends/invite` | **发起申请**：`{code}` 或 `{target_server}`，可带 `message` |
| GET | `/api/admin/friends/requests` | 待办：`incoming`（等我审）+ `outgoing`（我发出的） |
| POST | `/api/admin/friends/review` | `{request_token, action:'accept'\|'reject'}` |
| GET | `/api/admin/friends` | 好友列表（含各身份的备注与 reply_mode） |
| POST | `/api/admin/friends/:node/:identity/remark` | 设备注 |
| POST | `/api/admin/friends/:node/:identity/reply-mode` | `like_only`/`llm_decide`/`always_comment` |

配置（`.env`）：

```bash
ADMIN_TOKEN=$(openssl rand -hex 32)    # 留空则整条通道 503
ADMIN_CORS_ORIGINS=https://前端域名     # 逗号分隔
```

两个人加好友的完整过程，两边都只在 App 里点：

```
A: GET /api/admin/me → 拿到 MF1:xxxx → 微信发给 B
B: POST /api/admin/friends/invite {"code":"MF1:xxxx"}
A: GET /api/admin/friends/requests → incoming 里出现 B
A: POST /api/admin/friends/review {"request_token":"...","action":"accept"}
   → 双方 shared_secret 建立，联邦即刻可用
```

**`ADMIN_TOKEN` 等价于账号密码**：必须走 HTTPS，不要进 git。
nginx 侧不要给这条 location 加 `Access-Control-Allow-Origin` —— Node 已加一份，
两份会让浏览器直接判 CORS 失败（而且请求其实已在服务端跑完，表现是「日志全 200 但前端说连不上」）。

## 设计文档

见仓库根目录 `docs/`。
