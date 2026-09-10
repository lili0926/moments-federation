#!/usr/bin/env bash
#
# 在一台 Ubuntu/Debian 上把 moments-federation 后端跑起来。可重复执行（幂等）。
#
#   HOST_IP=1.2.3.4 bash deploy.sh
#
# 可用环境变量覆盖：
#   HOST_IP         必填，本节点的公网地址（好友要靠它连过来），也可写域名
#   SCHEME          http | https（默认 http；用域名+证书时设 https）
#   PORT_PUBLIC     nginx 对外监听端口（默认 3100）
#   PORT_INTERNAL   Node 监听端口，只走本机（默认 3010）
#   APP_DIR         代码目录（默认 /opt/moments-federation）
#   SERVICE         systemd 服务名（默认 moments）
#   GH_TOKEN        私有仓库才需要；不给就假设 APP_DIR 里已经有代码了
#   REPO            默认 lili0926/moments-federation
#
set -uo pipefail

HOST_IP="${HOST_IP:-}"
SCHEME="${SCHEME:-http}"
PORT_PUBLIC="${PORT_PUBLIC:-3100}"
PORT_INTERNAL="${PORT_INTERNAL:-3010}"
APP_DIR="${APP_DIR:-/opt/moments-federation}"
SERVICE="${SERVICE:-moments}"
REPO="${REPO:-lili0926/moments-federation}"

if [ -z "$HOST_IP" ]; then
  echo "!! 要先给 HOST_IP —— 好友节点是靠这个地址连过来的，填错了握手能成、推动态会失败"
  echo "   例：HOST_IP=1.2.3.4 bash deploy.sh"
  exit 1
fi
PUBLIC_URL="$SCHEME://$HOST_IP:$PORT_PUBLIC"

echo "=============== 0. 环境 ==============="
node -v >/dev/null 2>&1 || { echo "!! 没有 node，先装 node 18 以上"; exit 1; }
echo "node $(node -v) / npm $(npm -v 2>/dev/null)"
for c in curl tar rsync openssl; do
  command -v "$c" >/dev/null || { echo "!! 缺 $c"; exit 1; }
done

# 端口占用检查：别把别人的服务挤掉
for p in "$PORT_INTERNAL" "$PORT_PUBLIC"; do
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    echo "!! 端口 $p 已被占用，换一个再跑（PORT_INTERNAL= / PORT_PUBLIC=）："
    ss -lntp 2>/dev/null | grep -E "[:.]$p\s" || true
    exit 1
  fi
done
echo "端口 $PORT_INTERNAL / $PORT_PUBLIC 空闲"
free -m 2>/dev/null | awk '/^Mem:/{print "内存：可用 "$7"MB / 共 "$2"MB"}'

echo
echo "=============== 1. 代码 ==============="
mkdir -p "$APP_DIR"
if [ -n "${GH_TOKEN:-}" ]; then
  # 走 tarball，不把 token 写进 git config
  curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
       "https://api.github.com/repos/$REPO/tarball/main" -o /tmp/mf.tar.gz \
    || { echo "!! 下载失败（token 对吗？这台机器能上 GitHub 吗？）"; exit 1; }
  rm -rf /tmp/mf-x && mkdir -p /tmp/mf-x
  tar xzf /tmp/mf.tar.gz -C /tmp/mf-x --strip-components=1
  # .env 和 data 是这台机器的东西，更新代码时保住
  rsync -a --exclude node_modules --exclude .env --exclude data /tmp/mf-x/ "$APP_DIR"/
  rm -rf /tmp/mf.tar.gz /tmp/mf-x
  echo "代码已更新到 $APP_DIR"
else
  echo "没给 GH_TOKEN，跳过拉代码（假设 $APP_DIR 里已经有了）"
  [ -f "$APP_DIR/backend/package.json" ] || { echo "!! $APP_DIR/backend 里没东西"; exit 1; }
fi

echo
echo "=============== 2. 依赖 ==============="
cd "$APP_DIR/backend"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -4 \
  || npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | tail -4

# better-sqlite3 是原生模块，ABI 要和当前 node 对得上。
# 注意：11.x 在 node 24 上虽然能跑，但收 SIGTERM 时析构会崩（status=6/ABRT），
# 表现是每次 restart 先 core dump 一次、期间有几秒 502。12.x 修好了。
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "-- better-sqlite3 加载不了（node $(node -v) 的 ABI 对不上），换 12 --"
  npm install --no-audit --no-fund better-sqlite3@^12 2>&1 | tail -4
fi
node -e "
const v = require('better-sqlite3/package.json').version;
require('better-sqlite3');
const major = parseInt(v, 10);
const nodeMajor = parseInt(process.versions.node, 10);
console.log('better-sqlite3', v, 'on node', process.versions.node);
if (nodeMajor >= 24 && major < 12) {
  console.log('!! node>=24 建议用 better-sqlite3>=12，否则每次重启会 core dump');
}
" || { echo "!! better-sqlite3 装不上；试试 apt install -y python3 make g++ 再重来"; exit 1; }

