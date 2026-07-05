(function exposeLocalChatContentMessageSave(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentMessageSave = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentMessageSave() {
  'use strict';

  const DEFAULTS = Object.freeze({
    clipboardCaptureTimeoutMs: 900,
    clipboardCapturePollMs: 80
  });

  function createMessageSaveController(deps = {}, options = {}) {
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
    const selectionInside = deps.selectionInside || (() => '');
    const findMessageContainer = deps.findMessageContainer || ((element) => element || null);
    const extractMessageTextFallback = deps.extractMessageTextFallback || (() => '');
    const isInsideComposer = deps.isInsideComposer || (() => false);
    const setTimeoutImpl = deps.setTimeout || ((callback, ms) => setTimeout(callback, ms));
    const now = deps.now || (() => Date.now());
    const navigatorRef = deps.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const messageCandidateSelector = [
      '[data-message-author-role="user"]',
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn"]',
      '[data-testid="message-content"]',
      'article'
    ].join(',');
    const turnLikeSelector = ['[data-message-author-role]', '[data-testid^="conversation-turn"]', 'article'].join(',');

    function sleep(ms) {
      return new Promise((resolve) => setTimeoutImpl(resolve, ms));
    }

    async function tryReadClipboardText() {
      try {
        if (!navigatorRef?.clipboard?.readText) return '';
        return normalizeText(await navigatorRef.clipboard.readText());
      } catch {
        return '';
      }
    }

    async function tryWriteClipboardText(value) {
      try {
        if (!navigatorRef?.clipboard?.writeText) return false;
        await navigatorRef.clipboard.writeText(String(value || ''));
        return true;
      } catch {
        return false;
      }
    }

    async function waitForClipboardChange(previousClipboard) {
      const deadline = now() + config.clipboardCaptureTimeoutMs;
      let best = '';

      while (now() < deadline) {
        const current = await tryReadClipboardText();
        if (current && current !== previousClipboard) return current;
        if (current) best = current;
        await sleep(config.clipboardCapturePollMs);
      }

      return best && best === previousClipboard ? best : '';
    }

    async function extractMessageTextViaCopyButton(copyButton, container, senderHint = null) {
      const selectedText = selectionInside(container);
      if (selectedText) return selectedText;

      const before = await tryReadClipboardText();

      try {
        copyButton.click();
      } catch {
        return '';
      }

      const copied = await waitForClipboardChange(before);
      if (!copied) return '';

      if (before && copied !== before) {
        await tryWriteClipboardText(before);
      }

      const fallback = extractMessageTextFallback(container, senderHint);

      if (fallback) {
        const fallbackProbe = fallback.slice(0, 80).replace(/\s+/g, ' ').trim();
        const copiedProbe = copied.replace(/\s+/g, ' ');
        if (fallbackProbe && !copiedProbe.includes(fallbackProbe.slice(0, Math.min(35, fallbackProbe.length)))) {
          if (copied === before) return '';
        }
      }

      return copied;
    }

    async function extractMessageText(container, copyButton = null, senderHint = null) {
      if (copyButton) {
        const copied = await extractMessageTextViaCopyButton(copyButton, container, senderHint);
        if (copied) return copied;
      }

      return extractMessageTextFallback(container, senderHint);
    }

    function isVisibleElement(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function resolveVisibleMessageContainer(element) {
      const resolved = findMessageContainer(element) || element;
      const fallbackTarget = element.closest?.(turnLikeSelector) || element;

      if (resolved && resolved !== fallbackTarget) {
        const nestedTurns = Array.from(resolved.querySelectorAll?.(turnLikeSelector) || []).filter(
          (candidate) => candidate !== resolved
        );
        if (nestedTurns.length > 1) return fallbackTarget;
      }

      return resolved || fallbackTarget;
    }

    function visibleMessageContainers() {
      const seen = new Set();
      return Array.from(document.querySelectorAll(messageCandidateSelector))
        .map(resolveVisibleMessageContainer)
        .filter((element) => {
          if (!element || seen.has(element) || !isVisibleElement(element)) return false;
          seen.add(element);
          if (isInsideComposer(element)) return false;
          if (
            element.closest?.(
              `[${EXT_MARKER}], [${NEW_SESSION_MARKER}], [${LOAD_PAST_MARKER}], [${TOP_PIN_SELECT_MARKER}], [${AUTO_SEND_TOGGLE_MARKER}], [${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`
            )
          )
            return false;
          return normalizeText(element.innerText || element.textContent || '').length > 1;
        });
    }

    return {
      sleep,
      tryReadClipboardText,
      tryWriteClipboardText,
      waitForClipboardChange,
      extractMessageTextViaCopyButton,
      extractMessageText,
      extractMessageTextFallback,
      isVisibleElement,
      resolveVisibleMessageContainer,
      visibleMessageContainers
    };
  }

  return {
    DEFAULTS,
    createMessageSaveController
  };
});
