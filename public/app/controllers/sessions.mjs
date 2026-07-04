function createSessionController({ state, api, view, modal, stateUtils, active, refreshAll, alertUser, confirmUser }) {
  const getBotName = stateUtils.getBotName;

  async function openSession(sessionId, options = {}) {
    const { markActive = true } = options;
    state.currentSession = await api(`/api/sessions/${sessionId}`);
    if (markActive && !state.currentSession.trashed) await active.markActiveSession(sessionId);
    active.rememberOpenSession(sessionId);
    view.renderPinSelect();
    view.renderSessions();
    view.renderMessages();
  }

  async function createSession() {
    const title = await modal.openTextPrompt({
      eyebrow: 'New session',
      title: 'Name the new local chat',
      label: 'Session name',
      submitText: 'Create session'
    });
    if (!title || !title.trim()) return;
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: title.trim(),
        pinnedFolderId: state.selectedFolderId && state.selectedFolderId !== 'unfiled' ? state.selectedFolderId : null
      })
    });
    await refreshAll();
    await openSession(session.id);
  }

  async function getSessionForRename(sessionId) {
    let session =
      state.currentSession?.id === sessionId
        ? state.currentSession
        : state.sessions.find((item) => item.id === sessionId) || state.trash.find((item) => item.id === sessionId);

    if (!session || !session.title) session = await api(`/api/sessions/${sessionId}`);
    return session;
  }

  async function renameSession(sessionId = state.currentSession?.id) {
    if (!sessionId) return;
    const session = await getSessionForRename(sessionId);
    const title = await modal.openTextPrompt({
      eyebrow: 'Rename session',
      title: 'Rename local chat',
      label: 'Session name',
      defaultValue: session.title || '',
      submitText: 'Rename'
    });
    if (title === null) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return alertUser('Session name cannot be empty.');

    const updatedSession = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: trimmedTitle })
    });

    if (state.currentSession?.id === sessionId) {
      state.currentSession.title = updatedSession.title;
      state.currentSession.updatedAt = updatedSession.updatedAt;
      view.renderMessages();
      view.renderPinSelect();
    }

    await refreshAll();
  }

  async function renameBotName(sessionId = state.currentSession?.id) {
    if (!sessionId) return;

    let session =
      state.currentSession?.id === sessionId
        ? state.currentSession
        : state.sessions.find((item) => item.id === sessionId) || state.trash.find((item) => item.id === sessionId);

    if (!session) session = await api(`/api/sessions/${sessionId}`);

    const currentName = getBotName(session);
    const name = await modal.openTextPrompt({
      eyebrow: 'AI name',
      title: 'Set the AI bot name',
      label: 'AI bot name',
      defaultValue: currentName,
      submitText: 'Save name'
    });
    if (name === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) return alertUser('AI bot name cannot be empty.');
    if (trimmedName === currentName) return;

    await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ aiName: trimmedName })
    });

    if (state.currentSession?.id === sessionId) {
      state.currentSession = await api(`/api/sessions/${sessionId}`);
      view.renderPinSelect();
      view.renderMessages();
    }

    await refreshAll();
  }

  async function pinCurrentSession(folderId) {
    if (!state.currentSession) return;
    await api(`/api/sessions/${state.currentSession.id}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinnedFolderId: folderId || null })
    });
    await openSession(state.currentSession.id);
    await refreshAll();
  }

  async function trashSession(sessionId) {
    if (!confirmUser('Move this conversation to trash?')) return;
    await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (state.currentSession?.id === sessionId) {
      state.currentSession = null;
      active.rememberOpenSession(null);
      await active.clearActiveSession();
    }
    await refreshAll();
    view.renderMessages();
  }

  async function restoreSession(sessionId) {
    await api(`/api/trash/${sessionId}/restore`, { method: 'POST' });
    await refreshAll();
  }

  async function deleteTrashSession(sessionId) {
    if (!confirmUser('Permanently delete this conversation from trash?')) return;
    await api(`/api/trash/${sessionId}`, { method: 'DELETE' });
    if (state.currentSession?.id === sessionId) {
      state.currentSession = null;
      active.rememberOpenSession(null);
      await active.clearActiveSession();
    }
    await refreshAll();
    view.renderMessages();
  }

  return {
    openSession,
    createSession,
    getSessionForRename,
    renameSession,
    renameBotName,
    pinCurrentSession,
    trashSession,
    restoreSession,
    deleteTrashSession
  };
}

export { createSessionController };
