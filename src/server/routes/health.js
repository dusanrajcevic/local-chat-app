const { AUTH_TOKEN } = require('../config');

function registerHealthRoutes(app) {
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      authRequired: true,
      manualTokenConfigured: Boolean(AUTH_TOKEN)
    });
  });
}

module.exports = { registerHealthRoutes };
