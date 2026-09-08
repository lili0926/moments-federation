# 朋友圈联邦 API 与架构设计（熟人互信·纯文字 MVP 版）V3

> 在 V2（与 Gemini 商定）基础上打了 5 个补丁：重放攻击防护、握手 token 强度、点赞/评论建表、软删除铁律、加好友限流。

---

## 1. 核心架构认知与整体思路

### 1.1 前后端关注点分离
- "做不做独立 App" 与 "做不做联邦" 完全解耦：
  - **后端（联邦层）**：定义独立节点间（你的 VPS 与好友的 VPS）如何通过标准化协议互相发请求同步数据。
  - **前端（展示层）**：朋友圈作为现有聊天 Web/App 里的一个新 Tab，调用同一台 VPS 上的内部 API。用户体感上就是"聊天软件里自带的朋友圈"，不用单独打包维护两套前端。

### 1.2 节点定位与信任模型
- 每个人/AI 的后端都跑在自己的 VPS/服务器上，独立自托管。
- 不做中心化注册、不做陌生人广场，好友关系靠**双向手动确认 + 预共享密钥（Pre-Shared Secret）**，不上非对称公钥体系。
- 数据隔离基石（Scope）：
  - `private`：仅存本地，永不推送。用于双人日常、聊天提炼记录。
  - `public`：存本地并主动向已认证好友节点推送。

### 1.3 MVP 阶段核心策略：纯文字先行
- 第一阶段砍掉图片/视频，只处理 UTF-8 纯文本 + 基础互动。
- 收益：避开个人 VPS 低上行带宽瓶颈；**杜绝好友直连图片请求导致 VPS 真实 IP 泄露**；削减初期工程复杂度。

---

## 2. 风险评估与应对方案

| 风险 / 摩擦点 | 现象描述 | 解决方案 |
|---|---|---|
| 公网暴露面扩大 | 需开放外网端口接收好友动态，可能暴露私聊核心接口 | 反向代理路由物理隔离：外网网关只放行 `/api/friends/*`、`/api/moments/receive`、`/api/moments/sync`；私密接口严格监听 127.0.0.1 |
| 代码手滑导致越权 | 漏加 `WHERE scope='public'`，私人内容外泄 | 拆分独立方法 `get_private_feed()` / `get_public_feed()`；广播前置拦截器强制校验 `scope=='public'`，否则抛异常 |
| 节点离线导致丢消息 | 纯 Push 模式下好友服务器宕机，推送永久丢失 | Push + Pull 混合：平时主动 Push；上线/刷新时 `GET /api/moments/sync?since={timestamp}` 增量拉取补齐 |
| 带宽与 IP 穿透 | 图片直接走 VPS 本地会占满带宽、暴露真实 IP | MVP 阶段禁止图片附件；后续扩展强制接入 Cloudflare R2 等外部图床，严禁本地伺服大图 |
| 无公网 IP 连通难 | 好友节点在家庭 NAS/内网，外界连不通 | Cloudflare Tunnel（推荐零配置）或 FRP 穿透；极小圈子可直接用 Tailscale 组网 |
| 动态撤回不同步 | 本地删了/改了动态，对方缓存里仍残留 | Tombstone 同步：广播 `action:"delete"`，对方收到后标记删除，**只软删除，永不物理删除**（见补丁④） |
| **重放攻击**（补丁①） | 静态密钥+无时间戳，请求被截获后可重放 | 推送/action 请求全部加时间戳 + HMAC 签名（用 shared_secret 对 body 做签名），接收端校验签名 + 时间戳新鲜度（如 5 分钟窗口），过期或签名不符直接拒绝 |
| **握手 token 被冒充**（补丁②） | `tmp_code_xyz` 强度不够或长期有效，第三方可能截获后冒充回调偷密钥 | token 必须高熵随机（32 字节以上，加密安全随机数生成器）；**一次性使用，用完立即失效**；设置较短有效期（如 10 分钟） |
| **点赞/评论无落地表**（补丁③） | 第 6 节支持 `like`/`comment`，但建表环节遗漏，落地会直接报错 | 见第 4 节新增 `moment_interactions` 表 |
| **删除策略不清晰**（补丁④） | 若允许物理删除，配合网络重放可能出现"删了又复活"的诡异状态 | 铁律：**任何情况下只软删除**（`is_deleted=TRUE`），墓碑同步只改状态位，不做物理 DELETE |
| **加好友请求无限流**（补丁⑤） | 公网端点 `/api/friends/request` 任何人可无限调用刷请求 | 按来源 IP/server_url 限流（如每小时最多 N 次），超限直接 429，防刷防骚扰 |

