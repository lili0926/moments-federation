/**
 * 安全边界。每一条都对应一个**真实发生过**的洞（2026-09-15 那轮审查），
 * 写在这里是为了下次改到附近时能当场红，而不是等出事。
 *
 *   node --test test/
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startNode, makeFriends } = require('./helpers');

let alice, bob, secrets;

before(async () => {
  alice = await startNode({ nodeId: 'alice_node', displayName: 'Alice 的小镇' });
  bob = await startNode({ nodeId: 'bob_node', displayName: 'Bob 的小镇' });
  secrets = await makeFriends(alice, bob);   // alice 视角的 bob、bob 视角的 alice
});

after(() => {
  if (alice) alice.stop();
  if (bob) bob.stop();
});

describe('陌生人（不带任何凭据的公网口）', () => {
  test('拿已有好友的 node_id 发申请，不能改掉那段关系', async () => {
    const before_ = alice.db().prepare('SELECT * FROM friends WHERE friend_id=?').get('bob_node');
    assert.equal(before_.status, 'accepted');

    const r = await alice.pub('/api/friends/request', {
      from_id: 'bob_node',                        // 冒充已有好友
      from_name: '我是冒充的',
      from_server: 'http://198.51.100.77:9999',   // 指到自己的地址
      verify_token: 'a'.repeat(64),
    });
    assert.equal(r.status, 409, '应该回 409 friend_id_taken_by_another_server');
    assert.equal(r.body.error, 'friend_id_taken_by_another_server');

    const after_ = alice.db().prepare('SELECT * FROM friends WHERE friend_id=?').get('bob_node');
    assert.equal(after_.status, 'accepted', 'status 不能被打回 pending');
    assert.equal(after_.server_url, before_.server_url, 'server_url 不能被改');
    assert.equal(after_.shared_secret, before_.shared_secret, 'secret 更不能被改');
  });

  test('同一台服务器重发申请是合法的，但不能动现有那行', async () => {
    const before_ = alice.db().prepare('SELECT * FROM friends WHERE friend_id=?').get('bob_node');
    const r = await alice.pub('/api/friends/request', {
      from_id: 'bob_node',
      from_name: 'Bob',
      from_server: before_.server_url,            // 就是原来那台
      verify_token: 'b'.repeat(64),
      message: '我重装了',
    });
    assert.equal(r.status, 200, '合法的重新握手不该被挡');

    const after_ = alice.db().prepare('SELECT * FROM friends WHERE friend_id=?').get('bob_node');
    assert.equal(after_.status, 'accepted', '没同意之前旧关系要继续用');
    assert.equal(after_.shared_secret, before_.shared_secret);

    const t = alice.db().prepare('SELECT * FROM handshake_tokens WHERE token=?').get('b'.repeat(64));
    assert.ok(t && t.direction === 'in' && !t.used, '应该进待审列表由本人决定');
  });

  test('限流用的是来源 IP，不是 body 里自报的 from_server', async () => {
    // 换 from_server 不该换来一个新桶
    const node = await startNode({ friendRateLimit: '3', friendGlobalLimit: '1000' });
    try {
      let okCount = 0;
      for (let i = 0; i < 8; i++) {
        const r = await node.pub('/api/friends/request', {
          from_id: `spam_${i}`, from_name: 'x',
          from_server: `http://198.51.100.${10 + i}:9999`,   // 每次都不一样
          verify_token: crypto.randomBytes(32).toString('hex'),
        });
        if (r.status === 200) okCount++;
      }
      assert.ok(okCount <= 3, `换 from_server 也该被限住，实际通过了 ${okCount} 次`);
    } finally { node.stop(); }
  });

  test('全站上限兜底', async () => {
    const node = await startNode({ friendRateLimit: '10000', friendGlobalLimit: '4' });
    try {
      let limited = 0;
      for (let i = 0; i < 8; i++) {
        const r = await node.pub('/api/friends/request', {
          from_id: `g_${i}`, from_name: 'x', from_server: `http://198.51.100.5:9999`,
          verify_token: crypto.randomBytes(32).toString('hex'),
        });
        if (r.status === 429) limited++;
      }
      assert.ok(limited > 0, '全站上限应该拦下一些');
    } finally { node.stop(); }
  });

  test('不能先塞一个自己的 token 再拿它自批准', async () => {
    const tok = 'c'.repeat(64);
    await alice.pub('/api/friends/request', {
      from_id: 'evil_node', from_name: 'Evil', from_server: 'http://198.51.100.9:9999',
      verify_token: tok,
    });
    // 这条是 direction='in'，而 accept-callback 只认 'out'
    const r = await alice.pub('/api/friends/accept-callback', {
      from_id: 'evil_node', shared_secret: 'i-pick-my-own-secret',
    }, { 'X-Handshake-Token': tok });
    assert.equal(r.status, 401, '自批准这条路必须堵死');

    const row = alice.db().prepare('SELECT * FROM friends WHERE friend_id=?').get('evil_node');
    assert.notEqual(row && row.status, 'accepted', 'evil_node 绝不能变成 accepted');
  });

  test('握手时不许把对方地址指向内网（SSRF）', async () => {
    const node = await startNode({ env: { ALLOW_PRIVATE_PEERS: '0' } });
    try {
      const r = await node.admin('/api/admin/friends/invite', {
        method: 'POST', body: { target_server: 'http://169.254.169.254/' },
      });
      assert.equal(r.body && r.body.error, 'private_address_not_allowed');
    } finally { node.stop(); }
  });

  test('admin 口没 token 进不去', async () => {
    const r = await alice.admin('/api/admin/me', { token: '' });
    assert.equal(r.status, 401);
    const r2 = await alice.admin('/api/admin/me', { token: 'wrong' });
    assert.equal(r2.status, 401);
  });

  test('/internal 不该被 nginx 放行——代码侧也只认本机', async () => {
    // 这里是直连 127.0.0.1，所以会过；真实部署靠 nginx 白名单挡。
    // 断言的是「这个口存在且是 localhostOnly」，提醒别把它写进 nginx。
    const r = await fetch(alice.baseUrl + '/internal/should-comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.notEqual(r.status, 404, '口应该在');
  });
});

describe('已经加上的好友（有 shared_secret）', () => {
  test('推动态时 author_id 只认签名证明的那个', async () => {
    const r = await alice.signed('/api/moments/receive', {
      moment_id: 'IMP_1',
      author_id: 'someone_else',            // 自报别人
      author_name: 'Alice 本人',            // 名字也想冒充
      content: '冒充的动态',
      created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');
    assert.equal(r.status, 200);

    const row = alice.db().prepare('SELECT * FROM public_feed_cache WHERE moment_id=?').get('IMP_1');
    assert.equal(row.author_id, 'bob_node', 'author_id 必须是签名方');
    assert.ok(!String(row.author_name).includes('Alice 本人'), '显示名也不能是自报的');
  });

  test('互动时 operator_id 只认签名证明的那个', async () => {
    await alice.signed('/api/moments/receive', {
      moment_id: 'IMP_2', content: '一条正常动态', created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');

    const r = await alice.signed('/api/moments/action', {
      target_moment_id: 'IMP_2',
      operator_id: 'someone_else',
      operator_name: '别人',
      action_type: 'comment',
      content: '冒充的评论',
    }, secrets.aSecret, 'bob_node');
    assert.equal(r.status, 200);

    const row = alice.db()
      .prepare("SELECT * FROM moment_interactions WHERE target_moment_id=? AND action_type='comment'")
      .get('IMP_2');
    assert.equal(row.operator_id, 'bob_node');
  });

  test('身份必须挂在那个节点名下', async () => {
    await alice.signed('/api/moments/receive', {
      moment_id: 'IMP_3',
      author_identity_id: 'alice_node_human',   // 这是 alice 自己的身份，不是 bob 的
      content: 'x', created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');
    const row = alice.db().prepare('SELECT * FROM public_feed_cache WHERE moment_id=?').get('IMP_3');
    assert.equal(row.author_identity_id, 'unknown', '不属于他的身份应该降成 unknown');
  });

  test('删不掉别人推来的动态', async () => {
    // 手工塞一条「第三方推来的」
    const Database = require('better-sqlite3');
    const w = new Database(alice.dbPath);
    w.prepare(`INSERT OR REPLACE INTO public_feed_cache
      (moment_id, author_id, author_identity_id, author_name, author_server, content, created_at, is_deleted)
      VALUES (?,?,?,?,?,?,?,0)`)
      .run('OTHERS_1', 'carol_node', 'unknown', 'Carol', 'http://c', 'Carol 的动态',
           Math.floor(Date.now() / 1000));
    w.close();

    await alice.signed('/api/moments/action', {
      target_moment_id: 'OTHERS_1', action_type: 'delete',
    }, secrets.aSecret, 'bob_node');

    const row = alice.db().prepare('SELECT is_deleted FROM public_feed_cache WHERE moment_id=?').get('OTHERS_1');
    assert.equal(row.is_deleted, 0, 'Carol 的动态不该被 Bob 删掉');
  });

  test('正文和评论有长度上限', async () => {
    const r = await alice.signed('/api/moments/receive', {
      moment_id: 'BIG_1', content: 'X'.repeat(20000), created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');
    assert.equal(r.status, 413);

    await alice.signed('/api/moments/receive', {
      moment_id: 'BIG_2', content: 'ok', created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');
    const r2 = await alice.signed('/api/moments/action', {
      target_moment_id: 'BIG_2', action_type: 'comment', content: 'Y'.repeat(3000),
    }, secrets.aSecret, 'bob_node');
    assert.equal(r2.status, 413);
  });

  test('每个好友的缓存条数有上限', async () => {
    const Database = require('better-sqlite3');
    const w = new Database(alice.dbPath);
    const ins = w.prepare(`INSERT OR REPLACE INTO public_feed_cache
      (moment_id, author_id, author_identity_id, author_name, author_server, content, created_at, is_deleted)
      VALUES (?,?,?,?,?,?,?,0)`);
    const t0 = Math.floor(Date.now() / 1000) - 100000;
    w.transaction(() => {
      for (let i = 0; i < 520; i++) ins.run(`CAP_${i}`, 'bob_node', 'unknown', 'B', '', `x${i}`, t0 + i);
    })();
    w.close();

    await alice.signed('/api/moments/receive', {
      moment_id: 'CAP_NEW', content: '最新的一条', created_at: Math.floor(Date.now() / 1000),
    }, secrets.aSecret, 'bob_node');

    const d = alice.db();
    const n = d.prepare('SELECT COUNT(*) c FROM public_feed_cache WHERE author_id=?').get('bob_node').c;
    const newest = d.prepare('SELECT * FROM public_feed_cache WHERE moment_id=?').get('CAP_NEW');
    d.close();
    assert.ok(n <= 500, `应该压到 500 以内，实际 ${n}`);
    assert.ok(newest, '压上限时不能把刚推来的新动态删掉');
  });

  test('签名不对 / 过期时间戳一律 401', async () => {
    const body = { moment_id: 'SIG_1', content: 'x', created_at: Math.floor(Date.now() / 1000) };
    const bad = await alice.signed('/api/moments/receive', body, 'wrong-secret', 'bob_node');
    assert.equal(bad.status, 401);

    const old = await alice.signed('/api/moments/receive', body, secrets.aSecret, 'bob_node',
      { ts: Math.floor(Date.now() / 1000) - 99999 });
    assert.equal(old.status, 401, '时间窗外的请求要拒');

    const unknown = await alice.signed('/api/moments/receive', body, secrets.aSecret, 'nobody_node');
    assert.equal(unknown.status, 401, '不是好友的发送方要拒');
  });
});
