function createModalController({ state, el, doc = document, raf } = {}) {
  const scheduleFrame =
    raf ||
    (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (callback) => setTimeout(callback, 0));

  function isModalVisible(modal) {
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  function syncModalOpenClass() {
    doc.body.classList.toggle('modal-open', isModalVisible(el.editMessageModal) || isModalVisible(el.appPromptModal));
  }

  function openTextPrompt({
    eyebrow = 'Name required',
    title = 'Enter a name',
    label = 'Name',
    defaultValue = '',
    submitText = 'Save'
  } = {}) {
    if (state.activePromptResolve) {
      state.activePromptResolve(null);
      state.activePromptResolve = null;
    }

    el.appPromptEyebrow.textContent = eyebrow;
    el.appPromptTitle.textContent = title;
    el.appPromptLabel.textContent = label;
    el.appPromptInput.value = defaultValue || '';
    el.saveAppPromptBtn.textContent = submitText;
    el.appPromptModal.classList.remove('hidden');
    el.appPromptModal.setAttribute('aria-hidden', 'false');
    syncModalOpenClass();

    scheduleFrame(() => {
      el.appPromptInput.focus();
      el.appPromptInput.select();
    });

    return new Promise((resolve) => {
      state.activePromptResolve = resolve;
    });
  }

  function closeTextPrompt(value = null) {
    if (!state.activePromptResolve) return;

    const resolve = state.activePromptResolve;
    state.activePromptResolve = null;
    el.appPromptModal.classList.add('hidden');
    el.appPromptModal.setAttribute('aria-hidden', 'true');
    syncModalOpenClass();
    resolve(value);
  }

  function submitTextPrompt() {
    closeTextPrompt(el.appPromptInput.value);
  }

  function openEditMessageModal(message) {
    state.editingMessageId = message.id;
    el.editMessageTextarea.value = message.text;
    el.editMessageModal.classList.remove('hidden');
    el.editMessageModal.setAttribute('aria-hidden', 'false');
    syncModalOpenClass();

    scheduleFrame(() => {
      el.editMessageTextarea.focus();
      el.editMessageTextarea.selectionStart = el.editMessageTextarea.value.length;
      el.editMessageTextarea.selectionEnd = el.editMessageTextarea.value.length;
    });
  }

  function closeEditMessageModal() {
    state.editingMessageId = null;
    el.editMessageTextarea.value = '';
    el.editMessageModal.classList.add('hidden');
    el.editMessageModal.setAttribute('aria-hidden', 'true');
    syncModalOpenClass();
  }

  function isEditingMessage() {
    return state.editingMessageId || !el.editMessageModal.classList.contains('hidden');
  }

  return {
    isModalVisible,
    syncModalOpenClass,
    openTextPrompt,
    closeTextPrompt,
    submitTextPrompt,
    openEditMessageModal,
    closeEditMessageModal,
    isEditingMessage
  };
}

export { createModalController };
