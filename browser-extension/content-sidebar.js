(function exposeLocalChatContentSidebar(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentSidebar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentSidebar() {
  'use strict';

  const DEFAULTS = Object.freeze({
    localPinSelectInteractionMs: 2500,
    localSidebarRefreshMs: 5000,
    localSidebarMaxChats: 150,
    pendingLoadDelayMs: 650,
    selectedFolderStorageKey: 'localChatSidebarSelectedFolderId',
    pendingLoadSessionStorageKey: 'localChatPendingSidebarSessionId'
  });

  function createNoopDependency(name) {
    return function missingDependency() {
      throw new Error(`LocalChatContentSidebar dependency is missing: ${name}`);
    };
  }

  function createSidebarController(deps = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const markers = deps.markers || {};
    const LOCAL_SIDEBAR_MARKER = markers.LOCAL_SIDEBAR_MARKER || 'data-local-chat-sidebar';
    const LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER =
      markers.LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER || 'data-local-chat-native-sidebar-hidden';
    const LOAD_PAST_MODAL_ID = markers.LOAD_PAST_MODAL_ID || 'local-chat-load-past-modal';

    const LOCAL_PIN_SELECT_INTERACTION_MS = config.localPinSelectInteractionMs;
    const LOCAL_SIDEBAR_STORAGE_KEY = config.selectedFolderStorageKey;
    const LOCAL_SIDEBAR_PENDING_LOAD_SESSION_KEY = config.pendingLoadSessionStorageKey;
    const LOCAL_SIDEBAR_REFRESH_MS = config.localSidebarRefreshMs;
    const LOCAL_SIDEBAR_MAX_CHATS = config.localSidebarMaxChats;

    const providerInfo = deps.providerInfo || (() => ({ name: 'AI Chat', key: 'unknown' }));
    const normalizeText =
      deps.normalizeText ||
      ((value) =>
        String(value || '')
          .trim()
          .replace(/\s+/g, ' '));
    const isVisibleElement = deps.isVisibleElement || (() => true);
    const escapeHtml =
      deps.escapeHtml ||
      ((value) =>
        String(value ?? '').replace(
          /[&<>"']/g,
          (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
        ));
    const formatLocalDate = deps.formatLocalDate || ((value) => String(value || ''));
    const isAutoSendEnabled = deps.isAutoSendEnabled || (() => true);
    const ensureTemporaryChatUrlForLocalMode = deps.ensureTemporaryChatUrlForLocalMode || (() => false);
    const isLocalChatAppConnectionError = deps.isLocalChatAppConnectionError || (() => false);
    const setLocalChatAppAvailability = deps.setLocalChatAppAvailability || (() => {});
    const replaceComposerWithText = deps.replaceComposerWithText || createNoopDependency('replaceComposerWithText');
    const updateLoadPastControls = deps.updateLoadPastControls || (() => {});
    const showToast = deps.showToast || (() => {});
    const startCompaction = deps.startCompaction || createNoopDependency('startCompaction');
    const isCompactionRunning = deps.isCompactionRunning || (() => false);
    const chromeApi = deps.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);

    let localSidebarSelectedFolderId = null;
    let localSidebarLastFetchAt = 0;
    let localSidebarRefreshPromise = null;
    let localSidebarData = { folders: [], sessions: [], activeSessionId: null };
    let localSidebarError = '';
    let localSidebarPendingSessionId = '';
    let localPinSelectInteractionUntil = 0;

    function isChatGptProvider() {
      return providerInfo().key === 'chatgpt';
    }

    function isDeepSeekProvider() {
      return providerInfo().key === 'deepseek';
    }

    function isTopLevelChatGptPage() {
      try {
        if (window.top !== window.self) return false;
      } catch {
        return false;
      }

      const host = location.hostname.toLowerCase();
      return host.includes('chatgpt.com') || host.includes('chat.openai.com');
    }

    function isTemporaryChatUrl() {
      try {
        return new URL(location.href).searchParams.get('temporary-chat') === 'true';
      } catch {
        return false;
      }
    }

    function storePendingLocalSidebarLoad(sessionId) {
      if (!sessionId) return false;
      try {
        sessionStorage.setItem(LOCAL_SIDEBAR_PENDING_LOAD_SESSION_KEY, String(sessionId));
        return true;
      } catch {
        return false;
      }
    }

    function consumePendingLocalSidebarLoad() {
      if (!isTopLevelChatGptPage() || !isTemporaryChatUrl()) return;

      let sessionId = '';
      try {
        sessionId = sessionStorage.getItem(LOCAL_SIDEBAR_PENDING_LOAD_SESSION_KEY) || '';
        if (sessionId) sessionStorage.removeItem(LOCAL_SIDEBAR_PENDING_LOAD_SESSION_KEY);
      } catch {
        sessionId = '';
      }

      if (!sessionId) return;
      setTimeout(() => selectLocalSidebarSession(sessionId), config.pendingLoadDelayMs);
    }

    function currentLocalChatTarget() {
      const activeSession = getActiveLocalSidebarSession?.();
      if (!activeSession?.id) return null;
      return { sessionId: activeSession.id, sessionTitle: activeSession.title || 'selected session' };
    }

    function supportsLocalSidebarReplacement() {
      return ['chatgpt', 'claude', 'deepseek', 'gemini'].includes(providerInfo().key);
    }

    function shouldShowLocalSidebarReplacement() {
      return isAutoSendEnabled() && supportsLocalSidebarReplacement();
    }

    function sidebarProviderHints() {
      const key = providerInfo().key;

      const commonLabels = [
        'chats',
        'chat history',
        'recent',
        'recents',
        'recent chats',
        'history',
        'today',
        'yesterday',
        'previous 7 days',
        'last 7 days',
        'previous 30 days',
        'older',
        'pinned'
      ];

      if (key === 'chatgpt') {
        return {
          labels: ['projects', 'chats', ...commonLabels],
          rootWords: ['new chat', 'projects', 'chats', 'chat history']
        };
      }

      if (key === 'claude') {
        return {
          labels: ['projects', 'chats', 'recent', 'recents', ...commonLabels],
          rootWords: ['new chat', 'chats', 'projects', 'recents', 'recent']
        };
      }

      if (key === 'deepseek') {
        return {
          labels: ['chats', 'history', 'recent', ...commonLabels],
          rootWords: ['new chat', 'chat history', 'history', 'today', 'yesterday']
        };
      }

      if (key === 'gemini') {
        return {
          labels: ['recent', 'gemini apps', 'chats', ...commonLabels],
          rootWords: ['new chat', 'recent', 'gemini apps', 'activity']
        };
      }

      return { labels: commonLabels, rootWords: ['new chat', 'chats', 'history', 'recent'] };
    }

    function directTextOf(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
      return normalizeText(
        Array.from(element.childNodes || [])
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || '')
          .join(' ')
      );
    }

    function elementIdentityText(element) {
      return [
        element?.tagName || '',
        element?.id || '',
        element?.className || '',
        element?.getAttribute?.('aria-label') || '',
        element?.getAttribute?.('data-testid') || '',
        element?.getAttribute?.('role') || ''
      ]
        .join(' ')
        .toLowerCase();
    }

    function isLikelyLeftSidebarShape(element) {
      if (!element || !isVisibleElement(element)) return false;
      if (element === document.body || element === document.documentElement) return false;
      if (element.closest?.(`[${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`)) return false;
      if (element.querySelector?.('textarea, [contenteditable="true"]')) return false;

      const rect = element.getBoundingClientRect?.();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      if (!rect || !viewportWidth || !viewportHeight) return false;

      const maxWidth = Math.min(460, viewportWidth * 0.48);
      const minHeight = Math.max(260, viewportHeight * 0.52);
      if (rect.left > 56 || rect.top > 140) return false;
      if (rect.width < 96 || rect.width > maxWidth) return false;
      if (rect.height < minHeight || rect.bottom < viewportHeight * 0.55) return false;

      return true;
    }

    function findLikelyLeftSidebarCandidates() {
      return Array.from(document.querySelectorAll('aside, nav, [role="navigation"], div')).filter(
        isLikelyLeftSidebarShape
      );
    }

    function findProviderSidebarRoot() {
      if (!supportsLocalSidebarReplacement()) return null;

      const candidates = [
        document.querySelector('nav[aria-label*="chat" i]'),
        document.querySelector('nav[aria-label*="history" i]'),
        document.querySelector('nav[aria-label*="recent" i]'),
        document.querySelector('aside[aria-label*="chat" i]'),
        document.querySelector('aside[aria-label*="history" i]'),
        document.querySelector('aside[aria-label*="recent" i]'),
        document.querySelector('aside')
      ].filter(Boolean);

      candidates.push(
        ...Array.from(
          document.querySelectorAll(
            [
              'nav',
              'aside',
              'mat-sidenav',
              'bard-sidenav',
              'side-navigation',
              '[role="navigation"]',
              '[data-testid*="sidebar" i]',
              '[data-testid*="side" i]',
              '[data-testid*="history" i]',
              '[data-testid*="conversation" i]',
              '[class*="sidebar" i]',
              '[class*="side-bar" i]',
              '[class*="sidenav" i]',
              '[class*="side-nav" i]',
              '[class*="history" i]',
              '[id*="sidebar" i]',
              '[id*="sidenav" i]',
              '[id*="history" i]'
            ].join(',')
          )
        )
      );

      if (isDeepSeekProvider()) {
        candidates.push(...findLikelyLeftSidebarCandidates());
      }

      const hints = sidebarProviderHints();
      const unique = [...new Set(candidates)].filter((element) => {
        if (!element || !isVisibleElement(element)) return false;
        if (element.closest?.(`[${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`)) return false;
        if (element.querySelector?.('textarea, [contenteditable="true"]')) return false;

        const rect = element.getBoundingClientRect?.();
        const minWidth = isDeepSeekProvider() ? 96 : 120;
        if (!rect || rect.height < 220 || rect.width < minWidth || rect.width > Math.min(520, window.innerWidth * 0.62))
          return false;
        if (rect.left > Math.max(520, window.innerWidth * 0.5)) return false;

        const text = normalizeText(element.innerText || element.textContent || '').toLowerCase();
        const identity = elementIdentityText(element);
        const hasRootWord = hints.rootWords.some((word) => text.includes(word));
        const looksLikeSidebar =
          /sidebar|side-bar|sidenav|side-nav|sider|history|conversation|navigation|nav|aside/.test(identity);
        const hasMultipleChatLinks =
          Array.from(element.querySelectorAll?.('a, button, [role="button"]') || [])
            .filter(isVisibleElement)
            .filter((child) => normalizeText(child.innerText || child.textContent || '').length >= 2).length >= 3;
        const deepSeekLeftSidebar =
          isDeepSeekProvider() &&
          isLikelyLeftSidebarShape(element) &&
          (hasRootWord ||
            hasMultipleChatLinks ||
            /new chat|chat|history|today|yesterday|探索|对话|聊天/.test(text) ||
            looksLikeSidebar);

        return hasRootWord || (looksLikeSidebar && hasMultipleChatLinks) || deepSeekLeftSidebar;
      });

      unique.sort((a, b) => {
        const score = (element) => {
          const rect = element.getBoundingClientRect();
          const text = normalizeText(element.innerText || '').toLowerCase();
          const identity = elementIdentityText(element);
          let value = 0;
          if (element.tagName?.toLowerCase() === 'nav' || element.tagName?.toLowerCase() === 'aside') value += 6;
          if (/sidebar|side-bar|sidenav|side-nav|sider|history/.test(identity)) value += 5;
          if (isDeepSeekProvider() && isLikelyLeftSidebarShape(element)) value += 7;
          if (text.includes('new chat')) value += 3;
          if (text.includes('projects')) value += 2;
          if (text.includes('chats')) value += 2;
          if (text.includes('history')) value += 2;
          if (text.includes('recent')) value += 2;
          value += Math.max(0, 5 - Math.abs(rect.left));
          value += Math.min(4, rect.height / 180);
          value -= Math.max(0, rect.width - 380) / 120;
          return value;
        };
        return score(b) - score(a);
      });

      return unique[0] || null;
    }

    function sidebarLabelMatches(element, label) {
      const text = normalizeText(directTextOf(element) || element.textContent || '').toLowerCase();
      if (!text || text.length > 80) return false;
      return text === label || text === `${label}:`;
    }

    function findNativeSidebarSectionForLabel(labelElement, root) {
      if (!labelElement || !root) return null;
      const rootRect = root.getBoundingClientRect?.();
      let node = labelElement.parentElement;
      let fallback = labelElement;

      for (let depth = 0; node && node !== root && node !== document.body && depth < 7; depth += 1) {
        if (node.hasAttribute?.(LOCAL_SIDEBAR_MARKER)) return null;

        const rect = node.getBoundingClientRect?.();
        const text = normalizeText(node.innerText || node.textContent || '');
        const actions = node.querySelectorAll?.('a, button, [role="button"]')?.length || 0;
        const children = Array.from(node.children || []).filter(isVisibleElement).length;
        const heightOk = !rootRect || !rect || rect.height < rootRect.height * 0.94;
        const widthOk = !rootRect || !rect || rect.width >= rootRect.width * 0.35;

        if (text && heightOk && widthOk) fallback = node;
        if (
          text &&
          heightOk &&
          widthOk &&
          (actions >= 1 || children >= 2 || text.length > normalizeText(labelElement.textContent || '').length + 8)
        ) {
          return node;
        }

        node = node.parentElement;
      }

      return fallback === labelElement ? labelElement.parentElement : fallback;
    }

    function isNativeSidebarControl(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const text = normalizeText(element.innerText || element.textContent || '').toLowerCase();
      const label = elementIdentityText(element);

      if (element.matches?.('textarea, input, [contenteditable="true"]')) return true;
      if (element.querySelector?.('textarea, input[type="text"], [contenteditable="true"]')) return true;
      if (text.length < 80 && /new chat|compose|settings|upgrade|profile|menu|collapse|expand|help/.test(text))
        return true;
      if (/settings|profile|account|user|menu|collapse|expand/.test(label)) return true;

      return false;
    }

    function sidebarSectionScore(element, root) {
      if (!element || !root || !isVisibleElement(element)) return -1;
      if (element === root || element.hasAttribute?.(LOCAL_SIDEBAR_MARKER)) return -1;
      if (element.closest?.(`[${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`)) return -1;
      if (isNativeSidebarControl(element)) return -1;

      const rootRect = root.getBoundingClientRect?.();
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.height < 40 || rect.width < 80) return -1;
      if (rootRect && (rect.width < rootRect.width * 0.32 || rect.height > rootRect.height * 0.98)) return -1;

      const text = normalizeText(element.innerText || element.textContent || '').toLowerCase();
      if (!text || text.length < 6) return -1;

      const identity = elementIdentityText(element);
      const buttons = Array.from(element.querySelectorAll?.('a, button, [role="button"]') || [])
        .filter(isVisibleElement)
        .filter((item) => !isNativeSidebarControl(item));
      const meaningfulButtons = buttons.filter(
        (item) => normalizeText(item.innerText || item.textContent || '').length >= 2
      );

      let score = 0;
      if (/history|conversation|chat-list|chatlist|recent|thread|session|list/.test(identity)) score += 8;
      if (
        /chats|chat history|history|recent|recents|today|yesterday|previous 7 days|last 7 days|previous 30 days|older|pinned|projects|gemini apps/.test(
          text
        )
      )
        score += 6;
      if (meaningfulButtons.length >= 2) score += Math.min(8, meaningfulButtons.length * 2);
      if (element.matches?.('[role="list"], ul, ol')) score += 3;
      if (/(new chat|settings|profile|upgrade)/.test(text) && text.length < 120) score -= 5;
      if (rect.height > 110) score += 2;

      return score;
    }

    function findNativeProviderSidebarSections(root) {
      if (!root) return [];
      const hints = sidebarProviderHints();
      const labels = hints.labels;

      const labelCandidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p'))
        .filter((element) => !element.closest?.(`[${LOCAL_SIDEBAR_MARKER}]`))
        .filter((element) => isVisibleElement(element))
        .filter((element) => labels.some((label) => sidebarLabelMatches(element, label)));

      const sections = labelCandidates
        .map((element) => findNativeSidebarSectionForLabel(element, root))
        .filter((section) => section && section !== root && root.contains(section));

      const structuredCandidates = Array.from(
        root.querySelectorAll(
          [
            '[role="list"]',
            'ul',
            'ol',
            '[aria-label*="chat" i]',
            '[aria-label*="history" i]',
            '[aria-label*="recent" i]',
            '[data-testid*="history" i]',
            '[data-testid*="conversation" i]',
            '[data-testid*="chat" i]',
            '[class*="history" i]',
            '[class*="conversation" i]',
            '[class*="chat-list" i]',
            '[class*="chatlist" i]',
            '[class*="recent" i]'
          ].join(',')
        )
      ).filter((element) => sidebarSectionScore(element, root) >= 7);

      sections.push(...structuredCandidates);

      // If a provider does not expose labeled history groups, replace the largest
      // likely history/list child so the Local Chat panel still appears in the left sidebar.
      if (!sections.length && !isChatGptProvider()) {
        const candidates = Array.from(root.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *'))
          .filter((element) => sidebarSectionScore(element, root) >= 5)
          .sort((a, b) => sidebarSectionScore(b, root) - sidebarSectionScore(a, root));

        if (candidates[0]) sections.push(candidates[0]);
      }

      // Last-resort provider fallback: if the root is clearly a left sidebar but its
      // history is not structured, replace most visible content while preserving tiny
      // top/bottom controls where possible.
      if (!sections.length && !isChatGptProvider()) {
        const rootRect = root.getBoundingClientRect?.();
        const visibleChildren = Array.from(root.children || [])
          .filter((child) => isVisibleElement(child))
          .filter((child) => !child.hasAttribute?.(LOCAL_SIDEBAR_MARKER))
          .filter((child) => !isNativeSidebarControl(child));

        const largeChildren = visibleChildren.filter((child) => {
          const rect = child.getBoundingClientRect?.();
          if (!rect || !rootRect) return false;
          return (
            rect.height >= Math.min(90, rootRect.height * 0.18) ||
            normalizeText(child.innerText || child.textContent || '').length > 120
          );
        });

        sections.push(...(largeChildren.length ? largeChildren : visibleChildren));
      }

      const unique = [...new Set(sections)].filter((section) => section && section !== root && root.contains(section));

      return unique.filter((section) => !unique.some((other) => other !== section && other.contains(section)));
    }

    function hideNativeProviderSidebarSections(root) {
      if (!root) return [];
      const sections = findNativeProviderSidebarSections(root);

      for (const section of sections) {
        section.setAttribute(LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER, 'true');
        section.style.setProperty('display', 'none', 'important');
      }

      return sections;
    }

    function restoreNativeProviderSidebarSections() {
      document.querySelectorAll?.(`[${LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER}]`).forEach((element) => {
        element.style.removeProperty('display');
        element.removeAttribute(LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER);
      });
    }

    function folderLabelForLocalSidebar(folderId, folders) {
      if (!folderId) return 'All conversations';
      if (folderId === 'unfiled') return 'Unfiled';
      return folders.find((folder) => folder.id === folderId)?.name || 'Local folder';
    }

    function folderCountsForLocalSidebar(sessions) {
      const counts = { all: sessions.length, unfiled: 0 };
      for (const session of sessions) {
        const folderId = session.pinnedFolderId || null;
        if (!folderId) counts.unfiled += 1;
        else counts[folderId] = (counts[folderId] || 0) + 1;
      }
      return counts;
    }

    function sessionsForLocalSidebarFolder(folderId, sessions) {
      if (!folderId) return sessions;
      if (folderId === 'unfiled') return sessions.filter((session) => !session.pinnedFolderId);
      return sessions.filter((session) => session.pinnedFolderId === folderId);
    }

    function localSidebarFolderActions(folderId) {
      if (!folderId || folderId === 'unfiled') return '';

      return `
    <span class="local-chat-sidebar-actions" aria-label="Folder actions">
      <button type="button" class="local-chat-sidebar-action" data-local-sidebar-rename-folder="${escapeHtml(folderId)}" title="Rename local folder" aria-label="Rename local folder">✎</button>
      <button type="button" class="local-chat-sidebar-action danger" data-local-sidebar-delete-folder="${escapeHtml(folderId)}" title="Delete local folder" aria-label="Delete local folder">×</button>
    </span>
  `;
    }

    function localSidebarChatActions(sessionId) {
      if (!sessionId) return '';

      return `
    <span class="local-chat-sidebar-actions" aria-label="Chat actions">
      <button type="button" class="local-chat-sidebar-action" data-local-sidebar-rename-session="${escapeHtml(sessionId)}" title="Rename local chat" aria-label="Rename local chat">✎</button>
      <button type="button" class="local-chat-sidebar-action danger" data-local-sidebar-delete-session="${escapeHtml(sessionId)}" title="Delete local chat" aria-label="Delete local chat">×</button>
    </span>
  `;
    }

    function localSidebarFolderButton(folderId, title, meta, count, isActive) {
      const actions = localSidebarFolderActions(folderId);
      const encodedFolderId = escapeHtml(folderId || '');
      return `
    <div class="local-chat-sidebar-managed-row local-chat-sidebar-folder-row${actions ? ' has-actions' : ''}${isActive ? ' active-row' : ''}" data-local-sidebar-folder-id="${encodedFolderId}">
      <button type="button" class="local-chat-sidebar-item local-chat-sidebar-folder${isActive ? ' active' : ''}" data-local-sidebar-folder-id="${encodedFolderId}">
        <span class="local-chat-sidebar-item-main">
          <span class="local-chat-sidebar-title">${escapeHtml(title)}</span>
          <span class="local-chat-sidebar-meta">${escapeHtml(meta)}</span>
        </span>
        <span class="local-chat-sidebar-count">${Number(count || 0)}</span>
      </button>
      ${actions}
    </div>
  `;
    }

    function getActiveLocalSidebarSession() {
      const sessions = Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : [];
      const activeSessionId = localSidebarData.activeSessionId || localSidebarData.activeSession?.id || null;
      if (!activeSessionId) return null;

      return sessions.find((session) => session.id === activeSessionId) || localSidebarData.activeSession || null;
    }

    function markLocalPinSelectInteraction() {
      localPinSelectInteractionUntil = Date.now() + LOCAL_PIN_SELECT_INTERACTION_MS;
    }

    function isLocalPinSelectElement(element) {
      return Boolean(element?.closest?.('[data-local-sidebar-pin-select]'));
    }

    function isLocalPinSelectInteracting(container = document) {
      const active = document.activeElement;
      if (
        active &&
        isLocalPinSelectElement(active) &&
        (!container || container === document || container.contains?.(active))
      ) {
        return true;
      }

      return Date.now() < localPinSelectInteractionUntil;
    }

    function handleLocalPinSelectInteractionEvent(event) {
      if (!isLocalPinSelectElement(event.target)) return;

      markLocalPinSelectInteraction();
      event.stopPropagation();
    }

    function renderLocalSidebarChatFolderSelect(session, folders) {
      if (!session?.id) return '';

      const currentFolderId = session.pinnedFolderId || '';
      const selectId = `local-chat-sidebar-pin-select-${String(session.id).replace(/[^a-z0-9_-]/gi, '-')}`;
      const folderOptions = folders
        .map(
          (folder) => `
    <option value="${escapeHtml(folder.id)}"${folder.id === currentFolderId ? ' selected' : ''}>${escapeHtml(folder.name || 'Untitled folder')}</option>
  `
        )
        .join('');

      return `
    <div class="local-chat-sidebar-inline-pin">
      <label class="local-chat-sidebar-pin-label" for="${escapeHtml(selectId)}">Folder</label>
      <select id="${escapeHtml(selectId)}" class="local-chat-sidebar-pin-select" data-local-sidebar-pin-select data-local-sidebar-session-id="${escapeHtml(session.id)}">
        <option value=""${currentFolderId ? '' : ' selected'}>No pinned folder</option>
        ${folderOptions}
      </select>
    </div>
  `;
    }

    function renderLocalSidebarPanel(panel) {
      const folders = Array.isArray(localSidebarData.folders) ? localSidebarData.folders : [];
      const sessions = Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : [];
      const counts = folderCountsForLocalSidebar(sessions);
      const selectedFolderId = localSidebarSelectedFolderId || null;
      const selectedFolderExists =
        !selectedFolderId || selectedFolderId === 'unfiled' || folders.some((folder) => folder.id === selectedFolderId);

      if (!selectedFolderExists) localSidebarSelectedFolderId = null;

      const folderButtons = [
        localSidebarFolderButton(
          '',
          'All conversations',
          'Everything local',
          counts.all,
          !localSidebarSelectedFolderId
        ),
        localSidebarFolderButton(
          'unfiled',
          'Unfiled',
          'No local folder',
          counts.unfiled,
          localSidebarSelectedFolderId === 'unfiled'
        ),
        '<div class="local-chat-sidebar-folder-separator" aria-hidden="true"></div>',
        ...folders.map((folder) =>
          localSidebarFolderButton(
            folder.id,
            folder.name || 'Untitled folder',
            'Local folder',
            counts[folder.id] || 0,
            localSidebarSelectedFolderId === folder.id
          )
        )
      ].join('');

      const filtered = sessionsForLocalSidebarFolder(localSidebarSelectedFolderId, sessions).slice(
        0,
        LOCAL_SIDEBAR_MAX_CHATS
      );
      const chatButtons = filtered.length
        ? filtered
            .map((session) => {
              const active = localSidebarData.activeSessionId === session.id;
              const pending = localSidebarPendingSessionId === session.id;
              const actions = localSidebarChatActions(session.id);
              return `
      <div class="local-chat-sidebar-chat-entry${active ? ' active-entry' : ''}" data-local-sidebar-session-id="${escapeHtml(session.id)}">
        <div class="local-chat-sidebar-managed-row local-chat-sidebar-chat-row has-actions${active ? ' active-row' : ''}${pending ? ' loading-row' : ''}" data-local-sidebar-session-id="${escapeHtml(session.id)}">
          <button type="button" class="local-chat-sidebar-item local-chat-sidebar-chat${active ? ' active' : ''}${pending ? ' loading' : ''}" data-local-sidebar-session-id="${escapeHtml(session.id)}" ${pending ? 'disabled' : ''}>
            <span class="local-chat-sidebar-item-main">
              <span class="local-chat-sidebar-title">${escapeHtml(session.title || 'Untitled chat')}</span>
              <span class="local-chat-sidebar-meta">${escapeHtml(session.dateFolder || '')}${session.messageCount !== undefined ? ` · ${Number(session.messageCount || 0)} messages` : ''}${session.updatedAt ? ` · ${escapeHtml(formatLocalDate(session.updatedAt))}` : ''}</span>
            </span>
          </button>
          ${actions}
        </div>
        ${active ? renderLocalSidebarChatFolderSelect(session, folders) : ''}
      </div>
    `;
            })
            .join('')
        : `
    <div class="local-chat-sidebar-empty">No local chats in ${escapeHtml(folderLabelForLocalSidebar(localSidebarSelectedFolderId, folders))}.</div>
  `;

      panel.innerHTML = `
    <div class="local-chat-sidebar-header">
      <div>
        <div class="local-chat-sidebar-eyebrow">Local Chat</div>
        <div class="local-chat-sidebar-heading">Folders & chats</div>
      </div>
      <button type="button" class="local-chat-sidebar-icon" data-local-sidebar-refresh title="Refresh local folders and chats">↻</button>
    </div>
    ${localSidebarError ? `<div class="local-chat-sidebar-error">${escapeHtml(localSidebarError)}</div>` : ''}
    <div class="local-chat-sidebar-section">
      <div class="local-chat-sidebar-section-row">
        <div class="local-chat-sidebar-section-title">Local folders</div>
        <button type="button" class="local-chat-sidebar-new" data-local-sidebar-new-folder title="Create a new local folder">New folder</button>
      </div>
      <div class="local-chat-sidebar-list">${folderButtons}</div>
    </div>
    <div class="local-chat-sidebar-section local-chat-sidebar-chats-section">
      <div class="local-chat-sidebar-section-row">
        <div class="local-chat-sidebar-section-title">Local chats</div>
        <div class="local-chat-sidebar-section-actions">
          <button type="button" class="local-chat-sidebar-new" data-local-sidebar-compact title="Compact the active local chat into continuation context"${localSidebarData.activeSessionId && !isCompactionRunning() ? '' : ' disabled'}>${isCompactionRunning() ? 'Compacting…' : 'Compact'}</button>
          <button type="button" class="local-chat-sidebar-new" data-local-sidebar-new title="Create a new local chat session">New chat</button>
        </div>
      </div>
      <div class="local-chat-sidebar-subtitle">${escapeHtml(folderLabelForLocalSidebar(localSidebarSelectedFolderId, folders))}</div>
      <div class="local-chat-sidebar-list local-chat-sidebar-chat-list">${chatButtons}</div>
    </div>
  `;
    }

    async function requestLocalSidebarData(force = false) {
      if (!shouldShowLocalSidebarReplacement()) return localSidebarData;
      const now = Date.now();
      if (!force && localSidebarRefreshPromise) return localSidebarRefreshPromise;
      if (!force && now - localSidebarLastFetchAt < LOCAL_SIDEBAR_REFRESH_MS) return localSidebarData;

      localSidebarRefreshPromise = chromeApi.runtime
        .sendMessage({
          type: 'LIST_LOCAL_SIDEBAR',
          payload: { limit: 500 }
        })
        .then((response) => {
          if (!response?.ok) throw new Error(response?.error || 'Could not load local sidebar.');
          localSidebarData = {
            folders: Array.isArray(response.folders) ? response.folders : [],
            sessions: Array.isArray(response.sessions) ? response.sessions : [],
            activeSessionId: response.activeSessionId || response.active?.sessionId || null,
            activeSession: response.active?.session || null
          };
          localSidebarError = '';
          localSidebarLastFetchAt = Date.now();
          return localSidebarData;
        })
        .catch((error) => {
          localSidebarError = error.message || 'Could not load local folders and chats.';
          if (isLocalChatAppConnectionError(error?.message)) {
            setLocalChatAppAvailability(false, localSidebarError);
          }
          throw error;
        })
        .finally(() => {
          localSidebarRefreshPromise = null;
        });

      return localSidebarRefreshPromise;
    }

    function invalidateLocalSidebarCache() {
      localSidebarLastFetchAt = 0;
      if (shouldShowLocalSidebarReplacement()) {
        requestLocalSidebarData(true)
          .then(() => renderLocalSidebarReplacement())
          .catch(() => renderLocalSidebarReplacement());
      }
    }

    function getOrCreateLocalSidebarPanel(root) {
      let panel = document.querySelector(`[${LOCAL_SIDEBAR_MARKER}]`);
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'local-chat-sidebar-panel';
        panel.setAttribute(LOCAL_SIDEBAR_MARKER, 'true');
        panel.addEventListener('pointerdown', handleLocalPinSelectInteractionEvent, true);
        panel.addEventListener('mousedown', handleLocalPinSelectInteractionEvent, true);
        panel.addEventListener('click', handleLocalSidebarClick);
        panel.addEventListener('focusin', handleLocalPinSelectInteractionEvent, true);
        panel.addEventListener('change', handleLocalSidebarChange);
      }

      panel.__localChatSidebarRoot = root;
      return panel;
    }

    function placeLocalSidebarPanel(root, panel, hiddenSections = []) {
      if (!root || !panel) return;
      const insertionTarget =
        hiddenSections.find((section) => section.parentElement === root) || hiddenSections[0] || null;

      if (insertionTarget?.parentElement) {
        insertionTarget.parentElement.insertBefore(panel, insertionTarget);
      } else if (panel.parentElement !== root) {
        root.appendChild(panel);
      }
    }

    function renderLocalSidebarReplacement() {
      const panel = document.querySelector(`[${LOCAL_SIDEBAR_MARKER}]`);
      if (panel) renderLocalSidebarPanel(panel);
    }

    async function refreshLocalSidebarReplacement(force = false) {
      if (!shouldShowLocalSidebarReplacement()) {
        removeLocalSidebarReplacement();
        return;
      }

      const root = findProviderSidebarRoot();
      if (!root) return;

      const hiddenSections = hideNativeProviderSidebarSections(root);
      const panel = getOrCreateLocalSidebarPanel(root);
      placeLocalSidebarPanel(root, panel, hiddenSections);

      const hasRenderedContent = Boolean(panel.innerHTML.trim());
      const cacheIsFresh =
        localSidebarLastFetchAt > 0 && Date.now() - localSidebarLastFetchAt < LOCAL_SIDEBAR_REFRESH_MS;

      if (!force && hasRenderedContent && cacheIsFresh && !localSidebarError) {
        return;
      }

      if (!hasRenderedContent) {
        panel.innerHTML = '<div class="local-chat-sidebar-loading">Loading local folders and chats…</div>';
      }

      try {
        await requestLocalSidebarData(force);
      } catch {}

      renderLocalSidebarPanel(panel);
      updateLoadPastControls();
    }

    function removeLocalSidebarReplacement() {
      document.querySelectorAll?.(`[${LOCAL_SIDEBAR_MARKER}]`).forEach((panel) => panel.remove());
      restoreNativeProviderSidebarSections();
    }

    function scheduleLocalSidebarRefresh(force = false) {
      if (!shouldShowLocalSidebarReplacement()) {
        removeLocalSidebarReplacement();
        return;
      }

      refreshLocalSidebarReplacement(force).catch(() => renderLocalSidebarReplacement());
    }

    async function setLocalSidebarFolder(folderId) {
      localSidebarSelectedFolderId = folderId || null;
      renderLocalSidebarReplacement();
      try {
        await (chromeApi.storage.sync || chromeApi.storage.local).set({
          [LOCAL_SIDEBAR_STORAGE_KEY]: localSidebarSelectedFolderId || ''
        });
      } catch {}
    }

    async function selectLocalSidebarSession(sessionId) {
      if (!sessionId) return;

      if (ensureTemporaryChatUrlForLocalMode({ force: true, pendingSessionId: sessionId })) return;

      localSidebarPendingSessionId = sessionId;
      renderLocalSidebarReplacement();

      const sidebarSession = (Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : []).find(
        (session) => session.id === sessionId
      );
      const fallbackTitle = sidebarSession?.title || 'selected conversation';

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'LOAD_LOCAL_CHAT_EXPORT',
          payload: { sessionId, activate: true }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not load the selected local chat.');

        localSidebarData.activeSessionId = response.sessionId || sessionId;
        if (response.session) localSidebarData.activeSession = response.session;
        localSidebarLastFetchAt = 0;

        const title = response.session?.title || response.sessionTitle || fallbackTitle;
        const exportText = String(response.text || '');

        try {
          await replaceComposerWithText(exportText);
          showToast(
            exportText.trim()
              ? `Loaded local chat → ${title}. Future saves go there.`
              : `Selected empty local chat → ${title}. Future saves go there.`
          );
        } catch (pasteError) {
          showToast(
            `Selected local chat → ${title}, but could not update the textbox: ${pasteError.message || 'textbox not found'}`,
            true
          );
        }

        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not select local chat.', true);
      } finally {
        localSidebarPendingSessionId = '';
        renderLocalSidebarReplacement();
      }
    }

    function openLocalChatTextDialog({ title, label = 'Name', defaultValue = '', submitText = 'Save' } = {}) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'local-chat-modal-backdrop';
        overlay.innerHTML = `
      <div class="local-chat-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Local Chat input')}" style="max-width: 460px;">
        <div class="local-chat-modal-header">
          <div>
            <div class="local-chat-modal-eyebrow">Local Chat</div>
            <h2>${escapeHtml(title || 'Enter a value')}</h2>
            <p>${escapeHtml(label)}</p>
          </div>
          <button type="button" class="local-chat-modal-close" aria-label="Close">×</button>
        </div>
        <div style="padding: 16px 20px 20px; display: grid; gap: 12px;">
          <input class="local-chat-modal-search" style="width: 100%; margin: 0; box-sizing: border-box;" type="text" autocomplete="off" />
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button type="button" class="local-chat-modal-close" data-local-chat-dialog-cancel style="width: auto; height: auto; padding: 8px 12px; font-size: 13px;">Cancel</button>
            <button type="button" class="local-chat-modal-close" data-local-chat-dialog-submit style="width: auto; height: auto; padding: 8px 12px; font-size: 13px; background: rgba(16, 163, 127, 0.9);">${escapeHtml(submitText)}</button>
          </div>
        </div>
      </div>
    `;

        const input = overlay.querySelector('input');
        const cleanup = (value) => {
          document.removeEventListener('keydown', onKeyDown, true);
          overlay.remove();
          resolve(value);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cleanup(null);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            cleanup(input.value);
          }
        };

        overlay.addEventListener('click', (event) => {
          if (
            event.target === overlay ||
            event.target.closest?.('[data-local-chat-dialog-cancel], .local-chat-modal-header .local-chat-modal-close')
          )
            cleanup(null);
          if (event.target.closest?.('[data-local-chat-dialog-submit]')) cleanup(input.value);
        });

        document.addEventListener('keydown', onKeyDown, true);
        document.documentElement.appendChild(overlay);
        input.value = defaultValue || '';
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      });
    }

    function openLocalChatConfirmDialog({ title, message, confirmText = 'Delete' } = {}) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'local-chat-modal-backdrop';
        overlay.innerHTML = `
      <div class="local-chat-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Confirm action')}" style="max-width: 460px;">
        <div class="local-chat-modal-header">
          <div>
            <div class="local-chat-modal-eyebrow">Local Chat</div>
            <h2>${escapeHtml(title || 'Confirm action')}</h2>
            <p>${escapeHtml(message || '')}</p>
          </div>
          <button type="button" class="local-chat-modal-close" aria-label="Close">×</button>
        </div>
        <div style="padding: 16px 20px 20px; display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="local-chat-modal-close" data-local-chat-dialog-cancel style="width: auto; height: auto; padding: 8px 12px; font-size: 13px;">Cancel</button>
          <button type="button" class="local-chat-modal-close" data-local-chat-dialog-submit style="width: auto; height: auto; padding: 8px 12px; font-size: 13px; background: rgba(220, 38, 38, 0.9);">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

        const cleanup = (value) => {
          document.removeEventListener('keydown', onKeyDown, true);
          overlay.remove();
          resolve(value);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cleanup(false);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            cleanup(true);
          }
        };

        overlay.addEventListener('click', (event) => {
          if (
            event.target === overlay ||
            event.target.closest?.('[data-local-chat-dialog-cancel], .local-chat-modal-header .local-chat-modal-close')
          )
            cleanup(false);
          if (event.target.closest?.('[data-local-chat-dialog-submit]')) cleanup(true);
        });

        document.addEventListener('keydown', onKeyDown, true);
        document.documentElement.appendChild(overlay);
      });
    }

    async function createLocalSessionFromSidebar() {
      const { name, key } = providerInfo();
      const title = await openLocalChatTextDialog({
        title: 'Name the new local chat',
        label: 'Session name',
        submitText: 'Create'
      });
      if (title === null) return;

      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        showToast('Session name cannot be empty.', true);
        return;
      }

      const pinnedFolderId =
        localSidebarSelectedFolderId && localSidebarSelectedFolderId !== 'unfiled'
          ? localSidebarSelectedFolderId
          : null;

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'CREATE_LOCAL_CHAT_SESSION',
          payload: {
            title: trimmedTitle,
            provider: name,
            providerKey: key,
            pinnedFolderId
          }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not create session.');
        localSidebarData.activeSessionId = response.sessionId || null;
        showToast(`New local chat active → ${response.sessionTitle || trimmedTitle}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not create local session.', true);
      }
    }

    async function createLocalFolderFromSidebar() {
      const title = await openLocalChatTextDialog({
        title: 'Name the new local folder',
        label: 'Folder name',
        submitText: 'Create'
      });
      if (title === null) return;

      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        showToast('Folder name cannot be empty.', true);
        return;
      }

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'CREATE_LOCAL_CHAT_FOLDER',
          payload: { name: trimmedTitle }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not create folder.');
        localSidebarSelectedFolderId = response.folder?.id || null;
        try {
          await (chromeApi.storage.sync || chromeApi.storage.local).set({
            [LOCAL_SIDEBAR_STORAGE_KEY]: localSidebarSelectedFolderId || ''
          });
        } catch {}
        showToast(`New local folder created → ${response.folder?.name || trimmedTitle}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not create local folder.', true);
      }
    }

    async function updateLocalSidebarSessionFolder(sessionId, pinnedFolderId) {
      if (!sessionId) return;

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'UPDATE_LOCAL_CHAT_SESSION_FOLDER',
          payload: { sessionId, pinnedFolderId: pinnedFolderId || null }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not update folder.');

        const updatedSession = response.session || null;
        const sessions = Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : [];
        localSidebarData.sessions = sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                ...(updatedSession || {}),
                pinnedFolderId: updatedSession?.pinnedFolderId || pinnedFolderId || null
              }
            : session
        );

        if (localSidebarData.activeSessionId === sessionId || localSidebarData.activeSession?.id === sessionId) {
          localSidebarData.activeSession = {
            ...(localSidebarData.activeSession || {}),
            ...(updatedSession || {}),
            id: sessionId,
            pinnedFolderId: updatedSession?.pinnedFolderId || pinnedFolderId || null
          };
        }

        const folderName = pinnedFolderId
          ? (localSidebarData.folders || []).find((folder) => folder.id === pinnedFolderId)?.name || 'selected folder'
          : 'No pinned folder';
        updateLoadPastControls({ force: true });
        showToast(`Updated selected chat folder → ${folderName}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not update selected chat folder.', true);
        scheduleLocalSidebarRefresh(true);
      }
    }

    function localSidebarSessionById(sessionId) {
      return (
        (Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : []).find(
          (session) => session.id === sessionId
        ) || null
      );
    }

    function localSidebarFolderById(folderId) {
      return (
        (Array.isArray(localSidebarData.folders) ? localSidebarData.folders : []).find(
          (folder) => folder.id === folderId
        ) || null
      );
    }

    async function renameLocalSidebarSession(sessionId) {
      if (!sessionId) return;

      const session =
        localSidebarSessionById(sessionId) ||
        (getActiveLocalSidebarSession()?.id === sessionId ? getActiveLocalSidebarSession() : null);
      const currentTitle = session?.title || 'Untitled chat';
      const title = await openLocalChatTextDialog({
        title: 'Rename local chat',
        label: 'Session name',
        defaultValue: currentTitle,
        submitText: 'Rename'
      });
      if (title === null) return;

      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        showToast('Chat title cannot be empty.', true);
        return;
      }

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'UPDATE_LOCAL_CHAT_SESSION_TITLE',
          payload: { sessionId, title: trimmedTitle }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not rename local chat.');

        const updatedSession = response.session || { id: sessionId, title: trimmedTitle };
        const sessions = Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : [];
        localSidebarData.sessions = sessions.map((item) =>
          item.id === sessionId ? { ...item, ...updatedSession, title: updatedSession.title || trimmedTitle } : item
        );

        if (localSidebarData.activeSessionId === sessionId || localSidebarData.activeSession?.id === sessionId) {
          localSidebarData.activeSession = {
            ...(localSidebarData.activeSession || {}),
            ...updatedSession,
            id: sessionId,
            title: updatedSession.title || trimmedTitle
          };
        }

        showToast(`Renamed local chat → ${updatedSession.title || trimmedTitle}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not rename local chat.', true);
        scheduleLocalSidebarRefresh(true);
      }
    }

    async function deleteLocalSidebarSession(sessionId) {
      if (!sessionId) return;

      const session =
        localSidebarSessionById(sessionId) ||
        (getActiveLocalSidebarSession()?.id === sessionId ? getActiveLocalSidebarSession() : null);
      const title = session?.title || 'Untitled chat';
      const confirmed = await openLocalChatConfirmDialog({
        title: 'Delete local chat?',
        message: `"${title}" will be moved to Trash in the local web app.`,
        confirmText: 'Move to Trash'
      });
      if (!confirmed) return;

      localSidebarPendingSessionId = sessionId;
      renderLocalSidebarReplacement();

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'DELETE_LOCAL_CHAT_SESSION',
          payload: { sessionId }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not delete local chat.');

        localSidebarData.sessions = (Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : []).filter(
          (item) => item.id !== sessionId
        );

        const wasActive =
          localSidebarData.activeSessionId === sessionId || localSidebarData.activeSession?.id === sessionId;
        if (wasActive) {
          localSidebarData.activeSessionId = null;
          localSidebarData.activeSession = null;
          try {
            await replaceComposerWithText('');
          } catch {}
        }

        showToast(`Deleted local chat → ${title}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not delete local chat.', true);
        scheduleLocalSidebarRefresh(true);
      } finally {
        localSidebarPendingSessionId = '';
        renderLocalSidebarReplacement();
      }
    }

    async function renameLocalSidebarFolder(folderId) {
      if (!folderId || folderId === 'unfiled') return;

      const folder = localSidebarFolderById(folderId);
      const currentName = folder?.name || 'Untitled folder';
      const name = await openLocalChatTextDialog({
        title: 'Rename local folder',
        label: 'Folder name',
        defaultValue: currentName,
        submitText: 'Rename'
      });
      if (name === null) return;

      const trimmedName = name.trim();
      if (!trimmedName) {
        showToast('Folder name cannot be empty.', true);
        return;
      }

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'UPDATE_LOCAL_CHAT_FOLDER_NAME',
          payload: { folderId, name: trimmedName }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not rename local folder.');

        const updatedFolder = response.folder || { id: folderId, name: trimmedName };
        localSidebarData.folders = (Array.isArray(localSidebarData.folders) ? localSidebarData.folders : []).map(
          (item) =>
            item.id === folderId ? { ...item, ...updatedFolder, name: updatedFolder.name || trimmedName } : item
        );

        showToast(`Renamed local folder → ${updatedFolder.name || trimmedName}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not rename local folder.', true);
        scheduleLocalSidebarRefresh(true);
      }
    }

    async function deleteLocalSidebarFolder(folderId) {
      if (!folderId || folderId === 'unfiled') return;

      const folder = localSidebarFolderById(folderId);
      const name = folder?.name || 'Untitled folder';
      const count = (Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : []).filter(
        (session) => session.pinnedFolderId === folderId
      ).length;
      const confirmed = await openLocalChatConfirmDialog({
        title: 'Delete local folder?',
        message: `"${name}" will be deleted. ${count} chat${count === 1 ? '' : 's'} in this folder will be kept and moved to No pinned folder.`,
        confirmText: 'Delete folder'
      });
      if (!confirmed) return;

      try {
        const response = await chromeApi.runtime.sendMessage({
          type: 'DELETE_LOCAL_CHAT_FOLDER',
          payload: { folderId }
        });

        if (!response?.ok) throw new Error(response?.error || 'Could not delete local folder.');

        localSidebarData.folders = (Array.isArray(localSidebarData.folders) ? localSidebarData.folders : []).filter(
          (item) => item.id !== folderId
        );
        localSidebarData.sessions = (Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : []).map(
          (session) => (session.pinnedFolderId === folderId ? { ...session, pinnedFolderId: null } : session)
        );

        if (localSidebarData.activeSession?.pinnedFolderId === folderId) {
          localSidebarData.activeSession = { ...localSidebarData.activeSession, pinnedFolderId: null };
        }

        if (localSidebarSelectedFolderId === folderId) {
          localSidebarSelectedFolderId = null;
          try {
            await (chromeApi.storage.sync || chromeApi.storage.local).set({ [LOCAL_SIDEBAR_STORAGE_KEY]: '' });
          } catch {}
        }

        showToast(`Deleted local folder → ${name}`);
        scheduleLocalSidebarRefresh(true);
      } catch (error) {
        showToast(error.message || 'Could not delete local folder.', true);
        scheduleLocalSidebarRefresh(true);
      }
    }

    function handleLocalSidebarClick(event) {
      const renameFolderButton = event.target?.closest?.('[data-local-sidebar-rename-folder]');
      if (renameFolderButton) {
        event.preventDefault();
        event.stopPropagation();
        renameLocalSidebarFolder(renameFolderButton.getAttribute('data-local-sidebar-rename-folder'));
        return;
      }

      const deleteFolderButton = event.target?.closest?.('[data-local-sidebar-delete-folder]');
      if (deleteFolderButton) {
        event.preventDefault();
        event.stopPropagation();
        deleteLocalSidebarFolder(deleteFolderButton.getAttribute('data-local-sidebar-delete-folder'));
        return;
      }

      const renameSessionButton = event.target?.closest?.('[data-local-sidebar-rename-session]');
      if (renameSessionButton) {
        event.preventDefault();
        event.stopPropagation();
        renameLocalSidebarSession(renameSessionButton.getAttribute('data-local-sidebar-rename-session'));
        return;
      }

      const deleteSessionButton = event.target?.closest?.('[data-local-sidebar-delete-session]');
      if (deleteSessionButton) {
        event.preventDefault();
        event.stopPropagation();
        deleteLocalSidebarSession(deleteSessionButton.getAttribute('data-local-sidebar-delete-session'));
        return;
      }

      const refreshButton = event.target?.closest?.('[data-local-sidebar-refresh]');
      if (refreshButton) {
        event.preventDefault();
        event.stopPropagation();
        scheduleLocalSidebarRefresh(true);
        return;
      }

      const newFolderButton = event.target?.closest?.('[data-local-sidebar-new-folder]');
      if (newFolderButton) {
        event.preventDefault();
        event.stopPropagation();
        createLocalFolderFromSidebar();
        return;
      }

      const compactButton = event.target?.closest?.('[data-local-sidebar-compact]');
      if (compactButton) {
        event.preventDefault();
        event.stopPropagation();
        if (compactButton.disabled || isCompactionRunning()) return;
        compactButton.disabled = true;
        compactButton.textContent = 'Compacting…';
        Promise.resolve(startCompaction())
          .catch(() => {})
          .finally(() => scheduleLocalSidebarRefresh(true));
        return;
      }

      const newButton = event.target?.closest?.('[data-local-sidebar-new]');
      if (newButton) {
        event.preventDefault();
        event.stopPropagation();
        createLocalSessionFromSidebar();
        return;
      }

      const folderButton = event.target?.closest?.('[data-local-sidebar-folder-id]');
      if (folderButton) {
        event.preventDefault();
        event.stopPropagation();
        setLocalSidebarFolder(folderButton.getAttribute('data-local-sidebar-folder-id') || null);
        return;
      }

      const chatRow = event.target?.closest?.('[data-local-sidebar-session-id]');
      if (chatRow && !event.target?.closest?.('[data-local-sidebar-pin-select]')) {
        const sessionId = chatRow.getAttribute('data-local-sidebar-session-id');
        const disabledButton = chatRow.matches?.('button:disabled')
          ? chatRow
          : chatRow.querySelector?.('.local-chat-sidebar-chat:disabled');
        if (sessionId && !disabledButton) {
          event.preventDefault();
          event.stopPropagation();
          selectLocalSidebarSession(sessionId);
        }
      }
    }

    function handleLocalSidebarChange(event) {
      const select = event.target?.closest?.('[data-local-sidebar-pin-select]');
      if (!select) return;

      markLocalPinSelectInteraction();
      event.stopPropagation();
      updateLocalSidebarSessionFolder(select.getAttribute('data-local-sidebar-session-id'), select.value || null);
    }

    async function loadLocalSidebarPreference() {
      try {
        const data = await (chromeApi.storage.sync || chromeApi.storage.local).get({ [LOCAL_SIDEBAR_STORAGE_KEY]: '' });
        localSidebarSelectedFolderId = data[LOCAL_SIDEBAR_STORAGE_KEY] || null;
      } catch {
        localSidebarSelectedFolderId = null;
      }
    }

    function setActiveSessionFromExport(response = {}, fallbackSessionId = '') {
      localSidebarData.activeSessionId = response.sessionId || fallbackSessionId || null;
      if (response.session) localSidebarData.activeSession = response.session;
      localSidebarLastFetchAt = 0;
    }

    function getData() {
      return {
        folders: Array.isArray(localSidebarData.folders) ? localSidebarData.folders : [],
        sessions: Array.isArray(localSidebarData.sessions) ? localSidebarData.sessions : [],
        activeSessionId: localSidebarData.activeSessionId || localSidebarData.activeSession?.id || null,
        activeSession: localSidebarData.activeSession || null,
        selectedFolderId: localSidebarSelectedFolderId || null,
        error: localSidebarError || '',
        pendingSessionId: localSidebarPendingSessionId || ''
      };
    }

    function setStateForTest(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, 'selectedFolderId'))
        localSidebarSelectedFolderId = options.selectedFolderId || null;
      if (Object.prototype.hasOwnProperty.call(options, 'data'))
        localSidebarData = { folders: [], sessions: [], activeSessionId: null, ...(options.data || {}) };
      if (Object.prototype.hasOwnProperty.call(options, 'error')) localSidebarError = options.error || '';
      if (Object.prototype.hasOwnProperty.call(options, 'pendingSessionId'))
        localSidebarPendingSessionId = options.pendingSessionId || '';
      if (Object.prototype.hasOwnProperty.call(options, 'lastFetchAt'))
        localSidebarLastFetchAt = Number(options.lastFetchAt || 0);
    }

    function resetForTest() {
      localSidebarSelectedFolderId = null;
      localSidebarLastFetchAt = 0;
      localSidebarRefreshPromise = null;
      localSidebarData = { folders: [], sessions: [], activeSessionId: null };
      localSidebarError = '';
      localSidebarPendingSessionId = '';
      localPinSelectInteractionUntil = 0;
    }

    return {
      constants: {
        LOCAL_SIDEBAR_STORAGE_KEY,
        LOCAL_SIDEBAR_PENDING_LOAD_SESSION_KEY,
        LOCAL_SIDEBAR_REFRESH_MS,
        LOCAL_SIDEBAR_MAX_CHATS
      },
      supportsLocalSidebarReplacement,
      shouldShowLocalSidebarReplacement,
      sidebarProviderHints,
      findProviderSidebarRoot,
      findNativeProviderSidebarSections,
      hideNativeProviderSidebarSections,
      restoreNativeProviderSidebarSections,
      folderCountsForLocalSidebar,
      sessionsForLocalSidebarFolder,
      folderLabelForLocalSidebar,
      renderLocalSidebarPanel,
      requestLocalSidebarData,
      invalidateLocalSidebarCache,
      renderLocalSidebarReplacement,
      refreshLocalSidebarReplacement,
      removeLocalSidebarReplacement,
      scheduleLocalSidebarRefresh,
      setLocalSidebarFolder,
      selectLocalSidebarSession,
      updateLocalSidebarSessionFolder,
      handleLocalSidebarClick,
      handleLocalSidebarChange,
      loadLocalSidebarPreference,
      getActiveLocalSidebarSession,
      currentLocalChatTarget,
      markLocalPinSelectInteraction,
      isLocalPinSelectElement,
      isLocalPinSelectInteracting,
      handleLocalPinSelectInteractionEvent,
      consumePendingLocalSidebarLoad,
      storePendingLocalSidebarLoad,
      setActiveSessionFromExport,
      getData,
      setStateForTest,
      resetForTest
    };
  }

  return {
    DEFAULTS,
    createSidebarController
  };
});
