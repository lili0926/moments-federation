const db = require('../db');
const config = require('../config');
const { signBody } = require('../middleware/auth');

async function postSigned(serverUrl, path, secret, bodyObj) {
  const bodyString = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signBody(secret, bodyString, ts);
  const url = serverUrl.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sender-ID': config.SELF_NODE_ID,
      'X-Timestamp': String(ts),
      'X-Signature': sig,
    },
    body: bodyString,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`federation ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/** 向所有已接受好友广播一条 public 动态 */
async function broadcastMoment(moment) {
  const friends = db.prepare(`SELECT * FROM friends WHERE status='accepted'`).all();
  const payload = {
    moment_id: moment.id,
    author_id: config.SELF_NODE_ID,
    author_identity_id: moment.identity_id,
    author_name: moment.author_name || config.SELF_DISPLAY_NAME,
    author_server: config.SELF_SERVER_URL,
    content: moment.content,
    created_at: moment.created_at,
  };
  const results = [];
  for (const f of friends) {
    try {
      await postSigned(f.server_url, '/api/moments/receive', f.shared_secret, payload);
      results.push({ friend_id: f.friend_id, ok: true });
    } catch (e) {
      results.push({ friend_id: f.friend_id, ok: false, error: e.message });
    }
  }
  return results;
}

/** 广播墓碑 / 互动 */
async function broadcastAction(actionPayload) {
  const friends = db.prepare(`SELECT * FROM friends WHERE status='accepted'`).all();
  const results = [];
  for (const f of friends) {
    try {
      await postSigned(f.server_url, '/api/moments/action', f.shared_secret, actionPayload);
      results.push({ friend_id: f.friend_id, ok: true });
    } catch (e) {
      results.push({ friend_id: f.friend_id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { broadcastMoment, broadcastAction, postSigned };
