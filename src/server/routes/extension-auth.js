const { appError } = require('../errors');
const { isSameRequestOrigin } = require('../middleware/security');
const { requireJsonObjectBody } = require('../middleware/request-body');
const { createPairingCode, pairExtension, extensionIdFromOrigin } = require('../services/extension-auth-service');

function registerExtensionAuthRoutes(app) {
  app.post('/api/extension/pairing-code', requireJsonObjectBody, (req, res, next) => {
    try {
      const origin = req.get('origin');
      if (origin && !isSameRequestOrigin(origin, req)) {
        throw appError(403, 'Pairing codes can only be created from the local app.');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(createPairingCode());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/extension/pair', requireJsonObjectBody, async (req, res, next) => {
    try {
      const origin = req.get('origin');
      if (!extensionIdFromOrigin(origin)) {
        throw appError(403, 'Pairing requests must come from a browser extension.');
      }

      const result = await pairExtension({
        origin,
        extensionIdHeader: req.get('x-local-chat-extension-id'),
        code: req.body.code
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerExtensionAuthRoutes };
