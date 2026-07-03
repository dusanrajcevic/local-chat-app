const { STATE_FILE } = require('../config');
const { ensureBaseFiles, readJson, writeJson, withLock } = require('./file-store');

async function getAppState() {
  await ensureBaseFiles();
  return readJson(STATE_FILE, { activeSessionId: null, updatedAt: null });
}

async function setActiveSessionId(sessionId) {
  return withLock(STATE_FILE, async () => {
    const state = await getAppState();
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
