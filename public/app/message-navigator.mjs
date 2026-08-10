const DEFAULT_PREVIEW_WORDS = 8;

function normalizePreviewText(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, ' ')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createMessagePreview(value, maxWords = DEFAULT_PREVIEW_WORDS) {
  const text = normalizePreviewText(value);
  if (!text) return 'Empty message';

  const words = text.split(' ');
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function getNavigableMessages(session) {
  return (session?.messages || [])
    .filter((message) => message?.sender === 'me' && typeof message.id === 'string')
    .map((message, index) => ({
      id: message.id,
      number: index + 1,
      preview: createMessagePreview(message.text)
    }));
}

function createMessageNavigator({
  messagesElement,
  navigatorElement,
  raf = globalThis.requestAnimationFrame?.bind(globalThis) || ((callback) => callback())
} = {}) {
  if (!messagesElement || !navigatorElement) {
    return {
      render() {},
      syncActive() {},
      dispose() {}
    };
  }

  let entries = [];
  let activeMessageId = null;
  let framePending = false;

  function buttons() {
    return Array.from(navigatorElement.querySelectorAll('[data-message-nav-id]'));
  }

  function findArticle(messageId) {
    return Array.from(messagesElement.querySelectorAll('[data-chat-message-id]')).find(
      (article) => article.dataset.chatMessageId === messageId
    );
  }

  function applyActive(messageId) {
    if (!messageId) return;
    activeMessageId = messageId;

    for (const button of buttons()) {
      const isActive = button.dataset.messageNavId === messageId;
      button.classList.toggle('active', isActive);
      button.tabIndex = isActive ? 0 : -1;
      if (isActive) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }

  function syncActive() {
    framePending = false;
    if (!entries.length) return;

    const probe = messagesElement.scrollTop + Math.max(24, messagesElement.clientHeight * 0.32);
    let nextActive = entries[0].id;

    for (const entry of entries) {
      const article = findArticle(entry.id);
      if (!article) continue;
      if (article.offsetTop <= probe) nextActive = entry.id;
      else break;
    }

    applyActive(nextActive);
  }

  function scheduleActiveSync() {
    if (framePending) return;
    framePending = true;
    raf(syncActive);
  }

  function jumpTo(messageId) {
    const article = findArticle(messageId);
    if (!article) return;

    applyActive(messageId);
    article.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  function render(session) {
    entries = getNavigableMessages(session);
    activeMessageId = entries.at(-1)?.id || null;
    navigatorElement.replaceChildren();
    navigatorElement.hidden = entries.length === 0;
    navigatorElement.setAttribute(
      'aria-label',
      entries.length === 1
        ? 'Jump to your message in this conversation'
        : `Jump between your ${entries.length} messages in this conversation`
    );

    if (!entries.length) return;

    const doc = navigatorElement.ownerDocument;
    const list = doc.createElement('div');
    list.className = 'message-nav-list';
    list.setAttribute('role', 'list');

    for (const entry of entries) {
      const item = doc.createElement('div');
      item.setAttribute('role', 'listitem');

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'message-nav-item';
      button.dataset.messageNavId = entry.id;
      button.tabIndex = entry.id === activeMessageId ? 0 : -1;
      button.setAttribute('aria-label', `Jump to your message ${entry.number}: ${entry.preview}`);

      const preview = doc.createElement('span');
      preview.className = 'message-nav-preview';
      preview.textContent = entry.preview;
      preview.setAttribute('aria-hidden', 'true');

      const line = doc.createElement('span');
      line.className = 'message-nav-line';
      line.setAttribute('aria-hidden', 'true');

      button.append(preview, line);
      item.append(button);
      list.append(item);
    }

    navigatorElement.append(list);
    applyActive(activeMessageId);
    scheduleActiveSync();
  }

  function handleClick(event) {
    const button = event.target.closest?.('[data-message-nav-id]');
    if (!button || !navigatorElement.contains(button)) return;
    jumpTo(button.dataset.messageNavId);
  }

  function handleKeydown(event) {
    const current = event.target.closest?.('[data-message-nav-id]');
    if (!current || !navigatorElement.contains(current)) return;

    const items = buttons();
    const index = items.indexOf(current);
    let nextIndex = null;

    if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
    if (event.key === 'ArrowDown') nextIndex = Math.min(items.length - 1, index + 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    items[nextIndex]?.focus();
  }

  messagesElement.addEventListener('scroll', scheduleActiveSync, { passive: true });
  navigatorElement.addEventListener('click', handleClick);
  navigatorElement.addEventListener('keydown', handleKeydown);

  function dispose() {
    messagesElement.removeEventListener('scroll', scheduleActiveSync);
    navigatorElement.removeEventListener('click', handleClick);
    navigatorElement.removeEventListener('keydown', handleKeydown);
  }

  return {
    render,
    syncActive,
    jumpTo,
    dispose
  };
}

export {
  DEFAULT_PREVIEW_WORDS,
  normalizePreviewText,
  createMessagePreview,
  getNavigableMessages,
  createMessageNavigator
};
