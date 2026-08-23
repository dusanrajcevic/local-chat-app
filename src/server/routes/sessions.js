const { requireJsonObjectBody } = require('../middleware/request-body');
const { asyncRoute } = require('./helpers');
const { searchResponse } = require('../services/search-service');
const { collectionRevision } = require('../storage/session-store');
const {
  paginationFromQuery,
  paginateItems,
  applyPaginationHeaders,
  collectionEtag,
  applyConditionalHeaders,
  sendNotModifiedIfFresh
} = require('../http/collection-response');
const {
  listSessions,
  createSession,
  upsertCompactedSession,
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

async function currentCollectionEtag(namespace, params = {}) {
  return collectionEtag(namespace, await collectionRevision(), params);
}

function searchPaginationHeaders(res, originalUrl, data) {
  applyPaginationHeaders(res, originalUrl, {
    total: data.total,
    offset: data.offset,
    limit: data.limit,
    hasMore: data.hasMore,
    nextOffset: data.nextOffset
  });
}

function registerSessionRoutes(app) {
  app.get(
    '/api/sessions',
    asyncRoute(async (req, res) => {
      const pagination = paginationFromQuery(req.query, {
        fallback: 100,
        max: 1000,
        unlimitedWhenOmitted: true
      });
      const etagParams = { offset: pagination.offset, limit: pagination.limit };
      const initialEtag = await currentCollectionEtag('sessions', etagParams);
      if (sendNotModifiedIfFresh(req, res, initialEtag)) return;

      const page = paginateItems(await listSessions(), pagination);
      applyPaginationHeaders(res, req.originalUrl, page);
      applyConditionalHeaders(res, await currentCollectionEtag('sessions', etagParams));
      res.json(page.items);
    })
  );

  app.get(
    '/api/recent-chats',
    asyncRoute(async (req, res) => {
      const pagination = paginationFromQuery(req.query, { fallback: 100, max: 500 });
      const etagParams = { offset: pagination.offset, limit: pagination.limit };
      const initialEtag = await currentCollectionEtag('recent-chats', etagParams);
      if (sendNotModifiedIfFresh(req, res, initialEtag)) return;

      const page = paginateItems(await listSessions(), pagination);
      applyPaginationHeaders(res, req.originalUrl, page);
      applyConditionalHeaders(res, await currentCollectionEtag('recent-chats', etagParams));
      res.json(page.items);
    })
  );

  app.get(
    '/api/search-chats',
    asyncRoute(async (req, res) => {
      const pagination = paginationFromQuery(req.query, { fallback: 100, max: 500 });
      const rawQuery = req.query.q || req.query.query || '';
      const etagParams = { query: String(rawQuery), offset: pagination.offset, limit: pagination.limit };
      const initialEtag = await currentCollectionEtag('search-chats', etagParams);
      if (sendNotModifiedIfFresh(req, res, initialEtag)) return;

      const data = await searchResponse(rawQuery, pagination.limit, pagination.offset);
      searchPaginationHeaders(res, req.originalUrl, data);
      applyConditionalHeaders(res, await currentCollectionEtag('search-chats', etagParams));
      res.json(data);
    })
  );

  app.post(
    '/api/sessions',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      res.status(201).json(await createSession(req.body));
    })
  );

  app.put(
    '/api/sessions/:sessionId/compaction',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      const result = await upsertCompactedSession(req.params.sessionId, req.body);
      res.status(result.created ? 201 : 200).json(result.session);
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
