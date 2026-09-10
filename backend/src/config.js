require('dotenv').config();

const config = {
  PHASE: parseInt(process.env.PHASE || '1', 10),
  PORT: parseInt(process.env.PORT || '3000', 10),
  SELF_SERVER_URL: (process.env.SELF_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
  SELF_NODE_ID: process.env.SELF_NODE_ID || 'local_node',
  SELF_DISPLAY_NAME: process.env.SELF_DISPLAY_NAME || 'Local Node',
  SELF_HUMAN_ID: process.env.SELF_HUMAN_ID || 'local_human',
  SELF_HUMAN_NAME: process.env.SELF_HUMAN_NAME || 'Me',
  SELF_AI_ID: process.env.SELF_AI_ID || 'local_ai',
  SELF_AI_NAME: process.env.SELF_AI_NAME || 'AI',
  DB_PATH: process.env.DB_PATH || './data/moments.db',
  SIGNATURE_WINDOW_SECONDS: parseInt(process.env.SIGNATURE_WINDOW_SECONDS || '300', 10),
  FRIEND_REQUEST_RATE_LIMIT: parseInt(process.env.FRIEND_REQUEST_RATE_LIMIT || '5', 10),
  MAX_EXCHANGE_ROUNDS: parseInt(process.env.MAX_EXCHANGE_ROUNDS || '2', 10),
  HANDSHAKE_TOKEN_TTL_SECONDS: parseInt(process.env.HANDSHAKE_TOKEN_TTL_SECONDS || '600', 10),
  // 前端管理通道：为空则 /api/admin/* 整体不可用
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  // 每 IP 每小时。前端会轮询待审列表，60 太紧（每分钟一次就打满），给到 600
  ADMIN_RATE_LIMIT: parseInt(process.env.ADMIN_RATE_LIMIT || '600', 10),
  ADMIN_CORS_ORIGINS: (process.env.ADMIN_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
};

module.exports = config;
