require('dotenv').config();

module.exports = {
  PHASE: parseInt(process.env.PHASE || '1', 10),
  PORT: parseInt(process.env.PORT || '3000', 10),
  SELF_SERVER_URL: process.env.SELF_SERVER_URL || 'http://localhost:3000',
  SELF_NODE_ID: process.env.SELF_NODE_ID || 'self_node',
  SELF_DISPLAY_NAME: process.env.SELF_DISPLAY_NAME || 'Me',
  DB_PATH: process.env.DB_PATH || './data/moments.db',
  SIGNATURE_WINDOW_SECONDS: parseInt(process.env.SIGNATURE_WINDOW_SECONDS || '300', 10),
  FRIEND_REQUEST_RATE_LIMIT: parseInt(process.env.FRIEND_REQUEST_RATE_LIMIT || '5', 10),
  MAX_EXCHANGE_ROUNDS: parseInt(process.env.MAX_EXCHANGE_ROUNDS || '2', 10),
};
