const { requireJsonObjectBody } = require('../middleware/request-body');
const { asyncRoute } = require('./helpers');
const { normalizeLimit, searchResponse } = require('../services/search-service');
const {
  listSessions,
  recentChats,
  createSession,
  updateSessionMetadata,
  updateBotName,
  getSessionExport,
  readSession,
  addMessage,
  updateMessage,
  deleteMessage,
  pinSession,
  moveSessionToTrash
} = require('../services/session-service');

function registerSessionRoutes(app) {
  app.get(
    '/api/sessions',
    asyncRoute(async (req, res) => {
      res.json(await listSessions());
    })
  );

  app.get(
    '/api/recent-chats',
    asyncRoute(async (req, res) => {
      res.json(await recentChats(normalizeLimit(req.query.limit || 100)));
    })
  );

  app.get(
    '/api/search-chats',
    asyncRoute(async (req, res) => {
      res.json(await searchResponse(req.query.q || req.query.query || '', req.query.limit || 100));
    })
  );

  app.post(
    '/api/sessions',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.status(201).json(await createSession(req.body));
    })
  );

  app.patch(
    '/api/sessions/:sessionId',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.json(await updateSessionMetadata(req.params.sessionId, req.body));
    })
  );

  app.patch(
    '/api/sessions/:sessionId/bot-name',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.json(await updateBotName(req.params.sessionId, req.body));
    })
  );

  app.get(
    '/api/sessions/:sessionId/export',
    asyncRoute(async (req, res) => {
      res.json(await getSessionExport(req.params.sessionId));
    })
  );

  app.get(
    '/api/sessions/:sessionId',
    asyncRoute(async (req, res) => {
      res.json(await readSession(req.params.sessionId));
    })
  );

  app.post(
    '/api/sessions/:sessionId/messages',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      const { message, created } = await addMessage(req.params.sessionId, req.body, req.get('Idempotency-Key'));
      res.status(created ? 201 : 200).json(message);
    })
  );

  app.patch(
    '/api/sessions/:sessionId/messages/:messageId',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.json(await updateMessage(req.params.sessionId, req.params.messageId, req.body));
    })
  );

  app.delete(
    '/api/sessions/:sessionId/messages/:messageId',
    asyncRoute(async (req, res) => {
      await deleteMessage(req.params.sessionId, req.params.messageId);
      res.json({ ok: true });
    })
  );

  app.patch(
    '/api/sessions/:sessionId/pin',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.json(await pinSession(req.params.sessionId, req.body));
    })
  );

  app.delete(
    '/api/sessions/:sessionId',
    asyncRoute(async (req, res) => {
      await moveSessionToTrash(req.params.sessionId);
      res.json({ ok: true });
    })
  );
}

module.exports = { registerSessionRoutes };
