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

  function flashMessageActionIcon(button) {
    if (!button?.classList?.contains('message-action-icon')) return false;

    button.dataset.copied = 'true';
    const resetTimer = setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.copied;
    }, 1200);
    resetTimer?.unref?.();
    return true;
  }

  async function copyMessageMarkdown(messageId, button = null) {
    if (!state.currentSession) return;
    const message = state.currentSession.messages.find((msg) => msg.id === messageId);
    if (!message) return;

    await copyTextToClipboard(message.text);
    if (!flashMessageActionIcon(button)) flashButtonText(button);
    announceStatus('Message copied to clipboard.');
  }

  async function copyCodeBlock(button) {
    const code = button?.closest('.code-block')?.querySelector('pre code');
    if (!code) return;

    await copyTextToClipboard(code.textContent || '');
    button.dataset.copied = 'true';
    button.setAttribute('aria-label', 'Code copied');
    button.title = 'Copied';
    announceStatus('Code copied to clipboard.');

    const resetTimer = setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.copied;
      button.setAttribute('aria-label', 'Copy code');
      button.title = 'Copy code';
    }, 1200);
    resetTimer?.unref?.();
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
    flashMessageActionIcon,
    copyMessageMarkdown,
    copyCodeBlock,
    selectedMessageMarkdown,
    copyEntireChat,
    handleCopyEvent
  };
}

export { createClipboardController };
