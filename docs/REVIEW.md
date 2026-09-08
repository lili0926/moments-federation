# 审查纪要（V3 设计 + moments-backend 代码 + 两份补丁）

审查范围：
- `docs/V3-API设计.md`
- `docs/patches/content-safety.md`
- `docs/patches/identity-node.md`
- `backend/`（`moments-backend.zip` 解压内容）

总体结论：**可落地的熟人联邦 MVP**。信任模型、暴露面、纯文字先行、Push+Pull、软删除、HMAC 防重放方向正确；代码与 V3 主体对齐。identity / 内容安全两份补丁尚未写入 zip，需按增量补进。

---

## 1. 设计层评价（V3）

### 做得好的
| 点 | 说明 |
|---|---|
| private / public 硬隔离 | 永不外推 vs 主动广播，和前端双 Tab 对齐 |
| 纯文字 MVP | 避开带宽、真实 IP、图床，一期正确 |
| 预共享密钥 + 双向确认 | 熟人圈足够，不上复杂 PKI |
| Push + Pull | 离线不丢消息 |
| 只软删除 | 避免「删了又被重放复活」 |
| HMAC + 时间窗 | 防重放到位 |
| 握手 token 高熵/一次性/短有效期 | 补丁②合理 |
| 加好友限流 | 补丁⑤合理 |
| `/internal/*` 绑 127.0.0.1 | 和聊天同机打通时必须遵守 |
| AI 发 public 要人工确认 | 第 6 节正确 |

### 仍建议补强（文档层）
1. **`moment_id` 全局唯一**：强制节点前缀，如 `{node_id}_{nanoid}`，避免双节点都生成 `m_1`。
2. **赞评传播范围**：建议赞/评只打到**动态作者节点**，其它人靠 pull 作者侧聚合，避免全网刷评论。
3. **`public_feed_cache` 与 `moments` 删除语义统一**：作者删自己的 public 时，本地 `moments.is_deleted=1` + 向好友广播 tombstone；好友侧只改 cache。
4. **sync 返回字段**：建议带上 `author_name` / `author_server`，方便对端直接 upsert cache，少一次反查。

---

## 2. 代码层评价（backend/）

### 已对齐 V3 的部分
- 表：`moments`、`friends`、`public_feed_cache`、`moment_interactions`、`interaction_state`（往返计数）
- HMAC + 时间戳中间件（`middleware/auth.js`）
- PHASE 分阶段开放公网路由（`app.js`）
- 发布 / receive / sync / feed / action
- 加好友 request / review / accept-callback + 备注
- `replyControl`：`checkExchangeCap` + `resolveReplyMode`（防刷核心）
- 加好友内存限流（`rateLimit.js`）
- nginx 白名单示例

### 代码缺口 / 风险（建议修）

| 优先级 | 问题 | 建议 |
|---|---|---|
| P0 | `action=delete` 只 `UPDATE public_feed_cache`，**不更新本地 `moments`** | 若 `target` 是自己发的：改 `moments.is_deleted` 并 `broadcastTombstone`；若是好友的：改 cache |
| P0 | 作者删帖后未向好友广播 tombstone | `federation.js` 增加 `broadcastAction({action_type:'delete',...})`，publish 的 delete 路径调用 |
| P1 | `receive` 用 `INSERT OR IGNORE`，已存在且被墓碑后**无法再次更新** | 改为 upsert：存在则更新 content/`is_deleted` |
| P1 | `sync` 结果缺 `author_name` / `author_server` | SELECT 时拼上本节点展示信息，或固定由请求方已知 |
| P2 | `recordExchange` 的参与方顺序若不稳定，往返计数可能裂成两条 | 统一 `low/high = sort(id1,id2)`（若尚未排序请补） |
| P2 | 限流器纯内存，进程重启清零 | PHASE3 可换 Redis/SQLite，MVP 可接受 |
| P2 | `nanoid` 无节点前缀 | publish 时 `id = SELF_NODE_ID + '_' + nanoid()` |

### 与两份补丁的差距
- **identity-node**：`local_identities` / `friend_identities`、`identity_id` 字段、`reply_mode` 下沉到 identity、好友列表按 node 分组——**均未进 zip**，需按补丁增量改。
- **content-safety**：`blocked_keywords`、`public_audit_log`、`/internal/moderate-content`、FLAGGED 降级为只赞——**均未进 zip**，建议在 `should-comment` 与真正 `action=comment` 之间插入。

---

## 3. 内容安全补丁评价

四层（Prompt → 关键词 → 二次审查 → 审计+撤回）结构清晰。重点抓「自动评论」而不是「人工确认后的主动发帖」——优先级正确。

注意：
- 二次审查也是模型判断，不能当法律级过滤；敏感好友圈应用 `like_only`。
- `FLAGGED → 只点赞` 比直接报错体验好，保持这一降级策略。
- 审计日志务必只存本机，不要同步给好友。

---

## 4. Identity 补丁评价

node / identity 拆分是正确进化：一台 VPS 上「人 + AI」共用联邦关系，但展示与 `reply_mode` 按身份区分。

强建议默认值写进实现：
- 对方 `type=human` → `llm_decide`
- 对方 `type=ai` → `like_only`（防机机互刷）

往返计数 key 必须是 **identity↔identity**，不能只按 node。

---

## 5. 推荐落地顺序（与现有 Beilyes 前端对齐）

1. **PHASE=1**：本机 private/public 可发可看；前端发动态带 `scope`；公共 Tab 显示自己的 public。
2. 补 P0 删除语义 + moment_id 前缀。
3. **PHASE=2**：双节点 + Cloudflare 只放行 receive/sync；手动 friends 行联调 Push/Pull。
4. 合入 identity 补丁（表 + 握手 identities + reply_mode 下沉）。
5. 合入 content-safety（自动评论链路）。
6. **PHASE=3**：自动握手、限流持久化、墓碑全链路，再谈 R2 图片。

---

## 6. 与 Beilyes 前端现状

已有：
- 朋友圈微信风 UI、公共/私人 Tab
- 私人动态本地发布/赞/评/删
- 公共 Tab 占位
- 封面可换且落私有目录

待接：
- 动态 `scope` 字段与发布选择
- `GET /api/moments/feed?scope=`
- AI `/internal/post-from-chat`（默认 private）
- 公共 Tab 读本地 public + 日后 cache