---

## 3. 网络拓扑与连通方案

1. **方案 A（最稳健）**：独立二级域名 + Cloudflare 边缘代理（有公网 VPS 推荐）——Cloudflare 小黄云隐藏真实 IP，免费 SSL，防扫描
2. **方案 B（无公网 IP）**：Cloudflare Tunnel / FRP 穿透（家庭 NAS/本地机推荐）——`cloudflared` 只穿透接收端口，免去端口映射
3. **方案 C（双私密高安）**：Tailscale 虚拟私有网——各节点走内网 IP（100.x.x.x）通信，VPS 对外端口完全关闭，安全性最高

---

## 4. 数据结构设计（纯文字精简版 + 补丁③新增互动表）

```sql
-- 本地动态表
CREATE TABLE moments (
  id VARCHAR(64) PRIMARY KEY,
  author_id VARCHAR(64) NOT NULL,
  content TEXT NOT NULL,
  scope VARCHAR(16) NOT NULL,      -- 'private' 或 'public'
  created_at BIGINT NOT NULL,
  is_deleted BOOLEAN DEFAULT FALSE -- 铁律：只软删除，见补丁④
);

-- 好友节点表
CREATE TABLE friends (
  friend_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(64) NOT NULL,
  server_url VARCHAR(255) NOT NULL,
  shared_secret VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,     -- 'pending' 或 'accepted'
  created_at BIGINT NOT NULL
);

-- 外部公共动态缓存表
CREATE TABLE public_feed_cache (
  moment_id VARCHAR(64) PRIMARY KEY,
  author_id VARCHAR(64) NOT NULL,
  author_name VARCHAR(64) NOT NULL,
  author_server VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  is_deleted BOOLEAN DEFAULT FALSE -- 收到墓碑广播时更新此字段，不物理删除
);

-- 【补丁③新增】点赞/评论互动表
CREATE TABLE moment_interactions (
  id VARCHAR(64) PRIMARY KEY,
  target_moment_id VARCHAR(64) NOT NULL,  -- 关联的动态ID（本地moments或public_feed_cache）
  operator_id VARCHAR(64) NOT NULL,       -- 点赞/评论的人是谁
  operator_name VARCHAR(64) NOT NULL,
  action_type VARCHAR(16) NOT NULL,       -- 'like' 或 'comment'
  content TEXT,                           -- comment时填内容，like时为空
  created_at BIGINT NOT NULL,
  is_deleted BOOLEAN DEFAULT FALSE        -- 取消点赞/删评论同样软删除
);
```

---

## 5. 详细接口设计

### 5.1 节点握手与加好友流程

**步骤一：发送好友申请**（公网开放）
`POST /api/friends/request`
```json
{ "from_id": "alice_node", "from_name": "Alice", "from_server": "https://moments.alice.org", "verify_token": "tmp_code_xyz", "message": "加个好友~" }
```
> 补丁⑤：此端点按来源 server_url/IP 限流，防止无限刷请求

**步骤二：管理员手动审批**（内网专用）
`POST /api/internal/friends/review`
```json
{ "request_id": "req_123", "action": "accept" }
```
底层生成 `shared_secret` 存入本地库，向发起方回调。

**步骤三：回调确认互信**（公网开放）
`POST /api/friends/accept-callback`
Header 携带 `X-Handshake-Token: tmp_code_xyz`（补丁②：32字节以上高熵随机、一次性、10分钟有效期），Payload 含接收方 `shared_secret`，校验通过后双向认证正式建立。

### 5.2 鉴权机制（补丁①：加入签名与时间戳）

```
POST /api/moments/receive HTTP/1.1
Host: moments.alice.org
X-Sender-ID: friend_01
X-Timestamp: 1724851200
X-Signature: HMAC-SHA256(shared_secret, body + timestamp)
Content-Type: application/json
```
接收端中间件：
1. 按 `X-Sender-ID` 查 `friends` 表取出对应 `shared_secret`
2. 用同样算法重算签名，比对 `X-Signature`，不符返回 401
3. 校验 `X-Timestamp` 与当前时间差是否在窗口内（如 5 分钟），超时拒绝——防重放核心

