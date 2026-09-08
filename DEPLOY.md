# 部署说明（给 Claude Code）

## 一键本地

```bash
cd backend
npm install
cp .env.example .env
# 必改：SELF_NODE_ID、SELF_SERVER_URL、显示名与人/AI 身份
npm start
curl http://127.0.0.1:3000/health
```

## 验证 PHASE=1

```bash
# 发私人
curl -s -X POST http://127.0.0.1:3000/api/moments/publish \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello private","scope":"private"}'

# 发公共（本机）
curl -s -X POST http://127.0.0.1:3000/api/moments/publish \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello public","scope":"public","identity_id":"alice_human"}'

curl -s 'http://127.0.0.1:3000/api/moments/feed?scope=private'
curl -s 'http://127.0.0.1:3000/api/moments/feed?scope=public'
```

注意：`localhostOnly` 中间件要求请求来自 127.0.0.1。若经 docker 桥接失败，可临时从宿主机 curl 或改中间件。

## 生产

1. systemd 或 pm2 跑 `npm start`
2. Cloudflare / nginx 只反代白名单路径（`nginx.conf.example`）
3. PHASE=2 后再加真实好友联调
4. `/internal/*` 禁止出现在公网 server block

## 已相对初版修复/补齐

- moment_id 带节点前缀
- 删除：本地 soft delete + 广播 tombstone
- receive upsert
- sync 带 author 元数据与 is_deleted
- local_identities / friend_identities
- reply_mode 默认 human=llm_decide / ai=like_only
- 内容关键词审查 + audit log
- 握手 token 表与一次性/过期
