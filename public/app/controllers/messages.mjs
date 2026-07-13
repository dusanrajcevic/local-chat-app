function createMessageController({
  state,
  el,
  api,
  modal,
  openSession,
  refreshAll,
  alertUser,
  confirmUser
}) {
  async function saveEditedMessage() {
    if (!state.currentSession || state.currentSession.trashed || !state.editingMessageId) return;

    const message = state.currentSession.messages.find((msg) => msg.id === state.editingMessageId);
    if (!message) return modal.closeEditMessageModal();

    const nextText = el.editMessageTextarea.value.trim();
    if (!nextText) return alertUser('Message cannot be empty.');

    await api(`/api/sessions/${state.currentSession.id}/messages/${message.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: nextText, sender: message.sender })
    });

    modal.closeEditMessageModal();
    await openSession(state.currentSession.id);
    await refreshAll();
  }

  async function sendMessage() {
    if (!state.currentSession || state.currentSession.trashed) return;
    const text = el.messageInput.value.trim();
    if (!text) return;

    const sender = el.isMeCheckbox.checked ? 'me' : 'bot';

    await api(`/api/sessions/${state.currentSession.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, sender })
    });
    state.nextSenderOverride = null;
    el.messageInput.value = '';
    await openSession(state.currentSession.id);
    await refreshAll();
  }

  async function deleteMessage(messageId) {
    if (!state.currentSession || state.currentSession.trashed) return;
    if (!confirmUser('Delete this message?')) return;

    await api(`/api/sessions/${state.currentSession.id}/messages/${messageId}`, { method: 'DELETE' });
    await openSession(state.currentSession.id);
    await refreshAll();
  }

  function openMessageForEdit(messageId) {
    if (!state.currentSession || state.currentSession.trashed) return;
    const message = state.currentSession.messages.find((msg) => msg.id === messageId);
    if (!message) return;
    modal.openEditMessageModal(message);
  }

  return {
    saveEditedMessage,
    sendMessage,
    deleteMessage,
    openMessageForEdit
  };
}

export { createMessageController };
