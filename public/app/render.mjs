function createRenderer({ state, el, storage, escapeHtml, renderMarkdown, formatDate, getBotName, nextMessageSender }) {
  const htmlEscape = escapeHtml || ((value) => String(value || ''));
  const markdown = renderMarkdown || htmlEscape;
  const dateFormatter = formatDate || ((value) => String(value || ''));
  const botName = (session = state.currentSession) => (getBotName ? getBotName(session) : 'AI Bot');

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
      <button class="item folder-system-item ${state.selectedFolderId === null ? 'active' : ''}" data-folder="all">
        <span class="item-main"><span class="item-title">All conversations</span><span class="item-meta">Everything sorted by latest activity</span></span>
      </button>
      <button class="item folder-system-item ${state.selectedFolderId === 'unfiled' ? 'active' : ''}" data-folder="unfiled">
        <span class="item-main"><span class="item-title">Unfiled</span><span class="item-meta">No pinned folder</span></span>
      </button>
      <div class="folder-system-separator" aria-hidden="true"></div>
    `;

    const folders = state.folders
      .map(
        (folder) => `
      <div class="item ${state.selectedFolderId === folder.id ? 'active' : ''}">
        <button class="item-main bare" data-folder="${folder.id}">
          <span class="item-title">${htmlEscape(folder.name)}</span>
          <span class="item-meta">Pinned chats</span>
        </button>
        <span class="item-actions" aria-label="Folder actions">
          <button class="icon-btn" data-rename-folder="${folder.id}" title="Rename folder" aria-label="Rename folder">✎</button>
          <button class="icon-btn danger" data-delete-folder="${folder.id}" title="Delete folder" aria-label="Delete folder">×</button>
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
        <button class="item-main bare" data-open-session="${session.id}">
          <span class="item-title">${htmlEscape(session.title)}</span>
          <span class="item-meta">${session.dateFolder} · ${session.messageCount} messages · ${dateFormatter(session.updatedAt)}</span>
        </button>
        <span class="item-actions" aria-label="Session actions">
          <button class="icon-btn" data-rename-session="${session.id}" title="Rename session" aria-label="Rename session">✎</button>
          <button class="icon-btn danger" data-trash-session="${session.id}" title="Move to trash" aria-label="Move to trash">×</button>
        </span>
      </div>
    `
      )
      .join('');
  }

  function renderTrash() {
    el.trashList.classList.toggle('hidden', !state.trashOpen);
    if (!state.trash.length) {
      el.trashList.innerHTML = `<div class="item"><div class="item-main"><div class="item-title">Trash is empty</div></div></div>`;
      return;
    }

    el.trashList.innerHTML = state.trash
      .map(
        (session) => `
      <div class="item">
        <button class="item-main bare" data-open-session="${session.id}">
          <span class="item-title">${htmlEscape(session.title)}</span>
          <span class="item-meta">${session.messageCount} messages</span>
        </button>
        <span class="item-actions" aria-label="Trash actions">
          <button class="icon-btn" data-rename-session="${session.id}" title="Rename session" aria-label="Rename session">✎</button>
          <button class="icon-btn" data-restore-session="${session.id}" title="Restore" aria-label="Restore session">↩</button>
          <button class="icon-btn danger" data-delete-trash="${session.id}" title="Delete forever" aria-label="Delete forever">×</button>
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

  function renderMessageActions(message) {
    return `
      <span class="message-actions">
        <button class="mini-btn" data-copy-message="${message.id}">Copy Markdown</button>
        ${
          state.currentSession.trashed
            ? ''
            : `
          <button class="mini-btn" data-edit-message="${message.id}">Edit</button>
          <button class="mini-btn danger" data-delete-message="${message.id}">Delete</button>
        `
        }
      </span>
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

    if (!state.currentSession.messages.length) {
      el.messages.innerHTML = `<div class="empty-card"><span>✍</span><h3>No messages yet</h3><p>Write the first message below.</p></div>`;
      return;
    }

    el.messages.innerHTML = state.currentSession.messages
      .map(
        (message) => `
      <article class="message ${message.sender === 'me' ? 'me' : 'bot'}">
        <div class="message-top">
          <span class="message-label">${message.sender === 'me' ? 'Me' : htmlEscape(botName())}${message.updatedAt ? ' · edited' : ''}</span>
          ${renderMessageActions(message)}
        </div>
        <div class="message-text" data-message-id="${message.id}">${markdown(message.text)}</div>
        <div class="message-bottom" aria-label="Message actions">
          ${renderMessageActions(message)}
        </div>
      </article>
    `
      )
      .join('');
    el.messages.scrollTop = el.messages.scrollHeight;
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
    renderMessageActions,
    renderMessages
  };
}

export { createRenderer };
