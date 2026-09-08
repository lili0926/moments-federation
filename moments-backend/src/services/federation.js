const db = require('../db');
const config = require('../config');
const { sign } = require('../middleware/auth');

// PHASE 1 时不做真实网络请求，只打印日志，方便本地先跑通逻辑不依赖网络。
async function pushToFriend(friend, path, payload) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyString = JSON.stringify(payload);
  const signature = sign(friend.shared_secret, bodyString, timestamp);

  if (config.PHASE < 2) {
    console.log(`[PHASE1 模拟推送] -> ${friend.server_url}${path}`, payload);
    return { ok: true, simulated: true };
  }

  try {
    const res = await fetch(`${friend.server_url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sender-ID': config.SELF_NODE_ID,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      body: bodyString,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error(`推送给好友 ${friend.friend_id} 失败:`, err.message);
    return { ok: false, error: err.message };
  }
}

// 广播public动态给所有已接受好友（异步，不阻塞发布接口返回）
async function broadcastMoment(moment) {
  const friends = db.prepare(`SELECT * FROM friends WHERE status='accepted'`).all();
  const payload = {
    moment_id: moment.id,
    author_id: config.SELF_NODE_ID,
    author_name: config.SELF_DISPLAY_NAME,
    author_server: config.SELF_SERVER_URL,
    content: moment.content,
    created_at: moment.created_at,
  };
  for (const friend of friends) {
    pushToFriend(friend, '/api/moments/receive', payload);
  }
}

async function broadcastAction(action) {
  const friends = db.prepare(`SELECT * FROM friends WHERE status='accepted'`).all();
  for (const friend of friends) {
    pushToFriend(friend, '/api/moments/action', action);
  }
}

module.exports = { pushToFriend, broadcastMoment, broadcastAction };
