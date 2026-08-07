const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function createModalController({ state, el, doc = document, raf } = {}) {
  const scheduleFrame =
    raf ||
    (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (callback) => setTimeout(callback, 0));
  let activeModal = null;
  let returnFocusElement = null;

  function isModalVisible(modal) {
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  function syncModalOpenClass() {
    const modalOpen =
      isModalVisible(el.editMessageModal) ||
      isModalVisible(el.appPromptModal) ||
      isModalVisible(el.extensionPairingModal);

    doc.body.classList.toggle('modal-open', modalOpen);
    el.appShell?.toggleAttribute('inert', modalOpen);
  }

  function rememberReturnFocus() {
    const current = doc.activeElement;
    returnFocusElement = current && current !== doc.body && typeof current.focus === 'function' ? current : null;
  }

  function restoreFocus() {
    const target = returnFocusElement;
    returnFocusElement = null;
    if (!target || !doc.documentElement.contains(target) || typeof target.focus !== 'function') return;
    scheduleFrame(() => target.focus());
  }

  function showModal(modal, initialFocus) {
    rememberReturnFocus();
    activeModal = modal;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenClass();

    scheduleFrame(() => {
      if (typeof initialFocus?.focus === 'function') initialFocus.focus();
    });
  }

  function hideModal(modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (activeModal === modal) activeModal = null;
    syncModalOpenClass();
    restoreFocus();
  }

  function focusableElements(modal) {
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (node) => !node.hasAttribute('disabled') && node.getAttribute('aria-hidden') !== 'true'
    );
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return false;

    const modal = activeModal && isModalVisible(activeModal) ? activeModal : null;
    if (!modal) return false;

    const focusable = focusableElements(modal);
    if (!focusable.length) {
      event.preventDefault();
      return true;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    const current = doc.activeElement;

    if (event.shiftKey && (current === first || !modal.contains(current))) {
      event.preventDefault();
      last.focus();
      return true;
    }

    if (!event.shiftKey && (current === last || !modal.contains(current))) {
      event.preventDefault();
      first.focus();
      return true;
    }

    return false;
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
    showModal(el.appPromptModal, el.appPromptInput);

    scheduleFrame(() => el.appPromptInput.select());

    return new Promise((resolve) => {
      state.activePromptResolve = resolve;
    });
  }

  function closeTextPrompt(value = null) {
    const resolve = state.activePromptResolve;
    state.activePromptResolve = null;
    hideModal(el.appPromptModal);
    if (resolve) resolve(value);
  }

  function submitTextPrompt() {
    closeTextPrompt(el.appPromptInput.value);
  }

  function openEditMessageModal(message) {
    state.editingMessageId = message.id;
    el.editMessageTextarea.value = message.text;
    showModal(el.editMessageModal, el.editMessageTextarea);

    scheduleFrame(() => {
      el.editMessageTextarea.selectionStart = el.editMessageTextarea.value.length;
      el.editMessageTextarea.selectionEnd = el.editMessageTextarea.value.length;
    });
  }

  function closeEditMessageModal() {
    state.editingMessageId = null;
    el.editMessageTextarea.value = '';
    hideModal(el.editMessageModal);
  }

  function openExtensionPairingModal() {
    showModal(el.extensionPairingModal, el.copyExtensionPairingCodeBtn);
  }

  function closeExtensionPairingModal() {
    hideModal(el.extensionPairingModal);
  }

  function isEditingMessage() {
    return state.editingMessageId || !el.editMessageModal.classList.contains('hidden');
  }

  return {
    isModalVisible,
    syncModalOpenClass,
    trapFocus,
    openTextPrompt,
    closeTextPrompt,
    submitTextPrompt,
    openEditMessageModal,
    closeEditMessageModal,
    openExtensionPairingModal,
    closeExtensionPairingModal,
    isEditingMessage
  };
}

export { createModalController };