echo
echo "=============== 3. .env ==============="
if [ -f .env ]; then
  echo ".env 已存在，原样保留（ADMIN_TOKEN 不会被换掉）"
  # 新增的配置项补进去，老部署升级时不至于缺
  grep -q '^REPLY_WILLINGNESS_THRESHOLD=' .env || {
    printf '\n# 想回复的程度低于这个分数就只点赞不评论（0-100）\nREPLY_WILLINGNESS_THRESHOLD=60\n' >> .env
    echo "补上了 REPLY_WILLINGNESS_THRESHOLD=60"
  }
else
  ADMIN_TOKEN=$(openssl rand -hex 32)
  cat > .env <<EOF
PHASE=2
PORT=$PORT_INTERNAL
SELF_SERVER_URL=$PUBLIC_URL
SELF_NODE_ID=my_node
SELF_DISPLAY_NAME=我的小镇
SELF_HUMAN_ID=my_human
SELF_HUMAN_NAME=Me
SELF_AI_ID=my_ai
SELF_AI_NAME=AI
DB_PATH=./data/moments.db
SIGNATURE_WINDOW_SECONDS=300
FRIEND_REQUEST_RATE_LIMIT=5
MAX_EXCHANGE_ROUNDS=2
HANDSHAKE_TOKEN_TTL_SECONDS=600
REPLY_WILLINGNESS_THRESHOLD=60
ADMIN_TOKEN=$ADMIN_TOKEN
ADMIN_RATE_LIMIT=600
ADMIN_CORS_ORIGINS=*
EOF
  chmod 600 .env
  echo ".env 已生成（SELF_NODE_ID / 显示名 / 身份名记得改成你自己的）"
fi
mkdir -p data

echo
echo "=============== 4. systemd ==============="
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=moments-federation
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/backend
ExecStart=$(command -v node) src/app.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
# 机器上若有全局代理（HTTP_PROXY 之类），这行挡住发往本机的请求，
# 否则连 127.0.0.1 也会被塞进代理，回一个莫名其妙的 502
Environment=NO_PROXY=127.0.0.1,localhost,::1
# 小内存机器上给它个笼头，别让它把整台机拖死
Environment=NODE_OPTIONS=--max-old-space-size=128
MemoryHigh=192M
MemoryMax=320M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 3
systemctl is-active "$SERVICE" >/dev/null && echo "$SERVICE 起来了" \
  || { journalctl -u "$SERVICE" -n 25 --no-pager; exit 1; }

echo
echo "=============== 5. nginx ==============="
# 独立配置文件，不动机器上已有的。白名单式：只放联邦必需 + admin。
# 想上 HTTPS/域名，照着 backend/nginx.conf.example 改这份。
cat > "/etc/nginx/sites-available/$SERVICE" <<EOF
server {
    listen $PORT_PUBLIC;
    server_name _;
    client_max_body_size 1m;

    location = /health                      { proxy_pass http://127.0.0.1:$PORT_INTERNAL; }
    location = /api/friends/request          { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location = /api/friends/accept-callback  { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; }
    location = /api/moments/receive          { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; }
    location = /api/moments/sync             { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; }
    location = /api/moments/action           { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; }

    # 前端管理通道，鉴权靠 X-Admin-Token。
    # 千万别在这里 add_header Access-Control-Allow-Origin —— Node 侧已经加了一份，
    # 浏览器见到两个 ACAO 直接判 CORS 失败，而请求其实已经在服务端执行完了，
    # 表现是「日志全 200 但前端说连不上」，极难查。
    location /api/admin/ { proxy_pass http://127.0.0.1:$PORT_INTERNAL; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }

    # /internal/* 绝不出现在这里：那里面有 AI 代发圈的口，
    # 且 trust proxy=false 意味着一旦放行，localhostOnly 也拦不住。
    location / { return 404; }
}
EOF
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
nginx -t 2>&1 | tail -2
nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "nginx 已 reload" \
  || { echo "!! nginx 配置有问题，旧配置没动"; exit 1; }

echo
echo "=============== 6. 验证 ==============="
sleep 1
echo -n "本机 :$PORT_INTERNAL      → "; curl -s --noproxy '*' "http://127.0.0.1:$PORT_INTERNAL/health"; echo
echo -n "对外 :$PORT_PUBLIC       → "; curl -s --noproxy '*' "http://127.0.0.1:$PORT_PUBLIC/health"; echo
echo -n "/internal 该被挡（404）  → "; curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' "http://127.0.0.1:$PORT_PUBLIC/internal/health"
echo -n "admin 无 token（401）    → "; curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' "http://127.0.0.1:$PORT_PUBLIC/api/admin/me"
echo -n "占用内存                 → "; systemctl show "$SERVICE" -p MemoryCurrent --value | awk '{printf "%.0f MB\n", $1/1048576}'

echo
echo "================ 前端填这两格 ================"
echo "Base URL : $PUBLIC_URL"
echo -n "管理密钥 : "; grep '^ADMIN_TOKEN=' "$APP_DIR/backend/.env" | cut -d= -f2
echo
echo "别忘了："
echo "  1) 云厂商安全组 / 防火墙放行 TCP $PORT_PUBLIC，否则好友连不进来"
echo "  2) Node 是 listen('0.0.0.0') 写死的，$PORT_INTERNAL 也在公网 bind 上 ——"
echo "     靠安全组挡着，别顺手把它也放行了，那样 /internal 就露出去了"
echo "  3) .env 里的 SELF_NODE_ID / 显示名 / 身份名改成自己的，然后 systemctl restart $SERVICE"
