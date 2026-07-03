const { asyncRoute } = require('./helpers');
const { listTrash, restoreSessionFromTrash, permanentlyDeleteTrashedSession } = require('../services/session-service');

function registerTrashRoutes(app) {
  app.get(
    '/api/trash',
    asyncRoute(async (req, res) => {
      res.json(await listTrash());
    })
  );

  app.post(
    '/api/trash/:sessionId/restore',
    asyncRoute(async (req, res) => {
      res.json(await restoreSessionFromTrash(req.params.sessionId));
    })
  );

  app.delete(
    '/api/trash/:sessionId',
    asyncRoute(async (req, res) => {
      await permanentlyDeleteTrashedSession(req.params.sessionId);
      res.json({ ok: true });
    })
  );
}

module.exports = { registerTrashRoutes };
