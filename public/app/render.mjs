function createRenderer({
  state,
  el,
  storage,
  escapeHtml,
  renderMarkdown,
  formatDate,
  getBotName,
  nextMessageSender,
  messageNavigator
}) {
  const htmlEscape = escapeHtml || ((value) => String(value || ''));
  const markdown = renderMarkdown || htmlEscape;
  const dateFormatter = formatDate || ((value) => String(value || ''));
  const botName = (session = state.currentSession) => (getBotName ? getBotName(session) : 'AI Bot');
  const expandedCompactedContexts = new Set();

  function applySidebarState() {
    el.appShell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    el.sidebarToggleBtn.textContent = state.sidebarCollapsed ? '→' : '←';
    el.sidebarToggleBtn.setAttribute('aria-label', state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar');
    el.sidebarToggleBtn.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
    el.sidebarToggleBtn.title = state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar';
    storage?.setItem('sidebarCollapsed', String(state.sidebarCollapsed));
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applySidebarState();
  }

  function renderFolders() {
    const base = `
      <button class="item folder-system-item ${state.selectedFolderId === null ? 'active' : ''}" data-folder="all" ${state.selectedFolderId === null ? 'aria-current="true"' : ''}>
        <span class="item-main"><span class="item-title">All conversations</span><span class="item-meta">Everything sorted by latest activity</span></span>
      </button>
      <button class="item folder-system-item ${state.selectedFolderId === 'unfiled' ? 'active' : ''}" data-folder="unfiled" ${state.selectedFolderId === 'unfiled' ? 'aria-current="true"' : ''}>
        <span class="item-main"><span class="item-title">Unfiled</span><span class="item-meta">No pinned folder</span></span>
      </button>
      <div class="folder-system-separator" aria-hidden="true"></div>
    `;

    const folders = state.folders
      .map(
        (folder) => `
      <div class="item ${state.selectedFolderId === folder.id ? 'active' : ''}">
        <button class="item-main bare" data-folder="${folder.id}" ${state.selectedFolderId === folder.id ? 'aria-current="true"' : ''}>
          <span class="item-title">${htmlEscape(folder.name)}</span>
          <span class="item-meta">Pinned chats</span>
        </button>
        <span class="item-actions" role="group" aria-label="Actions for ${htmlEscape(folder.name)}">
          <button class="icon-btn" data-rename-folder="${folder.id}" title="Rename folder" aria-label="Rename ${htmlEscape(folder.name)} folder">✎</button>
          <button class="icon-btn danger" data-delete-folder="${folder.id}" title="Delete folder" aria-label="Delete ${htmlEscape(folder.name)} folder">×</button>
        </span>
      </div>
    `
      )
      .join('');

    el.folderList.innerHTML = base + folders;
  }

  function renderPinSelect() {
    el.pinSelect.innerHTML =
      `<option value="">No pinned folder</option>` +
      state.folders.map((folder) => `<option value="${folder.id}">${htmlEscape(folder.name)}</option>`).join('');

    el.pinSelect.disabled = !state.currentSession || state.currentSession.trashed;
    if (state.currentSession) el.pinSelect.value = state.currentSession.pinnedFolderId || '';
  }

  function filteredSessions() {
    if (!state.selectedFolderId) return state.sessions;
    if (state.selectedFolderId === 'unfiled') return state.sessions.filter((s) => !s.pinnedFolderId);
    return state.sessions.filter((s) => s.pinnedFolderId === state.selectedFolderId);
  }

  function renderSessions() {
    const sessions = filteredSessions();
    if (!sessions.length) {
      el.sessionList.innerHTML = `<div class="item"><div class="item-main"><div class="item-title">No conversations</div><div class="item-meta">Create a new session</div></div></div>`;
      return;
    }

    el.sessionList.innerHTML = sessions
      .map(
        (session) => `
      <div class="item ${state.currentSession?.id === session.id ? 'active' : ''}">
        <button class="item-main bare" data-open-session="${session.id}" ${state.currentSession?.id === session.id ? 'aria-current="true"' : ''}>
          <span class="item-title">${htmlEscape(session.title)}</span>
          <span class="item-meta">${session.dateFolder} · ${session.messageCount} messages · ${dateFormatter(session.updatedAt)}</span>
        </button>
        <span class="item-actions" role="group" aria-label="Actions for ${htmlEscape(session.title)}">
          <button class="icon-btn" data-rename-session="${session.id}" title="Rename session" aria-label="Rename ${htmlEscape(session.title)} session">✎</button>
          <button class="icon-btn danger" data-trash-session="${session.id}" title="Move to trash" aria-label="Move ${htmlEscape(session.title)} to trash">×</button>
        </span>
      </div>
    `
      )
      .join('');
  }

  function renderTrash() {
    el.trashList.classList.toggle('hidden', !state.trashOpen);
    el.toggleTrashBtn.setAttribute('aria-expanded', String(state.trashOpen));
    if (!state.trash.length) {
      el.trashList.innerHTML = `<div class="item"><div class="item-main"><div class="item-title">Trash is empty</div></div></div>`;
      return;
    }

    el.trashList.innerHTML = state.trash
      .map(
        (session) => `
      <div class="item">
        <button class="item-main bare" data-open-session="${session.id}" ${state.currentSession?.id === session.id ? 'aria-current="true"' : ''}>
          <span class="item-title">${htmlEscape(session.title)}</span>
          <span class="item-meta">${session.messageCount} messages</span>
        </button>
        <span class="item-actions" role="group" aria-label="Actions for ${htmlEscape(session.title)}">
          <button class="icon-btn" data-rename-session="${session.id}" title="Rename session" aria-label="Rename ${htmlEscape(session.title)} session">✎</button>
          <button class="icon-btn" data-restore-session="${session.id}" title="Restore" aria-label="Restore ${htmlEscape(session.title)}">↩</button>
          <button class="icon-btn danger" data-delete-trash="${session.id}" title="Delete forever" aria-label="Permanently delete ${htmlEscape(session.title)}">×</button>
        </span>
      </div>
    `
      )
      .join('');
  }

  function syncSenderCheckbox() {
    const override = state.nextSenderOverride;
    const sender =
      override && override.sessionId === state.currentSession?.id
        ? override.sender
        : nextMessageSender(state.currentSession);

    el.isMeCheckbox.checked = sender === 'me';
    el.isMeCheckbox.disabled = !state.currentSession || state.currentSession.trashed;
  }

  function hasCompactedContext(session = state.currentSession) {
    return Boolean(
      session?.kind === 'compacted' &&
        typeof session.compaction?.text === 'string' &&
        session.compaction.text.trim()
    );
  }

  function renderCompactedContext(session = state.currentSession) {
    if (!hasCompactedContext(session)) return '';

    const expanded = expandedCompactedContexts.has(session.id);
    const sourceCount = session.compaction.sourceMessageCount;
    const sourceLabel = Number.isInteger(sourceCount)
      ? `${sourceCount} source message${sourceCount === 1 ? '' : 's'}`
      : 'Compacted history';

    return `
      <section class="compacted-context" aria-labelledby="compactedContextTitle">
        <button
          type="button"
          class="compacted-context-toggle"
          data-toggle-compacted-context
          aria-expanded="${expanded}"
          aria-controls="compactedContextContent"
        >
          <span class="compacted-context-heading">
            <span id="compactedContextTitle" class="compacted-context-title">Compacted context</span>
            <span class="compacted-context-meta">${htmlEscape(sourceLabel)}</span>
          </span>
          <span class="compacted-context-chevron" aria-hidden="true">›</span>
        </button>
        <div
          id="compactedContextContent"
          class="compacted-context-content"
          ${expanded ? '' : 'hidden'}
        >
          ${markdown(session.compaction.text)}
        </div>
      </section>
    `;
  }

  function toggleCompactedContext() {
    const session = state.currentSession;
    if (!hasCompactedContext(session)) return;

    const toggle = el.messages.querySelector('[data-toggle-compacted-context]');
    const content = el.messages.querySelector('#compactedContextContent');
    if (!toggle || !content) return;

    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    content.hidden = !expanded;

    if (expanded) expandedCompactedContexts.add(session.id);
    else expandedCompactedContexts.delete(session.id);
  }

  function renderMessageActions(message) {
    return `
      <span class="message-actions" role="group" aria-label="Message actions">
        <button class="mini-btn" data-copy-message="${message.id}" aria-label="Copy message as Markdown">Copy Markdown</button>
        ${
          state.currentSession.trashed
            ? ''
            : `
          <button class="mini-btn" data-edit-message="${message.id}" aria-label="Edit message">Edit</button>
          <button class="mini-btn danger" data-delete-message="${message.id}" aria-label="Delete message">Delete</button>
        `
        }
      </span>
    `;
  }

  function renderMessageFooterActions(message) {
    const copyIcon = `
      <svg class="message-action-svg message-action-copy-svg" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="11" height="11" rx="2"></rect>
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
      </svg>
      <svg class="message-action-svg message-action-check-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4 4L19 6"></path>
      </svg>
    `;
    const editIcon = `
      <svg class="message-action-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3Z"></path>
        <path d="m13.5 8.5 3 3"></path>
      </svg>
    `;
    const deleteIcon = `
      <svg class="message-action-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 7V4h6v3"></path>
        <path d="m6 7 1 13h10l1-13"></path>
        <path d="M10 11v5M14 11v5"></path>
      </svg>
    `;

    return `
      <div class="message-footer-actions" role="group" aria-label="Message quick actions">
        <button
          type="button"
          class="message-action-icon"
          data-copy-message="${message.id}"
          data-tooltip="Copy markdown"
          aria-label="Copy markdown"
        >${copyIcon}</button>
        ${
          state.currentSession.trashed
            ? ''
            : `
          <button
            type="button"
            class="message-action-icon"
            data-edit-message="${message.id}"
            data-tooltip="Edit"
            aria-label="Edit"
          >${editIcon}</button>
          <button
            type="button"
            class="message-action-icon message-action-delete"
            data-delete-message="${message.id}"
            data-tooltip="Delete"
            aria-label="Delete"
          >${deleteIcon}</button>
        `
        }
      </div>
    `;
  }

  function renderMessages() {
    syncSenderCheckbox();

    if (!state.currentSession) {
      el.chatEyebrow.textContent = 'Current session';
      el.chatTitle.textContent = 'No session selected';
      el.sendBtn.disabled = true;
      el.pinSelect.disabled = true;
      el.renameBotBtn.disabled = true;
      el.renameBotBtn.textContent = 'Set AI name';
      el.renameSessionBtn.disabled = true;
      el.copyChatBtn.disabled = true;
      el.messages.className = 'messages empty-state';
      el.messages.innerHTML = `
        <div class="empty-card"><span>☁</span><h3>Start a new local chat</h3><p>Your conversations are stored as JSON files by date.</p></div>
      `;
      messageNavigator?.render(null);
      return;
    }

    el.chatEyebrow.textContent = `Current session · AI: ${botName()}`;
    el.chatTitle.textContent = state.currentSession.title;
    el.sendBtn.disabled = state.currentSession.trashed;
    el.renameBotBtn.disabled = false;
    el.renameBotBtn.textContent = `AI: ${botName()}`;
    el.renameBotBtn.title = 'Set AI bot name for this chat';
    el.renameSessionBtn.disabled = false;
    el.copyChatBtn.disabled = false;
    el.messages.className = 'messages';

    const compactedContext = renderCompactedContext(state.currentSession);

    if (!state.currentSession.messages.length) {
      const emptyTitle = compactedContext ? 'No messages after compaction yet' : 'No messages yet';
      const emptyCopy = compactedContext ? 'Continue the conversation below.' : 'Write the first message below.';
      el.messages.innerHTML = `${compactedContext}<div class="empty-card${
        compactedContext ? ' compacted-empty-tail' : ''
      }"><span>✍</span><h3>${emptyTitle}</h3><p>${emptyCopy}</p></div>`;
      messageNavigator?.render(state.currentSession);
      return;
    }

    const renderedMessages = state.currentSession.messages
      .map(
        (message) => `
      <article class="message ${message.sender === 'me' ? 'me' : 'bot'}" data-chat-message-id="${htmlEscape(message.id)}">
        <div class="message-surface">
          <div class="message-top">
            <span class="message-label">${message.sender === 'me' ? 'Me' : htmlEscape(botName())}${message.updatedAt ? ' · edited' : ''}</span>
            ${renderMessageActions(message)}
          </div>
          <div class="message-text" data-message-id="${message.id}">${markdown(message.text)}</div>
        </div>
        ${renderMessageFooterActions(message)}
      </article>
    `
      )
      .join('');

    el.messages.innerHTML = compactedContext + renderedMessages;
    el.messages.scrollTop = el.messages.scrollHeight;
    messageNavigator?.render(state.currentSession);
  }

  return {
    applySidebarState,
    toggleSidebar,
    renderFolders,
    renderPinSelect,
    filteredSessions,
    renderSessions,
    renderTrash,
    syncSenderCheckbox,
    hasCompactedContext,
    renderCompactedContext,
    toggleCompactedContext,
    renderMessageActions,
    renderMessageFooterActions,
    renderMessages
  };
}

export { createRenderer };
