# moments-federation

熟人互信 · 纯文字朋友圈联邦

- **设计**：`docs/V3-API设计.md` + `docs/patches/*`
- **审查**：`docs/REVIEW.md`
- **可部署后端**：`backend/`（v0.2，已修 P0/P1，含 identity 与内容安全骨架）
- **前端**：`frontend/` —— 零依赖的 API 客户端 + 一个打开就能用的示例页
- **部署步骤**：`DEPLOY.md`

```bash
cd backend && npm install && cp .env.example .env && npm start
```

前端不需要构建，浏览器直接打开 `frontend/demo.html`，填节点地址和 `ADMIN_TOKEN` 即可。
要接进自己的应用就只用 `frontend/moments-client.js`（零依赖，浏览器和 Node 18+ 都能跑）。
