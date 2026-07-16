const { STATE_FILE } = require('../config');
const { ensureBaseFiles, writeJson, withLock } = require('./file-store');
const { CURRENT_SCHEMA_VERSION, readStateDocument } = require('./record-validation');

async function getAppState() {
  await ensureBaseFiles();
  return readStateDocument(STATE_FILE);
}

async function setActiveSessionId(sessionId) {
  return withLock(STATE_FILE, async () => {
    const state = await getAppState();
    state.schemaVersion = CURRENT_SCHEMA_VERSION;
    state.activeSessionId = sessionId || null;
    state.updatedAt = new Date().toISOString();
    await writeJson(STATE_FILE, state);
    return state;
  });
}

async function clearActiveSessionIf(sessionId) {
  const state = await getAppState();
  if (state.activeSessionId === sessionId) await setActiveSessionId(null);
}

module.exports = { getAppState, setActiveSessionId, clearActiveSessionIf };
