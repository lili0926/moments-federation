/**
 * 测试用的小工具：起一个真节点、打它、收摊。
 *
 * 为什么起真进程而不是 mock：这套东西的安全边界几乎全在
 * 「HTTP 头 + 中间件 + SQL」的交界上（签名校验、direction、ON CONFLICT 的副作用）。
 * mock 掉任何一层，测的就不是真正会跑的那条路 —— 这轮查出来的 7 个洞，
 * 全都是在那些交界处。
 *
 * 每个节点一份独立的临时库，跑完删掉，不碰你的真数据。
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app.js');

function randomPort() {
  // `node --test` 每个测试文件一个进程，各进程之间不知道对方占了哪些端口，
  // 所以别用「基数 + 递增」那种看起来整齐的分配 —— 会撞。随机取，撞了就换。
  return 20000 + Math.floor(Math.random() * 25000);
}

/**
 * 起一个节点。返回 { port, baseUrl, nodeId, adminToken, dbPath, stop() }
 * 端口被占就自动换一个重来（最多 6 次）。
 */
async function startNode(opts = {}) {
  if (opts.port) return startOnPort(opts, opts.port);
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      return await startOnPort(opts, randomPort());
    } catch (e) {
      lastErr = e;
      if (!/EADDRINUSE|没起来/.test(String(e.message))) throw e;
    }
  }
  throw lastErr;
}

async function startOnPort(opts, port) {
  const nodeId = opts.nodeId || `test_node_${port}`;
  const adminToken = opts.adminToken || crypto.randomBytes(16).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-test-'));
  const dbPath = path.join(dir, 'moments.db');
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = Object.assign({}, process.env, {
    PHASE: '2',
    PORT: String(port),
    DB_PATH: dbPath,
    SELF_SERVER_URL: baseUrl,
    SELF_NODE_ID: nodeId,
    SELF_DISPLAY_NAME: opts.displayName || `节点 ${nodeId}`,
    SELF_HUMAN_ID: `${nodeId}_human`,
    SELF_HUMAN_NAME: opts.humanName || '某人',
    SELF_AI_ID: `${nodeId}_ai`,
    SELF_AI_NAME: opts.aiName || '某AI',
    ADMIN_TOKEN: adminToken,
    ADMIN_CORS_ORIGINS: '*',
    // 测试节点都在 127.0.0.1 上，不放开就互相加不了
    ALLOW_PRIVATE_PEERS: '1',
    // 限流：默认值太小，一个测试文件里打几十次就被自己限住了
    FRIEND_REQUEST_RATE_LIMIT: opts.friendRateLimit || '1000',
    FRIEND_REQUEST_GLOBAL_LIMIT: opts.friendGlobalLimit || '5000',
    ADMIN_RATE_LIMIT: '5000',
    AUDIT_LOG_KEEP_DAYS: '90',
  });
  if (opts.env) Object.assign(env, opts.env);

  const proc = spawn(process.execPath, [APP], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  // 等它真的能应答，别用固定 sleep —— 慢机器上会假失败
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(800) });
      if (r.ok) { up = true; break; }
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!up) {
    try { proc.kill('SIGKILL'); } catch (e) {}
    throw new Error(`节点没起来（:${port}）\n${logs.join('')}`);
  }

  return {
    port, baseUrl, nodeId, adminToken, dbPath, proc, logs,
    stop() {
      try { proc.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    },
    /** 打这个节点的 admin 口 */
    async admin(p, opts2 = {}) {
      const r = await fetch(baseUrl + p, {
        method: opts2.method || 'GET',
        headers: Object.assign(
          { 'X-Admin-Token': opts2.token === undefined ? adminToken : opts2.token },
          opts2.body ? { 'Content-Type': 'application/json' } : {}
        ),
        body: opts2.body ? JSON.stringify(opts2.body) : undefined,
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, body: j };
    },
    /** 不带凭据打公网口 */
    async pub(p, body, headers = {}) {
      const r = await fetch(baseUrl + p, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, body: j };
    },
    /** 带 HMAC 签名打联邦口（模拟一个已经加上的好友） */
    async signed(p, body, secret, senderId, tweak = {}) {
      const s = JSON.stringify(body);
      const ts = tweak.ts || Math.floor(Date.now() / 1000);
      const sig = tweak.sig || crypto.createHmac('sha256', secret).update(ts + '.' + s).digest('hex');
      const r = await fetch(baseUrl + p, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sender-ID': senderId,
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body: s,
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, body: j };
    },
    /** 直接读这个节点的库（断言用，比翻接口快也更准） */
    db() {
      const Database = require('better-sqlite3');
      return new Database(dbPath, { readonly: true });
    },
  };
}

/** 让两个节点互相成为好友，返回双方的 shared_secret */
async function makeFriends(a, b) {
  const me = await a.admin('/api/admin/me');
  const code = me.body.invite_code;
  // b 用 a 的邀请码发起申请
  const inv = await b.admin('/api/admin/friends/invite', { method: 'POST', body: { code } });
  if (inv.status !== 200) throw new Error('invite 失败: ' + JSON.stringify(inv));
  // a 那边应该看到一条待审
  const reqs = await a.admin('/api/admin/friends/requests');
  const incoming = (reqs.body && reqs.body.incoming) || [];
  const it = incoming.find((r) => r.node_id === b.nodeId);
  if (!it) throw new Error('a 没收到待审申请: ' + JSON.stringify(reqs.body));
  const rev = await a.admin('/api/admin/friends/review', {
    method: 'POST', body: { request_token: it.request_token, action: 'accept' },
  });
  if (rev.status !== 200) throw new Error('review 失败: ' + JSON.stringify(rev));

  const da = a.db();
  const secretAtoB = da.prepare('SELECT shared_secret FROM friends WHERE friend_id=?').get(b.nodeId);
  da.close();
  const dbb = b.db();
  const secretBtoA = dbb.prepare('SELECT shared_secret FROM friends WHERE friend_id=?').get(a.nodeId);
  dbb.close();
  if (!secretAtoB || !secretBtoA) throw new Error('握手完了但库里没有 secret');
  return { aSecret: secretAtoB.shared_secret, bSecret: secretBtoA.shared_secret };
}

module.exports = { startNode, makeFriends };
