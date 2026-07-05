(function exposeLocalChatContentComposer(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentComposer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentComposer() {
  'use strict';

  const DEFAULTS = Object.freeze({
    clipboardCaptureTimeoutMs: 900,
    clipboardCapturePollMs: 80,
    pastedAttachmentWatchMs: 5000,
    pastedAttachmentPollMs: 180,
    composerReadyTimeoutMs: 15000,
    composerReadyPollMs: 150,
    modalSearchDebounceMs: 260,
    composerClearSettleMs: 180
  });

  function createComposerController(deps = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const markers = deps.markers || {};
    const EXT_MARKER = markers.EXT_MARKER || 'data-local-chat-save';
    const NEW_SESSION_MARKER = markers.NEW_SESSION_MARKER || 'data-local-chat-new-session';
    const LOAD_PAST_MARKER = markers.LOAD_PAST_MARKER || 'data-local-chat-load-past';
    const TOP_PIN_SELECT_MARKER = markers.TOP_PIN_SELECT_MARKER || 'data-local-chat-top-pin-select';
    const AUTO_SEND_TOGGLE_MARKER = markers.AUTO_SEND_TOGGLE_MARKER || 'data-local-chat-auto-send';
    const LOCAL_SIDEBAR_MARKER = markers.LOCAL_SIDEBAR_MARKER || 'data-local-chat-sidebar';
    const LOAD_PAST_MODAL_ID = markers.LOAD_PAST_MODAL_ID || 'local-chat-load-past-modal';

    const normalizeText =
      deps.normalizeText ||
      ((value) =>
        String(value || '')
          .trim()
          .replace(/\s+/g, ' '));
    const isVisibleElement =
      deps.isVisibleElement ||
      ((element) => {
        const rect = element?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      });
    const escapeHtml =
      deps.escapeHtml ||
      ((value) =>
        String(value ?? '').replace(
          /[&<>"']/g,
          (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
        ));
    const formatLocalDate = deps.formatLocalDate || ((value) => String(value || ''));
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const shouldExposeLocalChatUi = deps.shouldExposeLocalChatUi || (() => true);
    const showToast = deps.showToast || (() => {});
    const resetComposerSnapshot = deps.resetComposerSnapshot || (() => {});
    const getSidebarData = deps.getSidebarData || (() => ({ folders: [], sessions: [], activeSessionId: null }));
    const getActiveLocalSidebarSession = deps.getActiveLocalSidebarSession || (() => null);
    const setActiveSessionFromExport = deps.setActiveSessionFromExport || (() => {});
    const requestLocalSidebarData =
      deps.requestLocalSidebarData || (() => Promise.resolve({ folders: [], sessions: [], activeSessionId: null }));
    const scheduleLocalSidebarRefresh = deps.scheduleLocalSidebarRefresh || (() => {});
    const isLocalPinSelectElement = deps.isLocalPinSelectElement || (() => false);
    const markLocalPinSelectInteraction = deps.markLocalPinSelectInteraction || (() => {});
    const isLocalPinSelectInteracting = deps.isLocalPinSelectInteracting || (() => false);
    const handleLocalPinSelectInteractionEvent = deps.handleLocalPinSelectInteractionEvent || (() => {});
    const handleLocalSidebarChange = deps.handleLocalSidebarChange || (() => {});
    const chromeApi = deps.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);

    function extensionChrome() {
      if (!chromeApi?.runtime?.sendMessage) throw new Error('Browser extension APIs are unavailable.');
      return chromeApi;
    }

    function isExtensionOwnedElement(element) {
      return Boolean(
        element?.closest?.(`
      [${EXT_MARKER}],
      [${NEW_SESSION_MARKER}],
      [${LOAD_PAST_MARKER}],
      [${TOP_PIN_SELECT_MARKER}],
      [${AUTO_SEND_TOGGLE_MARKER}],
      [${LOCAL_SIDEBAR_MARKER}],
      #${LOAD_PAST_MODAL_ID}
    `)
      );
    }

    function isDisabledControl(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
      return Boolean(
        element.disabled ||
        element.getAttribute('aria-disabled') === 'true' ||
        element.getAttribute('disabled') !== null ||
        element.closest?.('[aria-disabled="true"], [disabled]')
      );
    }

    function isLikelyComposerInput(input) {
      if (!input || input.nodeType !== Node.ELEMENT_NODE) return false;
      if (!document.documentElement.contains(input)) return false;
      if (isExtensionOwnedElement(input)) return false;

      const tag = input.tagName?.toLowerCase();
      const editable =
        tag === 'textarea' ||
        tag === 'input' ||
        input.isContentEditable ||
        input.getAttribute('contenteditable') === 'true';
      if (!editable) return false;
      if (isDisabledControl(input)) return false;

      const label = [
        input.id,
        input.getAttribute('aria-label'),
        input.getAttribute('aria-placeholder'),
        input.getAttribute('placeholder'),
        input.getAttribute('data-testid'),
        input.getAttribute('role'),
        input.getAttribute('name')
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (/prompt|composer|message|ask|textbox/.test(label)) return true;
      if (input.closest?.('form')) return true;

      // Keep a broad fallback for AI sites that expose an unlabeled contenteditable
      // composer. Long local transcripts should still be clearable after paste.
      if (input.closest?.('main, [role="main"], form, [data-testid*="composer" i], [class*="composer" i]')) return true;

      const currentText =
        tag === 'textarea' || tag === 'input'
          ? String(input.value || '')
          : String(input.innerText || input.textContent || '');
      return currentText.trim().length < 2000;
    }

    function findComposerContainer() {
      const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'))
        .filter(
          (input) =>
            isVisibleElement(input) ||
            document.activeElement === input ||
            /prompt|composer/i.test(`${input.id || ''} ${input.getAttribute?.('data-testid') || ''}`)
        )
        .filter(isLikelyComposerInput);

      for (const input of inputs.reverse()) {
        let node = input;
        let depth = 0;
        const fallback = input.closest?.('form') || input.parentElement || null;

        while (node && node !== document.body && depth < 10) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const buttons = node.querySelectorAll?.('button, [role="button"], input[type="file"]');
            const hasUsefulButtons = buttons && buttons.length > 0;
            if (hasUsefulButtons) return node;
          }

          node = node.parentElement;
          depth += 1;
        }

        if (fallback) return fallback;
      }

      return null;
    }

    function isFileAttachButton(button, composer) {
      if (!button || button.nodeType !== Node.ELEMENT_NODE) return false;
      if (
        button.hasAttribute(EXT_MARKER) ||
        button.hasAttribute(NEW_SESSION_MARKER) ||
        button.hasAttribute(LOAD_PAST_MARKER) ||
        button.hasAttribute(TOP_PIN_SELECT_MARKER) ||
        button.hasAttribute(AUTO_SEND_TOGGLE_MARKER) ||
        button.closest?.(`[${LOAD_PAST_MARKER}], [${LOCAL_SIDEBAR_MARKER}]`)
      )
        return false;
      if (!composer?.contains(button)) return false;

      const label = [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-testid'),
        button.textContent
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .toLowerCase();

      if (button.matches?.('input[type="file"]')) return true;
      if (button.querySelector?.('input[type="file"]')) return true;
      if (/(attach|upload|file|files|photo|image|add photos|add files)/i.test(label)) return true;

      const compactPlusButton =
        (button.textContent || '').trim() === '+' &&
        button.getBoundingClientRect().width <= 54 &&
        button.getBoundingClientRect().height <= 54;

      return compactPlusButton && !label.includes('new chat') && !label.includes('copy');
    }

    function findAttachButton() {
      const composer = findComposerContainer();
      if (!composer) return null;

      const candidates = Array.from(composer.querySelectorAll('button, [role="button"], input[type="file"]')).filter(
        (button) => isVisibleElement(button) && isFileAttachButton(button, composer)
      );

      return candidates[0] || null;
    }

    function removeLoadPastButtons() {
      if (typeof document === 'undefined') return;
      document.querySelectorAll(`[${LOAD_PAST_MARKER}]`).forEach((button) => button.remove());
    }

    function setNativeValue(element, value) {
      const tag = element.tagName?.toLowerCase();
      const property = tag === 'textarea' || tag === 'input' ? 'value' : 'textContent';
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      const ownDescriptor = Object.getOwnPropertyDescriptor(element, property);
      const setter = descriptor?.set || ownDescriptor?.set;

      if (setter) setter.call(element, value);
      else element[property] = value;
    }

    function dispatchComposerInputEvents(input, text) {
      try {
        input.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          })
        );
      } catch {}

      try {
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: text
          })
        );
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearComposerInput(input) {
      if (!input) return false;

      const tag = input.tagName?.toLowerCase();
      input.focus();

      if (tag === 'textarea' || tag === 'input') {
        setNativeValue(input, '');
        try {
          input.setSelectionRange(0, 0);
        } catch {}
      } else {
        try {
          input.innerHTML = '';
        } catch {
          setNativeValue(input, '');
        }
      }

      try {
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null
          })
        );
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    function elementLooksLikePastedTextAttachment(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE || !isVisibleElement(element)) return false;

      const label = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.textContent
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (!label || label.length > 800) return false;

      return Boolean(
        label.includes('pasted text') ||
        label.includes('too long to show') ||
        (label.includes('pasted') && label.includes('attachment')) ||
        (label.includes('pasted') && label.includes('.txt')) ||
        (label.includes('text') && label.includes('attachment') && label.includes('remove'))
      );
    }

    function hasPastedTextAttachment(composer = null) {
      const roots = [];
      if (composer) roots.push(composer);

      const widerComposer = composer?.parentElement || composer?.closest?.('form') || null;
      if (widerComposer && !roots.includes(widerComposer)) roots.push(widerComposer);
      roots.push(document.body);

      const selector = ['[aria-label]', '[title]', '[data-testid]', 'button', '[role="button"]', 'span', 'div'].join(
        ','
      );

      for (const root of roots) {
        const candidates = Array.from(root.querySelectorAll?.(selector) || []);
        if (candidates.some(elementLooksLikePastedTextAttachment)) return true;
      }

      return false;
    }

    function composerAttachmentRoots(composer = null) {
      const roots = [];
      const add = (element) => {
        if (!element || roots.includes(element)) return;
        if (element === document.body || element === document.documentElement) return;
        roots.push(element);
      };

      add(composer);
      add(composer?.closest?.('form'));
      add(composer?.parentElement);
      add(composer?.parentElement?.parentElement);

      return roots.filter((root) => {
        const text = normalizeText(root.innerText || root.textContent || '');
        return text.length < 7000;
      });
    }

    function elementHasPastedTextAttachmentNearby(element, composer = null) {
      let node = element?.nodeType === Node.ELEMENT_NODE ? element : element?.parentElement;
      let depth = 0;

      while (node && node !== document.body && node !== document.documentElement && depth < 7) {
        if (elementLooksLikePastedTextAttachment(node)) return true;
        if (composer && node === composer) break;
        node = node.parentElement;
        depth += 1;
      }

      return false;
    }

    function isAttachmentRemoveButton(button, composer = null) {
      if (!button || button.nodeType !== Node.ELEMENT_NODE) return false;
      if (!button.matches?.('button, [role="button"]')) return false;
      if (!isVisibleElement(button)) return false;
      if (
        button.closest?.(
          `[${EXT_MARKER}], [${LOAD_PAST_MARKER}], [${TOP_PIN_SELECT_MARKER}], [${AUTO_SEND_TOGGLE_MARKER}], [${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`
        )
      )
        return false;

      const label = [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-testid'),
        button.textContent
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (!/(remove|delete|dismiss|close|clear|x)/i.test(label)) return false;
      return (
        elementHasPastedTextAttachmentNearby(button, composer) ||
        elementLooksLikePastedTextAttachment(button) ||
        elementLooksLikePastedTextAttachment(button.parentElement)
      );
    }

    async function removePastedTextAttachmentsNearComposer(composer = null) {
      const roots = composerAttachmentRoots(composer);
      let removed = false;

      for (const root of roots) {
        const buttons = Array.from(root.querySelectorAll?.('button, [role="button"]') || []).filter((button) =>
          isAttachmentRemoveButton(button, root)
        );

        for (const button of buttons) {
          try {
            button.click();
            removed = true;
            await sleep(80);
          } catch {}
        }
      }

      return removed;
    }

    async function waitForComposerInput(timeoutMs = config.composerReadyTimeoutMs) {
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        const input = chooseComposerInput();
        if (input && document.documentElement.contains(input) && isLikelyComposerInput(input)) {
          return input;
        }
        await sleep(config.composerReadyPollMs);
      }

      return null;
    }

    async function clearComposerForLocalChatLoad(input = null) {
      let targetInput = input && document.documentElement.contains(input) ? input : await waitForComposerInput();
      if (!targetInput) throw new Error('Could not find the message textbox.');

      let composer = findComposerContainerNear(targetInput) || findComposerContainer();
      const clearInputs = () => {
        const inputs = composerInputs(composer);
        if (inputs.length) {
          inputs.forEach(clearComposerInput);
        } else if (targetInput && document.documentElement.contains(targetInput)) {
          clearComposerInput(targetInput);
        }
      };

      clearInputs();
      await removePastedTextAttachmentsNearComposer(composer);
      await sleep(config.composerClearSettleMs);

      targetInput = (await waitForComposerInput(3000)) || targetInput;
      composer = findComposerContainerNear(targetInput) || findComposerContainer() || composer;
      clearInputs();

      resetComposerSnapshot();
      return targetInput;
    }

    async function replaceComposerWithText(text) {
      await clearComposerForLocalChatLoad();
      const value = String(text || '');
      if (!value) return true;
      return pasteTextIntoComposer(value);
    }

    async function clearComposerTextIfPastedAttachmentAppears(input, originalText = '') {
      const composer = findComposerContainerNear(input) || findComposerContainer();
      const startedAt = Date.now();

      while (Date.now() - startedAt < config.pastedAttachmentWatchMs) {
        if (hasPastedTextAttachment(composer)) {
          const currentText = textFromComposerInput(input);
          if (
            currentText &&
            (!originalText ||
              currentText.includes(normalizeText(originalText).slice(0, 400)) ||
              currentText.length > 2000)
          ) {
            clearComposerInput(input);
            showToast('Detected a pasted-text attachment, so I cleared the duplicate textbox content.');
          }
          return true;
        }

        await sleep(config.pastedAttachmentPollMs);
      }

      return false;
    }

    function chooseComposerInput() {
      const composer = findComposerContainer();
      const inputs = composerInputs(composer);
      if (!inputs.length) return null;

      const active = document.activeElement;
      if (active && inputs.includes(active)) return active;

      return inputs[inputs.length - 1];
    }

    async function tryPasteEvent(input, text) {
      try {
        const before = textFromComposerInput(input);
        const data = new DataTransfer();
        data.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data
        });

        input.focus();
        input.dispatchEvent(pasteEvent);
        await sleep(120);
        if (hasPastedTextAttachment(findComposerContainerNear(input) || findComposerContainer())) {
          await clearComposerTextIfPastedAttachmentAppears(input, text);
          return true;
        }
        return textFromComposerInput(input) !== before;
      } catch {
        return false;
      }
    }

    async function pasteTextIntoComposer(text) {
      const input = await waitForComposerInput();
      const value = String(text || '');
      if (!input || !value) throw new Error('Could not find the message textbox.');

      const tag = input.tagName?.toLowerCase();
      input.focus();

      if (tag === 'textarea' || tag === 'input') {
        const current = input.value || '';
        const start = typeof input.selectionStart === 'number' ? input.selectionStart : current.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : current.length;
        const nextValue = current.slice(0, start) + value + current.slice(end);

        setNativeValue(input, nextValue);
        const cursor = start + value.length;
        try {
          input.setSelectionRange(cursor, cursor);
        } catch {}
        dispatchComposerInputEvents(input, value);
        clearComposerTextIfPastedAttachmentAppears(input, value);
        return true;
      }

      if (await tryPasteEvent(input, value)) return true;

      const before = textFromComposerInput(input);
      try {
        document.execCommand('insertText', false, value);
        await sleep(80);
        if (textFromComposerInput(input) !== before) {
          dispatchComposerInputEvents(input, value);
          clearComposerTextIfPastedAttachmentAppears(input, value);
          return true;
        }
      } catch {}

      setNativeValue(input, value);
      dispatchComposerInputEvents(input, value);
      clearComposerTextIfPastedAttachmentAppears(input, value);
      return true;
    }

    function renderLocalChatList(listEl, chats, query = '') {
      const items = Array.isArray(chats) ? chats : [];
      const hasQuery = Boolean(normalizeText(query));

      if (!items.length) {
        listEl.innerHTML = hasQuery
          ? '<div class="local-chat-modal-empty">No local conversations matched your search.</div>'
          : '<div class="local-chat-modal-empty">No local conversations found yet.</div>';
        return;
      }

      listEl.innerHTML = items
        .map((chat) => {
          const match = chat.match || {};
          const snippets = Array.isArray(match.snippets) ? match.snippets : [];
          const preview = match.preview || snippets[0]?.snippet || '';
          const matchLabel = hasQuery
            ? `${Number(match.messageCount || snippets.length || 0)} message match${Number(match.messageCount || snippets.length || 0) === 1 ? '' : 'es'}`
            : '';

          return `
        <button type="button" class="local-chat-modal-item" data-local-chat-session-id="${escapeHtml(chat.id)}">
          <span class="local-chat-modal-item-title">${escapeHtml(chat.title || 'Untitled chat')}</span>
          <span class="local-chat-modal-item-meta">${escapeHtml(chat.aiName || 'AI Bot')} · ${Number(chat.messageCount || 0)} messages · ${escapeHtml(formatLocalDate(chat.updatedAt))}${matchLabel ? ` · ${escapeHtml(matchLabel)}` : ''}</span>
          ${preview ? `<span class="local-chat-modal-item-snippet">${escapeHtml(preview)}</span>` : ''}
        </button>
      `;
        })
        .join('');
    }

    function debounce(fn, delay = 250) {
      let timer = null;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
      };
    }

    async function requestLocalChatSearch(query = '') {
      const messageType = normalizeText(query) ? 'SEARCH_LOCAL_CHATS' : 'LIST_RECENT_LOCAL_CHATS';
      const response = await extensionChrome().runtime.sendMessage({
        type: messageType,
        payload: normalizeText(query) ? { query, limit: 200 } : { limit: 200 }
      });

      if (!response?.ok) throw new Error(response?.error || 'Could not load local conversations.');
      return Array.isArray(response.chats) ? response.chats : [];
    }

    async function listRecentLocalChatsForModal(listEl, searchInput = null) {
      let searchCounter = 0;

      async function runSearch(query = '') {
        const requestId = ++searchCounter;
        listEl.innerHTML = normalizeText(query)
          ? '<div class="local-chat-modal-loading">Searching inside local conversations…</div>'
          : '<div class="local-chat-modal-loading">Loading recent local conversations…</div>';

        try {
          const chats = await requestLocalChatSearch(query);
          if (requestId !== searchCounter) return;
          renderLocalChatList(listEl, chats, query);
        } catch (error) {
          if (requestId !== searchCounter) return;
          listEl.innerHTML = `<div class="local-chat-modal-error">${escapeHtml(error.message || 'Could not load local conversations.')}</div>`;
        }
      }

      if (searchInput) {
        const debouncedSearch = debounce(() => runSearch(searchInput.value), config.modalSearchDebounceMs);
        searchInput.addEventListener('input', debouncedSearch);
      }

      listEl.addEventListener('click', async (event) => {
        const button = event.target?.closest?.('[data-local-chat-session-id]');
        if (!button) return;

        const sessionId = button.getAttribute('data-local-chat-session-id');
        const previousText = button.querySelector('.local-chat-modal-item-title')?.textContent || 'Conversation';
        button.disabled = true;
        button.classList.add('loading');

        try {
          const exportResponse = await extensionChrome().runtime.sendMessage({
            type: 'LOAD_LOCAL_CHAT_EXPORT',
            payload: { sessionId, activate: true }
          });

          if (!exportResponse?.ok)
            throw new Error(exportResponse?.error || 'Could not load the selected conversation.');

          setActiveSessionFromExport(exportResponse, sessionId);
          await replaceComposerWithText(exportResponse.text || '');
          closeLoadPastModal();
          updateLoadPastControls();
          scheduleLocalSidebarRefresh(true);
          showToast(
            `Selected local conversation → ${exportResponse.session?.title || previousText}. Future saves go there.`
          );
        } catch (error) {
          button.disabled = false;
          button.classList.remove('loading');
          showToast(error.message || 'Could not paste local conversation.', true);
        }
      });

      await runSearch(searchInput?.value || '');
    }

    function closeLoadPastModal() {
      if (typeof document === 'undefined') return;
      document.getElementById(LOAD_PAST_MODAL_ID)?.remove();
    }

    function openLoadPastModal() {
      closeLoadPastModal();

      const overlay = document.createElement('div');
      overlay.id = LOAD_PAST_MODAL_ID;
      overlay.className = 'local-chat-modal-backdrop';
      overlay.innerHTML = `
      <div class="local-chat-modal-card" role="dialog" aria-modal="true" aria-label="Load past local conversations">
        <div class="local-chat-modal-header">
          <div>
            <div class="local-chat-modal-eyebrow">Local Chat</div>
            <h2>Load past conversations</h2>
            <p>Pick a local conversation. It becomes the active Local Chat target, and its “Copy entire chat” text is pasted into this chat box without sending.</p>
          </div>
          <button type="button" class="local-chat-modal-close" aria-label="Close">×</button>
        </div>
        <input class="local-chat-modal-search" type="search" placeholder="Search titles and full chat contents…" autocomplete="off" />
        <div class="local-chat-modal-list"></div>
      </div>
    `;

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target.closest?.('.local-chat-modal-close')) closeLoadPastModal();
      });

      document.addEventListener(
        'keydown',
        function handleEscape(event) {
          if (event.key !== 'Escape') return;
          closeLoadPastModal();
          document.removeEventListener('keydown', handleEscape, true);
        },
        true
      );

      document.body.appendChild(overlay);

      const listEl = overlay.querySelector('.local-chat-modal-list');
      const searchInput = overlay.querySelector('.local-chat-modal-search');
      searchInput?.focus();

      listRecentLocalChatsForModal(listEl, searchInput).catch((error) => {
        listEl.innerHTML = `<div class="local-chat-modal-error">${escapeHtml(error.message || 'Could not load local conversations.')}</div>`;
      });
    }

    function renderTopActiveChatFolderSelect() {
      const sidebarData = getSidebarData();
      const folders = Array.isArray(sidebarData.folders) ? sidebarData.folders : [];
      const activeSession = getActiveLocalSidebarSession();

      if (!activeSession?.id) {
        return `
        <select class="local-chat-top-folder-select" ${TOP_PIN_SELECT_MARKER} disabled title="Select a local chat first">
          <option>No active local chat</option>
        </select>
      `;
      }

      const currentFolderId = activeSession.pinnedFolderId || '';
      const folderOptions = folders
        .map(
          (folder) => `
      <option value="${escapeHtml(folder.id)}"${folder.id === currentFolderId ? ' selected' : ''}>${escapeHtml(folder.name || 'Untitled folder')}</option>
    `
        )
        .join('');

      return `
      <select class="local-chat-top-folder-select" ${TOP_PIN_SELECT_MARKER} data-local-sidebar-pin-select data-local-sidebar-session-id="${escapeHtml(activeSession.id)}" title="Folder for active local chat">
        <option value=""${currentFolderId ? '' : ' selected'}>No pinned folder</option>
        ${folderOptions}
      </select>
    `;
    }

    function updateLoadPastControls(options = {}) {
      const controls = document.querySelector(`[${LOAD_PAST_MARKER}]`);
      if (!controls) return;

      const holder = controls.querySelector('.local-chat-top-folder-holder');
      if (!holder) return;

      if (!options.force && isLocalPinSelectInteracting(holder)) return;
      holder.innerHTML = renderTopActiveChatFolderSelect();
    }

    function createLoadPastControls() {
      const controls = document.createElement('div');
      controls.className = 'local-chat-top-controls';
      controls.setAttribute(LOAD_PAST_MARKER, 'true');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'local-chat-top-load-btn';
      button.textContent = 'Load past conversations';
      button.title = 'Select a local conversation as the active save target and paste its context without sending it';

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openLoadPastModal();
      });

      const holder = document.createElement('span');
      holder.className = 'local-chat-top-folder-holder';
      holder.innerHTML = renderTopActiveChatFolderSelect();

      controls.addEventListener('pointerdown', handleLocalPinSelectInteractionEvent, true);
      controls.addEventListener('mousedown', handleLocalPinSelectInteractionEvent, true);
      controls.addEventListener('focusin', handleLocalPinSelectInteractionEvent, true);

      controls.addEventListener('click', (event) => {
        if (isLocalPinSelectElement(event.target)) markLocalPinSelectInteraction();
        event.stopPropagation();
      });

      controls.addEventListener('change', handleLocalSidebarChange);
      controls.append(button, holder);
      return controls;
    }

    function injectLoadPastButton() {
      if (!shouldExposeLocalChatUi()) {
        removeLoadPastButtons();
        return;
      }

      if (hasVisibleChatMessage()) {
        removeLoadPastButtons();
        return;
      }

      if (!findComposerContainer()) return;

      let controls = document.querySelector(`[${LOAD_PAST_MARKER}]`);
      if (!controls) {
        controls = createLoadPastControls();
        document.body.appendChild(controls);
      }

      updateLoadPastControls();
      if (!isLocalPinSelectInteracting(controls)) {
        requestLocalSidebarData(false)
          .then(() => updateLoadPastControls())
          .catch(() => updateLoadPastControls());
      }
    }

    function isInsideComposer(element) {
      const composer = findComposerContainer();
      return Boolean(composer && element && (composer === element || composer.contains(element)));
    }

    function hasVisibleChatMessage() {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            '[data-message-author-role="user"]',
            '[data-message-author-role="assistant"]',
            '[data-testid^="conversation-turn"]',
            '[data-testid="message-content"]',
            '.markdown',
            '.prose',
            'article'
          ].join(',')
        )
      );

      return candidates.some((element) => {
        if (!isVisibleElement(element)) return false;
        if (
          element.hasAttribute(NEW_SESSION_MARKER) ||
          element.hasAttribute(EXT_MARKER) ||
          element.hasAttribute(LOAD_PAST_MARKER) ||
          element.hasAttribute(AUTO_SEND_TOGGLE_MARKER)
        )
          return false;
        if (
          element.closest?.(
            `[${NEW_SESSION_MARKER}], [${EXT_MARKER}], [${LOAD_PAST_MARKER}], [${AUTO_SEND_TOGGLE_MARKER}], #${LOAD_PAST_MODAL_ID}`
          )
        )
          return false;
        if (isInsideComposer(element)) return false;

        const text = normalizeText(element.innerText || element.textContent || '');
        if (text.length < 2) return false;

        const explicitTurn = element.matches?.(
          '[data-message-author-role], [data-testid^="conversation-turn"], [data-testid="message-content"]'
        );
        const nestedTurn = element.querySelector?.(
          '[data-message-author-role], [data-testid^="conversation-turn"], [data-testid="message-content"]'
        );
        const hasActionBar = Boolean(element.querySelector?.('button, [role="button"]'));

        if (explicitTurn || nestedTurn) return true;
        return text.length > 20 && hasActionBar;
      });
    }

    function findComposerContainerNear(startNode) {
      let node = startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement;
      let depth = 0;

      while (node && node !== document.body && depth < 12) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const inputs = Array.from(
            node.querySelectorAll?.('textarea, input[type="text"], [contenteditable="true"]') || []
          ).filter(
            (input) => isLikelyComposerInput(input) && (isVisibleElement(input) || document.activeElement === input)
          );
          const buttons = Array.from(node.querySelectorAll?.('button, [role="button"]') || []).filter(isVisibleElement);

          if (inputs.length && (buttons.length || node.matches?.('form'))) return node;
        }

        node = node.parentElement;
        depth += 1;
      }

      return findComposerContainer();
    }

    function composerInputs(composer) {
      if (!composer) return [];

      return Array.from(composer.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'))
        .filter(
          (input) =>
            isVisibleElement(input) ||
            document.activeElement === input ||
            /prompt|composer/i.test(`${input.id || ''} ${input.getAttribute?.('data-testid') || ''}`)
        )
        .filter(isLikelyComposerInput);
    }

    function findComposerInputFromTarget(target) {
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return null;

      const direct = target.matches?.('textarea, [contenteditable="true"]')
        ? target
        : target.closest?.('textarea, [contenteditable="true"]');
      if (direct && isVisibleElement(direct)) return direct;

      return null;
    }

    function textFromComposerInput(input) {
      if (!input) return '';
      const tag = input.tagName?.toLowerCase();

      if (tag === 'textarea' || tag === 'input') {
        return normalizeText(input.value || '');
      }

      return normalizeText(input.innerText || input.textContent || '');
    }

    function textFromComposer(composer, preferredInput = null) {
      const inputs = composerInputs(composer);
      const candidates = [];

      if (preferredInput && inputs.includes(preferredInput)) {
        candidates.push(textFromComposerInput(preferredInput));
      }

      for (const input of inputs) {
        if (input !== preferredInput) candidates.push(textFromComposerInput(input));
      }

      return (
        candidates
          .map(normalizeText)
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || ''
      );
    }

    function buttonLabel(button) {
      return [
        button?.getAttribute?.('aria-label'),
        button?.getAttribute?.('title'),
        button?.getAttribute?.('data-testid'),
        button?.getAttribute?.('data-state'),
        button?.textContent
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .toLowerCase();
    }

    function isSendButtonLike(button) {
      if (!button || button.nodeType !== Node.ELEMENT_NODE) return false;
      if (
        button.hasAttribute(EXT_MARKER) ||
        button.hasAttribute(NEW_SESSION_MARKER) ||
        button.hasAttribute(LOAD_PAST_MARKER) ||
        button.hasAttribute(TOP_PIN_SELECT_MARKER) ||
        button.hasAttribute(AUTO_SEND_TOGGLE_MARKER) ||
        button.closest?.(`[${LOAD_PAST_MARKER}], [${LOCAL_SIDEBAR_MARKER}]`)
      )
        return false;
      if (!button.matches?.('button, [role="button"]')) return false;
      if (!isVisibleElement(button)) return false;

      const label = buttonLabel(button);
      if (/(copy|attach|upload|file|image|photo|new chat|new session|stop|cancel|voice|mic|microphone)/i.test(label)) {
        return false;
      }

      if (/\b(send|submit)\b/i.test(label)) return true;
      if (/send-button|composer-submit|submit-button/i.test(label)) return true;
      if (button.getAttribute('type') === 'submit' && findComposerContainerNear(button)) return true;

      return false;
    }

    function isSendButton(button) {
      return isSendButtonLike(button) && !isDisabledControl(button);
    }

    function findSendButtonNear(startNode) {
      const composer = findComposerContainerNear(startNode);
      if (!composer) return null;

      return Array.from(composer.querySelectorAll('button, [role="button"]')).find(isSendButton) || null;
    }

    function resetForTest() {
      closeLoadPastModal();
      removeLoadPastButtons();
    }

    return {
      constants: {
        PASTED_ATTACHMENT_WATCH_MS: config.pastedAttachmentWatchMs,
        PASTED_ATTACHMENT_POLL_MS: config.pastedAttachmentPollMs,
        COMPOSER_READY_TIMEOUT_MS: config.composerReadyTimeoutMs,
        COMPOSER_READY_POLL_MS: config.composerReadyPollMs
      },
      isExtensionOwnedElement,
      isDisabledControl,
      isLikelyComposerInput,
      findComposerContainer,
      isFileAttachButton,
      findAttachButton,
      removeLoadPastButtons,
      setNativeValue,
      dispatchComposerInputEvents,
      clearComposerInput,
      elementLooksLikePastedTextAttachment,
      hasPastedTextAttachment,
      composerAttachmentRoots,
      isAttachmentRemoveButton,
      removePastedTextAttachmentsNearComposer,
      waitForComposerInput,
      clearComposerForLocalChatLoad,
      replaceComposerWithText,
      clearComposerTextIfPastedAttachmentAppears,
      chooseComposerInput,
      tryPasteEvent,
      pasteTextIntoComposer,
      renderLocalChatList,
      debounce,
      requestLocalChatSearch,
      listRecentLocalChatsForModal,
      closeLoadPastModal,
      openLoadPastModal,
      renderTopActiveChatFolderSelect,
      updateLoadPastControls,
      createLoadPastControls,
      injectLoadPastButton,
      isInsideComposer,
      hasVisibleChatMessage,
      findComposerContainerNear,
      composerInputs,
      findComposerInputFromTarget,
      textFromComposerInput,
      textFromComposer,
      buttonLabel,
      isSendButtonLike,
      isSendButton,
      findSendButtonNear,
      resetForTest
    };
  }

  return {
    DEFAULTS,
    createComposerController
  };
});
