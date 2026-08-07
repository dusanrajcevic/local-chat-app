function createClipboardController({
  state,
  el,
  doc = document,
  win = window,
  navigatorRef,
  exportService,
  getBotName,
  announceStatus = () => {}
}) {
  const nav = navigatorRef || (typeof navigator !== 'undefined' ? navigator : null);

  async function copyTextToClipboard(text) {
    try {
      await nav.clipboard.writeText(text);
    } catch {
      const textarea = doc.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      doc.body.appendChild(textarea);
      textarea.select();
      doc.execCommand('copy');
      doc.body.removeChild(textarea);
    }
  }

  function flashButtonText(button, text = 'Copied!') {
    if (!button) return;
    const originalText = button.textContent;
    button.textContent = text;
    setTimeout(() => {
      button.textContent = originalText;
    }, 1200);
  }

  async function copyMessageMarkdown(messageId, button = null) {
    if (!state.currentSession) return;
    const message = state.currentSession.messages.find((msg) => msg.id === messageId);
    if (!message) return;

    await copyTextToClipboard(message.text);
    flashButtonText(button);
    announceStatus('Message copied to clipboard.');
  }

  function selectedMessageMarkdown(selection) {
    if (!state.currentSession || !selection || selection.isCollapsed) return '';

    const selectionIntersectsMessageText = Array.from(doc.querySelectorAll('[data-message-id]')).some((node) => {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        if (range.intersectsNode(node)) return true;
      }

      return false;
    });

    return selectionIntersectsMessageText ? selection.toString() : '';
  }

  async function copyEntireChat() {
    if (!state.currentSession) return;
    const text = exportService.buildChatExportText(state.currentSession, { getBotName });
    await copyTextToClipboard(text);
    flashButtonText(el.copyChatBtn);
    announceStatus('Chat copied to clipboard.');
  }

  function handleCopyEvent(event) {
    const selection = win.getSelection();
    const markdown = selectedMessageMarkdown(selection);
    if (!markdown) return;

    event.preventDefault();
    event.clipboardData.setData('text/plain', markdown);
  }

  return {
    copyTextToClipboard,
    flashButtonText,
    copyMessageMarkdown,
    selectedMessageMarkdown,
    copyEntireChat,
    handleCopyEvent
  };
}

export { createClipboardController };
