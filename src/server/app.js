const express = require('express');
const path = require('path');
const { ROOT_DIR, AUTH_TOKEN } = require('./config');
const { installSecurityMiddleware } = require('./middleware/security');
const { registerApiRoutes } = require('./routes');
const { errorHandler } = require('./errors');

function createApp() {
  const app = express();
  installSecurityMiddleware(app);
  app.use(express.json({ limit: process.env.LOCAL_CHAT_JSON_LIMIT || '2mb' }));
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  registerApiRoutes(app);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, AUTH_TOKEN };
