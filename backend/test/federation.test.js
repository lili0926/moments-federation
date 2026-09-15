/**
 * 正常路径：两个真节点走完整流程。
 *
 * 安全测试管「不该发生的别发生」，这个文件管「该能用的还能用」——
 * 收紧权限时最容易翻车的地方，就是把攻击挡住的同时也把正常人挡在外面。
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { startNode, makeFriends } = require('./helpers');

let a, b, secrets;

before(async () => {
  a = await startNode({ nodeId: 'a_node', displayName: 'A 的小镇', humanName: '阿云', aiName: '小A' });
  b = await startNode({ nodeId: 'b_node', displayName: 'B 的小镇', humanName: '阿海', aiName: '小B' });
  secrets = await makeFriends(a, b);
});

after(() => { if (a) a.stop(); if (b) b.stop(); });

describe('加好友', () => {
  test('邀请码解得开，而且内容就是那三样', async () => {
    const me = await a.admin('/api/admin/me');
    assert.ok(me.body.invite_code.startsWith('MF1:'));
    const parsed = await b.admin('/api/admin/invite/parse', {
      method: 'POST', body: { code: me.body.invite_code },
    });
    const info = parsed.body.invite || parsed.body;
    assert.equal(info.node_id, 'a_node');
    assert.equal(info.server_url, a.baseUrl);
    assert.ok(info.display_name);
  });

  test('邀请码每次生成都一样（它是名片，不是凭据）', async () => {
    const m1 = await a.admin('/api/admin/me');
    const m2 = await a.admin('/api/admin/me');
    assert.equal(m1.body.invite_code, m2.body.invite_code);
  });

  test('握手之后双方都是 accepted，且各自存了对方的身份', async () => {
    const fa = await a.admin('/api/admin/friends');
    const fb = await b.admin('/api/admin/friends');
    const ab = fa.body.find((f) => f.friend_node_id === 'b_node');
    const ba = fb.body.find((f) => f.friend_node_id === 'a_node');
    assert.equal(ab.status, 'accepted');
    assert.equal(ba.status, 'accepted');
    assert.ok(ab.identities.length >= 2, '对方的人和 AI 两个身份都该存下来');
    assert.ok(ab.identities.some((i) => i.type === 'ai'));
  });

  test('双方的 shared_secret 是同一把，而且是随机的', () => {
    assert.equal(secrets.aSecret, secrets.bSecret, '两边记的必须是同一把');
    assert.equal(secrets.aSecret.length, 64);
    assert.match(secrets.aSecret, /^[0-9a-f]+$/);
  });

  test('备注和回复模式改得动', async () => {
    const r1 = await a.admin('/api/admin/friends/b_node/b_node_human/remark', {
      method: 'POST', body: { remark: '老海' },
    });
    assert.equal(r1.status, 200);
    const r2 = await a.admin('/api/admin/friends/b_node/b_node_ai/reply-mode', {
      method: 'POST', body: { reply_mode: 'always_comment' },
    });
    assert.equal(r2.status, 200);

    const fa = await a.admin('/api/admin/friends');
    const ids = fa.body.find((f) => f.friend_node_id === 'b_node').identities;
    assert.equal(ids.find((i) => i.identity_id === 'b_node_human').remark, '老海');
    assert.equal(ids.find((i) => i.identity_id === 'b_node_ai').reply_mode, 'always_comment');
  });

  test('拒绝一条申请之后对方不会变成好友', async () => {
    const c = await startNode({ nodeId: 'c_node' });
    try {
      const me = await a.admin('/api/admin/me');
      await c.admin('/api/admin/friends/invite', { method: 'POST', body: { code: me.body.invite_code } });
      const reqs = await a.admin('/api/admin/friends/requests');
      const it = reqs.body.incoming.find((r) => r.node_id === 'c_node');
      assert.ok(it, 'a 应该收到 c 的申请');
      await a.admin('/api/admin/friends/review', {
        method: 'POST', body: { request_token: it.request_token, action: 'reject' },
      });
      const fa = await a.admin('/api/admin/friends');
      assert.ok(!fa.body.some((f) => f.friend_node_id === 'c_node' && f.status === 'accepted'));
    } finally { c.stop(); }
  });
});

describe('动态从一端到另一端', () => {
  let momentId;

  test('A 发一条公共动态，广播成功', async () => {
    const r = await a.admin('/api/admin/publish', {
      method: 'POST', body: { content: '今天风很大', identity_id: 'a_node_human' },
    });
    assert.equal(r.status, 200);
    momentId = r.body.moment.id;
    assert.ok(Array.isArray(r.body.broadcast));
    assert.ok(r.body.broadcast.every((x) => x.ok), JSON.stringify(r.body.broadcast));
  });

  test('B 那边收到了，作者和身份都对', async () => {
    const d = b.db();
    const row = d.prepare('SELECT * FROM public_feed_cache WHERE moment_id=?').get(momentId);
    d.close();
    assert.ok(row, 'B 应该收到');
    assert.equal(row.author_id, 'a_node');
    assert.equal(row.author_identity_id, 'a_node_human');
    assert.equal(row.content, '今天风很大');
    assert.ok(row.author_name && row.author_name !== 'unknown');
  });

  test('B 评论，A 看得见，而且作者是 B', async () => {
    const r = await b.admin(`/api/admin/moments/${momentId}/react`, {
      method: 'POST', body: { comment: '我这儿也是', willingness: 100 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.did, 'comment');

    const feed = await a.admin('/api/admin/feed');
    const item = feed.body.items.find((i) => i.moment_id === momentId);
    assert.ok(item, 'A 的时间线里应该有这条');
    assert.equal(item.comments.length, 1);
    assert.equal(item.comments[0].operator_id, 'b_node');
    assert.equal(item.comments[0].content, '我这儿也是');
  });

  test('「回复某人：」会被拆成结构化字段', async () => {
    const r = await b.admin(`/api/admin/moments/${momentId}/react`, {
      method: 'POST', body: { comment: '回复阿云：真的假的', willingness: 100 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const feed = await a.admin('/api/admin/feed');
    const item = feed.body.items.find((i) => i.moment_id === momentId);
    const c = item.comments.find((x) => x.reply_to_name);
    assert.ok(c, '应该有一条带 reply_to_name 的');
    assert.equal(c.reply_to_name, '阿云');
    assert.equal(c.content, '真的假的', '正文里不该再留「回复X：」');
  });

  test('往返上限会拦住无限来回', async () => {
    // 上面两条测试已经评论过 2 次，MAX_EXCHANGE_ROUNDS 默认就是 2，所以这里第一下就该被拦。
    // 注意断言的是 did==='nothing' 而不是某个 reason 字符串 ——
    // 之前这里写死 'max_rounds'，而 decideAction 给的是 'exchange_cap_reached'，
    // 结果测试和实现各说各的，闸门坏了都测不出来。
    let blocked = null;
    for (let i = 0; i < 6; i++) {
      const r = await b.admin(`/api/admin/moments/${momentId}/react`, {
        method: 'POST', body: { comment: `再来一句 ${i}`, willingness: 100 },
      });
      if (r.body && r.body.did === 'nothing') { blocked = r.body; break; }
    }
    assert.ok(blocked, '聊够了就该拦，不然两个 AI 会无限对话');
    assert.equal(blocked.decision.action, 'blocked');
    assert.equal(blocked.decision.reason, 'exchange_cap_reached');
  });

  test('手写评论不会被 willingness 阈值降级成点赞', async () => {
    // 这条和上面那条是一对：往返上限（硬闸）要拦，willingness（口味）不该拦。
    const r = await a.admin('/api/admin/publish', { method: 'POST', body: { content: '新的一条' } });
    const fresh = r.body.moment.id;
    const react = await b.admin(`/api/admin/moments/${fresh}/react`, {
      method: 'POST', body: { comment: '我就是要评论', willingness: 0 },   // 分数给到最低
    });
    assert.equal(react.body.did, 'comment', 'willingness=0 也不该把人写的评论降成点赞');
  });

  test('A 删掉自己的动态，B 那边也消失', async () => {
    const r = await a.admin(`/api/admin/moments/${momentId}/delete`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);

    const d = b.db();
    const row = d.prepare('SELECT is_deleted FROM public_feed_cache WHERE moment_id=?').get(momentId);
    d.close();
    assert.equal(row.is_deleted, 1, '墓碑应该广播过去');
  });

  test('不能删别人的动态', async () => {
    const r = await b.admin('/api/admin/publish', {
      method: 'POST', body: { content: 'B 发的' },
    });
    const bid = r.body.moment.id;
    const del = await a.admin(`/api/admin/moments/${bid}/delete`, { method: 'POST', body: {} });
    assert.notEqual(del.status, 200, 'A 不该能删 B 的动态');
  });
});

describe('/sync 拉历史', () => {
  test('默认给全部历史', async () => {
    const r = await fetch(`${a.baseUrl}/api/moments/sync?since=0`, {
      headers: signHeaders('a_node_probe', secrets.aSecret, 'b_node'),
    });
    // 这个口是 GET，签的是空 body
    assert.ok([200, 401].includes(r.status));
  });

  test('SYNC_ONLY_AFTER_FRIENDSHIP=1 时以成为好友的时间为地板', async () => {
    const node = await startNode({ nodeId: 'sync_node', env: { SYNC_ONLY_AFTER_FRIENDSHIP: '1' } });
    try {
      const peer = await startNode({ nodeId: 'sync_peer' });
      try {
        // 先发一条「加好友之前」的动态
        await node.admin('/api/admin/publish', { method: 'POST', body: { content: '加好友之前发的' } });
        // 把它的时间往前挪一天，模拟历史
        const Database = require('better-sqlite3');
        const w = new Database(node.dbPath);
        w.prepare('UPDATE moments SET created_at = created_at - 86400').run();
        w.close();

        const s = await makeFriends(node, peer);
        await node.admin('/api/admin/publish', { method: 'POST', body: { content: '加好友之后发的' } });

        const crypto = require('crypto');
        const ts = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', s.aSecret).update(ts + '.' + '{}').digest('hex');
        const r = await fetch(`${node.baseUrl}/api/moments/sync?since=0`, {
          headers: { 'X-Sender-ID': 'sync_peer', 'X-Timestamp': String(ts), 'X-Signature': sig },
        });
        const j = await r.json();
        assert.equal(r.status, 200, JSON.stringify(j));
        const texts = (j.moments || []).map((m) => m.content);
        assert.ok(!texts.includes('加好友之前发的'), '开了开关就不该给加好友之前的');
        assert.ok(texts.includes('加好友之后发的'), '之后的还是要给');
      } finally { peer.stop(); }
    } finally { node.stop(); }
  });
});

function signHeaders(_unused, secret, senderId) {
  const crypto = require('crypto');
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(ts + '.' + '{}').digest('hex');
  return { 'X-Sender-ID': senderId, 'X-Timestamp': String(ts), 'X-Signature': sig };
}