### 5.3 纯文字动态发布与广播

**发动态**（前端调用，仅限内网/本地认证）
`POST /api/moments/publish`
```json
{ "content": "今天和 XiaoA 聊了聊关于未来的计划。", "scope": "public" }
```
逻辑：写入本地 `moments` 表；若 `scope=public`，抛入后台异步任务，向已接受好友节点广播（带签名+时间戳）。

**接收动态**（公网开放，鉴权保护）
`POST /api/moments/receive`
```json
{ "moment_id": "m_9981", "author_id": "friend_01", "author_name": "小明", "author_server": "https://xm.net", "content": "刚刚部署好了新节点！", "created_at": 1724851200 }
```
写入 `public_feed_cache`。

### 5.4 离线补偿：增量同步接口（Pull 机制）

`GET /api/moments/sync?since={timestamp}`（公网开放，Header 鉴权）

节点重新上线或用户下拉刷新时，向好友服务器拉取该时间戳之后**未标记删除**的 public 动态列表，更新本地 `public_feed_cache`。

### 5.5 朋友圈拉取接口（前端专用）

- `GET /api/moments/feed?scope=public`：联合查询本地 public 动态 + `public_feed_cache`（过滤 `is_deleted=FALSE`），按时间倒序合并
- `GET /api/moments/feed?scope=private`：严格只查本地 `moments` 中 `scope='private'` 且未删除的记录，物理隔绝任何外部数据

### 5.6 互动与动态撤回（补丁③④：落表 + 软删除铁律）

`POST /api/moments/action`（公网开放，Header 鉴权，签名+时间戳同 5.2）
```json
{ "target_moment_id": "m_9981", "operator_id": "alice_node", "operator_name": "Alice", "action_type": "delete", "content": null }
```
- `action_type=like`/`comment`：写入 `moment_interactions` 表
- `action_type=delete`：**只更新 `is_deleted=TRUE`，绝不物理 DELETE**（对方收到后同样只改状态位）

---

## 6. 与聊天后端打通的内网安全接口

Moments 服务与聊天后端同机部署。聊天服务为 AI 挂载内部专属 Tool，实现"AI 主动发圈"。

- 专用内部接口：`POST /internal/post-from-chat`
- **物理隔离铁律**：强制绑定 `127.0.0.1`，反向代理禁止将 `/internal/` 路由映射至外网
- **默认锁定 private**：参数未显式提供 `scope` 时，一律强制回退为 `private`。AI 默认只能发双人私密朋友圈；发公共动态必须在前端弹出确认卡片，人工确认后才调用

---

## 7. 实施路线规划（三阶段落地法）

1. **第一阶段：纯文字本地双 Scope 闭环**（单机阶段）
   不开放公网端口，仅本机建表；完成聊天端与 `/internal/post-from-chat` 联动；验证 private/public 本地浏览体验
2. **第二阶段：点对点联邦联调与增量同步**（双节点联调）
   配置网关白名单，只开放 `/api/moments/receive` 和 `/api/moments/sync`；双方手动写入 `friends` 测试数据；跑通 Push 广播 + 离线 Pull 补齐 + 签名校验
3. **第三阶段：自动化握手、撤回同步与未来演进**
   补齐加好友自动化请求/审批流程、限流、墓碑撤回广播；纯文字版本稳定后再评估图片附件（Cloudflare R2）扩展

---

## 附：V3 相对 V2 的 5 处补丁一览

| 编号 | 补丁内容 | 对应章节 |
|---|---|---|
| ① | 推送/action 请求加时间戳+HMAC签名，防重放攻击 | 2、5.2、5.6 |
| ② | 握手 token 强制高熵随机、一次性、限时效 | 2、5.1 |
| ③ | 补齐 `moment_interactions` 点赞评论表 | 2、4 |
| ④ | 明确"只软删除，永不物理删除"铁律 | 2、4、5.6 |
| ⑤ | `/api/friends/request` 按来源限流 | 2、5.1 |
