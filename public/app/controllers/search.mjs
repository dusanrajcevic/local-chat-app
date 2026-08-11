const RECENT_CHAT_LIMIT = 12;
const SEARCH_CHAT_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 180;

function normalizeSearchDisplayText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSearchDate(value, locale) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale || undefined, {
    month: 'short',
    day: 'numeric'
  });
}

function highlightSegments(value, query) {
  const text = normalizeSearchDisplayText(value);
  const needle = normalizeSearchDisplayText(query);
  if (!text || !needle) return text ? [{ text, match: false }] : [];

  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const segments = [];
  let cursor = 0;

  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }

  return segments;
}

function createSearchController({ api, el, modal, openSession, doc = document, win = window }) {
  let searchTimer = null;
  let requestVersion = 0;

  function setBusy(busy) {
    el.chatSearchResults.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function updateClearButton() {
    const empty = !el.chatSearchInput.value.trim();
    el.clearChatSearchBtn.hidden = empty;
    el.chatSearchToolbarDivider.hidden = empty;
  }

  function appendHighlighted(parent, text, query) {
    for (const segment of highlightSegments(text, query)) {
      const node = segment.match ? doc.createElement('strong') : doc.createTextNode(segment.text);
      if (segment.match) {
        node.className = 'chat-search-match';
        node.textContent = segment.text;
      }
      parent.append(node);
    }
  }

  function createResult(item, query) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'chat-search-result';
    button.dataset.searchSessionId = item.id;

    const icon = doc.createElement('span');
    icon.className = 'chat-search-result-icon';
    icon.setAttribute('aria-hidden', 'true');

    const body = doc.createElement('span');
    body.className = 'chat-search-result-body';

    const title = doc.createElement('span');
    title.className = 'chat-search-result-title';
    title.textContent = item.title || 'Untitled chat';
    body.append(title);

    const previewText = query ? item.match?.preview || '' : '';
    if (previewText) {
      const preview = doc.createElement('span');
      preview.className = 'chat-search-result-preview';
      appendHighlighted(preview, previewText, query);
      body.append(preview);
    }

    button.append(icon, body);

    if (query) {
      const date = doc.createElement('time');
      date.className = 'chat-search-result-date';
      date.dateTime = item.updatedAt || item.createdAt || '';
      date.textContent = formatSearchDate(item.updatedAt || item.createdAt, doc.documentElement.lang);
      button.append(date);
    }

    return button;
  }

  function renderResults(items, query = '') {
    el.chatSearchResults.replaceChildren();

    if (!items.length) {
      const empty = doc.createElement('p');
      empty.className = 'chat-search-empty';
      empty.textContent = query ? `No chats found for “${query}”.` : 'No recent chats yet.';
      el.chatSearchResults.append(empty);
      return;
    }

    const fragment = doc.createDocumentFragment();
    for (const item of items) fragment.append(createResult(item, query));
    el.chatSearchResults.append(fragment);
  }

  function renderFailure() {
    el.chatSearchResults.replaceChildren();
    const message = doc.createElement('p');
    message.className = 'chat-search-empty';
    message.textContent = 'Search is temporarily unavailable.';
    el.chatSearchResults.append(message);
  }

  async function loadRecentChats() {
    const version = ++requestVersion;
    el.chatSearchHeading.textContent = 'Recent chats';
    setBusy(true);
    try {
      const recent = await api(`/api/recent-chats?limit=${RECENT_CHAT_LIMIT}`);
      if (version !== requestVersion) return;
      renderResults(recent);
    } catch (error) {
      if (version !== requestVersion) return;
      renderFailure();
      throw error;
    } finally {
      if (version === requestVersion) setBusy(false);
    }
  }

  async function runSearch(query) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return loadRecentChats();

    const version = ++requestVersion;
    el.chatSearchHeading.textContent = 'Search results';
    setBusy(true);
    try {
      const response = await api(
        `/api/search-chats?q=${encodeURIComponent(normalizedQuery)}&limit=${SEARCH_CHAT_LIMIT}`
      );
      if (version !== requestVersion) return;
      renderResults(response.results || [], normalizedQuery);
    } catch (error) {
      if (version !== requestVersion) return;
      renderFailure();
      throw error;
    } finally {
      if (version === requestVersion) setBusy(false);
    }
  }

  function scheduleSearch() {
    updateClearButton();
    if (searchTimer) {
      win.clearTimeout(searchTimer);
      searchTimer = null;
    }
    const query = el.chatSearchInput.value.trim();
    if (!query) {
      loadRecentChats().catch(() => {});
      return;
    }

    searchTimer = win.setTimeout(() => {
      searchTimer = null;
      runSearch(query).catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
  }

  function openChatSearch() {
    if (searchTimer) win.clearTimeout(searchTimer);
    requestVersion += 1;
    el.chatSearchInput.value = '';
    updateClearButton();
    modal.openSearchModal();
    loadRecentChats().catch(() => {});
  }

  function closeChatSearch() {
    if (searchTimer) {
      win.clearTimeout(searchTimer);
      searchTimer = null;
    }
    requestVersion += 1;
    modal.closeSearchModal();
  }

  function clearChatSearch() {
    if (searchTimer) {
      win.clearTimeout(searchTimer);
      searchTimer = null;
    }
    el.chatSearchInput.value = '';
    updateClearButton();
    el.chatSearchInput.focus();
    loadRecentChats().catch(() => {});
  }

  async function openSearchResult(sessionId) {
    if (!sessionId) return;
    await openSession(sessionId);
    closeChatSearch();
  }

  async function openFirstSearchResult() {
    const first = el.chatSearchResults.querySelector('[data-search-session-id]');
    if (!first) return false;
    await openSearchResult(first.dataset.searchSessionId);
    return true;
  }

  return {
    openChatSearch,
    closeChatSearch,
    clearChatSearch,
    scheduleSearch,
    openSearchResult,
    openFirstSearchResult,
    loadRecentChats,
    runSearch
  };
}

export {
  RECENT_CHAT_LIMIT,
  normalizeSearchDisplayText,
  SEARCH_CHAT_LIMIT,
  SEARCH_DEBOUNCE_MS,
  formatSearchDate,
  highlightSegments,
  createSearchController
};
