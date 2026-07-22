const { SESSION_ID_PATTERN } = require('../config');
const { appError } = require('../errors');
const { requireJsonObjectBody } = require('../middleware/request-body');
const { validateId } = require('../validation');
const { asyncRoute } = require('./helpers');
const { getAppState, setActiveSessionId } = require('../storage/state-store');
const { findSessionFile } = require('../storage/file-store');
const { readSessionRecord } = require('../storage/record-validation');
const { summarizeSession } = require('../services/session-format');

function registerActiveSessionRoutes(app) {
  app.get(
    '/api/active-session',
    asyncRoute(async (req, res) => {
      const state = await getAppState();
      const activeSessionId = state.activeSessionId || null;

      if (!activeSessionId) {
        return res.json({ sessionId: null, session: null, updatedAt: state.updatedAt || null });
      }

      const found = await findSessionFile(activeSessionId);
      if (!found) {
        await setActiveSessionId(null);
        return res.json({ sessionId: null, session: null, updatedAt: state.updatedAt || null });
      }

      const session = await readSessionRecord(found.filePath, { expectedId: activeSessionId });
      res.json({
        sessionId: activeSessionId,
        session: summarizeSession(session, found.dateDir),
        updatedAt: state.updatedAt || null
      });
    })
  );

  app.put(
    '/api/active-session',
    requireJsonObjectBody,
    asyncRoute(async (req, res) => {
      const sessionId = validateId(req.body.sessionId, SESSION_ID_PATTERN, 'Session ID');
      const found = await findSessionFile(sessionId);
      if (!found) throw appError(404, 'Session not found.');

      const session = await readSessionRecord(found.filePath, { expectedId: sessionId });
      await setActiveSessionId(sessionId);
      res.json({
        ok: true,
        sessionId,
        session: summarizeSession(session, found.dateDir),
        updatedAt: new Date().toISOString()
      });
    })
  );

  app.delete(
    '/api/active-session',
    asyncRoute(async (req, res) => {
      await setActiveSessionId(null);
      res.json({ ok: true, sessionId: null, session: null });
    })
  );
}

module.exports = { registerActiveSessionRoutes };
