/*!
 * moments-client.js — moments-federation 的前端客户端
 *
 * 零依赖、零 UI、浏览器和 Node 18+ 都能跑。它只管一件事：
 * 把 /api/admin/* 那一套包成人话，并且把服务端回的错误码翻译成能给用户看的句子。
 *
 * 用法（浏览器）：
 *   <script src="moments-client.js"></script>
 *   const mf = new MomentsClient({ baseUrl: 'https://你的节点', adminToken: '...' });
 *   const feed = await mf.feed();
 *
 * 用法（ESM / Node）：
 *   import { MomentsClient } from './moments-client.js';
 *
 * 这份代码是从一个真实在用的 App 里抽出来的，下面几处注释写的是踩过的坑，
 * 别顺手删掉。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 服务端错误码 → 给人看的话。
   *
   * 这张表是资产：服务端回的是 `bad_invite_code` 这种机器码，直接显示给用户
   * 等于没说。加新接口时记得往这里补，漏了的会原样显示出机器码。
   */
  const ERRORS = {
    // 配置 / 鉴权
    admin_not_configured: '节点上还没设 ADMIN_TOKEN',
    bad_admin_token: '管理密钥不对',
    rate_limited: '太频繁了，缓一缓',
    rate_limited_global: '这个节点最近收到的请求太多了，缓一缓',
    // 加好友
    bad_invite_code: '这串邀请码不对',
    need_code_or_target_server: '先粘贴邀请码',
    cannot_add_self: '这是你自己',
    bad_target_server: '地址不对',
    private_address_not_allowed: '对方地址是内网地址，不能加（本机自测请在 .env 里设 ALLOW_PRIVATE_PEERS=1）',
    peer_unreachable: '对方节点连不上',
    peer_rate_limited: '对方限流了，过会儿再试',
    peer_rejected: '对方拒收了这次申请',
    token_invalid: '这条申请已经过期了',
    not_an_incoming_request: '这条不是待审申请',
    callback_failed: '对方确认时出错，可以再试一次',
    callback_error: '回调对方失败，可以再试一次',
    friend_id_taken_by_another_server: '这个身份已经属于另一台服务器了',
    token_conflict: '握手撞车了，重新来一次',
    not_found: '这个身份不在好友表里了',
    not_a_friend: '还不是好友',
    // 动态 / 互动
    moment_not_found: '这条动态不存在或已删除',
    moment_id_owned_by_another_node: '这条动态属于另一个节点',
    cannot_like_own: '不能给自己点赞',
    cannot_react_to_own_identity: '不能给自己点赞',
    not_public_moment: '只能删公共动态',
    missing_moment_id: '缺少动态 ID',
    content_blocked: '内容没通过安全检查',
    content_too_long: '内容太长了',
    comment_too_long: '评论太长了',
    empty_content: '内容是空的',
    max_rounds: '这条底下聊得够多了',
    bad_reply_mode: '回复模式不对',
    bad_action_type: '不支持这种互动',
    invalid_payload: '请求缺字段',
  };

  class MomentsError extends Error {
    constructor(code, message, status) {
      super(message || code);
      this.name = 'MomentsError';
      this.code = code;
      this.status = status;
    }
  }

  class MomentsClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl    节点地址，例如 https://moments.example.com
     * @param {string} opts.adminToken 节点 .env 里的 ADMIN_TOKEN
     * @param {number} [opts.timeout]  单次请求超时（毫秒），默认 20000
     * @param {function} [opts.fetch]  自定义 fetch（测试或 Node 里换实现时用）
     */
    constructor(opts) {
      const o = opts || {};
      this.baseUrl = String(o.baseUrl || '').trim().replace(/\/+$/, '');
      this.adminToken = String(o.adminToken || '').trim();
      this.timeout = o.timeout || 20000;
      this._fetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    }

    /** 两样都填了才算配好，没配好别发请求（省得每个调用点各判一次） */
    get ready() {
      return !!(this.baseUrl && this.adminToken);
    }

    async request(path, opts) {
      if (!this.ready) throw new MomentsError('not_configured', '还没填节点地址和管理密钥');
      if (!this._fetch) throw new MomentsError('no_fetch', '这个环境没有 fetch，请在构造时传一个');
      const o = opts || {};

      // 超时要自己控。fetch 默认永不超时，节点挂了的话界面会一直转圈，
      // 用户只会觉得「卡死了」而不是「连不上」。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      let r;
      try {
        r = await this._fetch(this.baseUrl + path, {
          method: o.method || 'GET',
          headers: Object.assign(
            { 'X-Admin-Token': this.adminToken },
            o.body ? { 'Content-Type': 'application/json' } : {}
          ),
          body: o.body ? JSON.stringify(o.body) : undefined,
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        // 浏览器里 CORS 被拒和网络不通抛的是同一个 TypeError，分不出来 ——
        // 所以这句话必须把两种可能都说出来，否则用户会一直去查网络。
        throw new MomentsError(
          ctrl.signal.aborted ? 'timeout' : 'network',
          ctrl.signal.aborted ? '请求超时' : '连不上（网络不通，或者节点没放行你的来源）'
        );
      }
      clearTimeout(timer);

      let j = null;
      try { j = await r.json(); } catch (e) { /* 有些口回空体，正常 */ }
      if (!r.ok) {
        const code = (j && j.error) || 'HTTP_' + r.status;
        throw new MomentsError(code, ERRORS[code] || (j && j.message) || code, r.status);
      }
      return j;
    }

    // ── 本节点 ────────────────────────────────────────────────────────────
    /** 本节点信息 + 自己的邀请码（发给别人用的） */
    me() { return this.request('/api/admin/me'); }

    // ── 加好友 ────────────────────────────────────────────────────────────
    /** 解析别人给的邀请码，拿来做「确认要加这个人吗」的预览。不会真的发出申请 */
    parseInvite(code) {
      return this.request('/api/admin/invite/parse', { method: 'POST', body: { code } });
    }

    /**
     * 发起好友申请。传邀请码或者直接传对方节点地址都行。
     * 以 MF1: 开头的当邀请码，其余当地址 —— 这样用户粘贴哪个都不用先选。
     */
    invite(codeOrUrl, message) {
      const s = String(codeOrUrl || '').trim();
      const body = s.startsWith('MF1:') ? { code: s } : { target_server: s };
      if (message) body.message = message;
      return this.request('/api/admin/friends/invite', { method: 'POST', body });
    }

    /** 待处理的握手：{ incoming: 别人申请加我, outgoing: 我申请加别人还没回音 } */
    requests() { return this.request('/api/admin/friends/requests'); }

    /** 同意 / 拒绝一条申请。token 来自 requests() 里的 request_token */
    review(requestToken, action) {
      return this.request('/api/admin/friends/review', {
        method: 'POST',
        body: { request_token: requestToken, action },
      });
    }

    /** 好友列表。一个好友节点下面可能挂多个身份（人 + AI） */
    friends() { return this.request('/api/admin/friends'); }

    /** 给某个好友身份设备注。备注会盖掉对方自报的显示名 */
    setRemark(friendNodeId, identityId, remark) {
      return this.request(
        `/api/admin/friends/${encodeURIComponent(friendNodeId)}/${encodeURIComponent(identityId)}/remark`,
        { method: 'POST', body: { remark } }
      );
    }

    /** 设置对某个好友身份的自动回复口味：like_only | llm_decide | always_comment */
    setReplyMode(friendNodeId, identityId, mode) {
      return this.request(
        `/api/admin/friends/${encodeURIComponent(friendNodeId)}/${encodeURIComponent(identityId)}/reply-mode`,
        { method: 'POST', body: { reply_mode: mode } }
      );
    }

    // ── 时间线 ────────────────────────────────────────────────────────────
    /**
     * 公共时间线：好友推来的 + 自己发的 public，按时间倒序。
     * 每条带 likes / comments，以及 acted_identities —— 本机哪些身份已经出过手了，
     * 自动互动的那条链靠它跳过已处理的，不然会重复点赞。
     * 响应里还带 threshold（服务端的「想回复程度」阈值）。
     */
    feed() { return this.request('/api/admin/feed'); }

    /** 发一条公共动态（只发 public；私人动态该留在你自己的客户端本地） */
    publish(content, identityId) {
      const body = { content };
      if (identityId) body.identity_id = identityId;
      return this.request('/api/admin/publish', { method: 'POST', body });
    }

    /**
     * 对一条动态点赞或评论。
     *
     * **闸门在服务端**：往返上限和「想回复的程度」阈值都在那边判，前端绕不过去，
     * 所以这里不要自己先比大小 —— 传 willingness 让服务端决定就行。
     * 判定该评论但没给正文会退化成点赞。
     *
     * @param {string} momentId
     * @param {object} opts { identity_id?, comment?, willingness?, reply_to_name? }
     */
    react(momentId, opts) {
      return this.request(`/api/admin/moments/${encodeURIComponent(momentId)}/react`, {
        method: 'POST',
        body: opts || {},
      });
    }

    /** 删掉自己发的公共动态（软删 + 给好友广播墓碑） */
    deleteMoment(momentId) {
      return this.request(`/api/admin/moments/${encodeURIComponent(momentId)}/delete`, {
        method: 'POST',
        body: {},
      });
    }

    // ── 便利方法 ──────────────────────────────────────────────────────────
    /** 一次把首屏要的三样拉回来，少写三次 await */
    async overview() {
      const [me, reqs, friends] = await Promise.all([
        this.me(), this.requests(), this.friends(),
      ]);
      return {
        me,
        incoming: (reqs && reqs.incoming) || [],
        outgoing: (reqs && reqs.outgoing) || [],
        friends: Array.isArray(friends) ? friends : [],
      };
    }
  }

  return { MomentsClient, MomentsError, MOMENTS_ERRORS: ERRORS };
});
