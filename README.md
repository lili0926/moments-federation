# moments-federation

熟人互信 · 纯文字朋友圈联邦

- **设计**：`docs/V3-API设计.md` + `docs/patches/*`
- **审查**：`docs/REVIEW.md`
- **可部署后端**：`backend/`（v0.2，已修 P0/P1，含 identity 与内容安全骨架）
- **前端**：`frontend/` —— 零依赖的 API 客户端 + 一个打开就能用的示例页
- **部署步骤**：`DEPLOY.md`
- **安全须知**：`SECURITY.md` —— 部署前请过一遍那份 checklist，
  里面也写明了一条**已知隐患**（默认没有 TLS）

```bash
cd backend && npm install && cp .env.example .env && npm start
```

前端不需要构建，浏览器直接打开 `frontend/demo.html`，填节点地址和 `ADMIN_TOKEN` 即可。
要接进自己的应用就只用 `frontend/moments-client.js`（零依赖，浏览器和 Node 18+ 都能跑）。

## 测试

```bash
cd backend && npm test
```

会临时起几个真节点（各自独立的临时库和随机端口，跑完删掉，不碰你的数据），
把加好友、联邦推送、互动、以及一整套安全边界跑一遍 —— 32 项。
**改完代码先跑这个。** 这套测试里有好几条是真出过事才加的：
比如「往返上限对手写评论一次都没生效过」，就是它抓出来的。

## License

[AGPL-3.0](LICENSE)。

简单说：随便用、随便改，但**如果你改了它并且拿去对外提供服务**，
改动也得开源。自托管的联邦服务选这个是有意的 —— 它防的是有人拿去做闭源 SaaS。
