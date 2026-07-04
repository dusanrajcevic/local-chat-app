function createActiveSessionController({
  state,
  api,
  view,
  modal,
  storage,
  win = window,
  doc = document,
  refreshAll,
  openSession
}) {
  let externalActiveSessionSyncRunning = false;
  let externalSyncTimer = null;

  async function markActiveSession(sessionId) {
    if (!sessionId) return;
    try {
      await api('/api/active-session', {
        method: 'PUT',
        body: JSON.stringify({ sessionId })
      });
    } catch (err) {
      console.warn('Could not update active session:', err.message);
    }
  }

  async function clearActiveSession() {
    try {
      await api('/api/active-session', { method: 'DELETE' });
    } catch (err) {
      console.warn('Could not clear active session:', err.message);
    }
  }

  function rememberOpenSession(sessionId) {
    if (!sessionId) {
      storage.removeItem('currentSessionId');
      storage.removeItem('currentSessionSavedAt');
      return;
    }

    storage.setItem('currentSessionId', sessionId);
    storage.setItem('currentSessionSavedAt', new Date().toISOString());
  }

  function getRememberedOpenSession() {
    const sessionId = storage.getItem('currentSessionId');
    if (!sessionId) return null;

    return {
      sessionId,
      updatedAt: storage.getItem('currentSessionSavedAt') || null
    };
  }

  async function getActiveSessionState() {
    try {
      return await api('/api/active-session');
    } catch (err) {
      console.warn('Could not read active session:', err.message);
      return { sessionId: null, session: null, updatedAt: null };
    }
  }

  function newerSessionChoice(active, remembered) {
    if (!active?.sessionId) return remembered?.sessionId || null;
    if (!remembered?.sessionId) return active.sessionId;

    const activeTime = active.updatedAt ? new Date(active.updatedAt).getTime() : 0;
    const rememberedTime = remembered.updatedAt ? new Date(remembered.updatedAt).getTime() : 0;

    return rememberedTime > activeTime ? remembered.sessionId : active.sessionId;
  }

  async function restoreOpenSession() {
    const active = await getActiveSessionState();
    const remembered = getRememberedOpenSession();
    const sessionId = newerSessionChoice(active, remembered);

    if (!sessionId) return;

    try {
      await openSession(sessionId);
    } catch (err) {
      if (sessionId !== active.sessionId && active.sessionId) {
        await openSession(active.sessionId);
        return;
      }

      rememberOpenSession(null);
      console.warn('Could not restore open session:', err.message);
    }
  }

  async function syncExternalActiveSession() {
    if (externalActiveSessionSyncRunning || modal.isEditingMessage() || state.currentSession?.trashed) return;
    externalActiveSessionSyncRunning = true;

    try {
      const active = await getActiveSessionState();
      const activeSessionId = active?.sessionId || null;
      const currentSessionId = state.currentSession?.id || null;

      if (activeSessionId && activeSessionId !== currentSessionId) {
        await refreshAll();
        await openSession(activeSessionId, { markActive: false });
        return;
      }

      if (!activeSessionId && currentSessionId) {
        state.currentSession = null;
        rememberOpenSession(null);
        view.renderPinSelect();
        view.renderSessions();
        view.renderMessages();
        return;
      }

      if (activeSessionId && currentSessionId === activeSessionId) {
        const latestSession = await api(`/api/sessions/${activeSessionId}`);
        const messageCountChanged =
          (latestSession.messages || []).length !== (state.currentSession.messages || []).length;
        const updatedAtChanged = latestSession.updatedAt !== state.currentSession.updatedAt;

        if (messageCountChanged || updatedAtChanged) {
          state.currentSession = latestSession;
          rememberOpenSession(activeSessionId);
          await refreshAll();
          view.renderPinSelect();
          view.renderSessions();
          view.renderMessages();
        }
      }
    } catch (err) {
      console.warn('Could not sync active session:', err.message);
    } finally {
      externalActiveSessionSyncRunning = false;
    }
  }

  function startExternalActiveSessionSync() {
    win.addEventListener('focus', () => syncExternalActiveSession());
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden) syncExternalActiveSession();
    });
    externalSyncTimer = win.setInterval(syncExternalActiveSession, 2500);
    return externalSyncTimer;
  }

  return {
    markActiveSession,
    clearActiveSession,
    rememberOpenSession,
    getRememberedOpenSession,
    getActiveSessionState,
    newerSessionChoice,
    restoreOpenSession,
    syncExternalActiveSession,
    startExternalActiveSessionSync
  };
}

export { createActiveSessionController };
