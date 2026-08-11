(function exposeLocalChatContentDiagnostics(root, factory) {
  const contentProviders =
    typeof require === 'function' ? require('./content-providers') : root?.LocalChatContentProviders;
  const contentDom = typeof require === 'function' ? require('./content-dom') : root?.LocalChatContentDom;

  const api = factory(contentProviders, contentDom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentDiagnostics = api;
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  function createLocalChatContentDiagnostics(contentProviders, contentDom) {
    'use strict';

    const DIAGNOSTICS_MESSAGE_TYPE = 'GET_PROVIDER_DIAGNOSTICS';

    function safeQueryAll(root, selector) {
      try {
        return Array.from(root?.querySelectorAll?.(selector) || []);
      } catch {
        return [];
      }
    }

    function selectorCounts(root, selectors = []) {
      return selectors.map((selector) => ({ selector, count: safeQueryAll(root, selector).length }));
    }

    function uniqueElements(elements) {
      return [...new Set(elements.filter(Boolean))];
    }

    function isSupportedAdapter(adapter) {
      return Boolean(contentProviders?.adapters?.some((candidate) => candidate.key === adapter?.key));
    }

    function diagnosticStatus({ supported, messageContainers, extractableMessages, userMessages, assistantMessages }) {
      if (!supported) return 'unsupported';
      if (!messageContainers) return 'fail';
      if (extractableMessages < messageContainers || !userMessages || !assistantMessages) return 'warning';
      return 'pass';
    }

    function collectProviderDiagnostics(options = {}) {
      if (!contentProviders || !contentDom) throw new Error('Provider diagnostics dependencies are unavailable.');

      const documentLike = options.document || (typeof document !== 'undefined' ? document : null);
      const locationLike = options.location || (typeof location !== 'undefined' ? location : null);
      if (!documentLike || !locationLike) throw new Error('Provider diagnostics require a document and location.');

      const adapter = contentProviders.adapterForLocation(locationLike);
      const supported = isSupportedAdapter(adapter);
      const allButtons = safeQueryAll(documentLike, 'button, [role="button"]');
      const copyButtons = allButtons.filter((button) => contentDom.isCopyButton(button));
      const messageContainers = uniqueElements(copyButtons.map((button) => contentDom.findMessageContainer(button)));

      let userMessages = 0;
      let assistantMessages = 0;
      let extractableMessages = 0;
      const messages = [];

      for (const container of messageContainers) {
        const sender = contentDom.inferSender(container);
        if (sender === 'me') userMessages += 1;
        if (sender === 'bot') assistantMessages += 1;

        const text = contentDom.extractMessageTextFallback(container, sender);
        const normalizedText = contentDom.normalizeText(text);
        if (normalizedText) extractableMessages += 1;
        messages.push({ sender, textLength: normalizedText.length });
      }

      const streamingCounts = selectorCounts(documentLike, adapter.streamingSelectors);
      const streamingMarkers = streamingCounts.reduce((total, entry) => total + entry.count, 0);
      const turnSelectors = selectorCounts(documentLike, adapter.turnContainerSelectors);
      const roleSelectors = selectorCounts(documentLike, adapter.roleContainerSelectors);
      const contentSelectors = selectorCounts(documentLike, adapter.contentSelectors);
      const warnings = [];

      if (!supported) warnings.push('This page does not match a supported provider adapter.');
      if (supported && !turnSelectors.some((entry) => entry.count > 0)) {
        warnings.push('No configured turn-container selector matched the current page.');
      }
      if (supported && !copyButtons.length) warnings.push('No message-level copy controls were detected.');
      if (messageContainers.length && !userMessages) warnings.push('No user message sender was inferred.');
      if (messageContainers.length && !assistantMessages) warnings.push('No assistant message sender was inferred.');
      if (messageContainers.length && extractableMessages < messageContainers.length) {
        warnings.push('At least one detected message container did not produce extractable text.');
      }
      if (streamingMarkers) warnings.push('Streaming/generating markers are currently present on the page.');

      const summary = {
        messageLevelCopyControls: copyButtons.length,
        messageContainers: messageContainers.length,
        extractableMessages,
        userMessages,
        assistantMessages,
        streamingMarkers
      };

      return {
        version: 1,
        provider: { key: adapter.key, name: adapter.name, supported },
        hostname: String(locationLike.hostname || '').toLowerCase(),
        status: diagnosticStatus({ supported, ...summary }),
        summary,
        messages,
        selectors: {
          turns: turnSelectors,
          roles: roleSelectors,
          content: contentSelectors,
          streaming: streamingCounts
        },
        warnings
      };
    }

    function handleDiagnosticsMessage(message, _sender, sendResponse, options = {}) {
      if (message?.type !== DIAGNOSTICS_MESSAGE_TYPE) return false;

      try {
        sendResponse({ ok: true, diagnostics: collectProviderDiagnostics(options) });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Provider diagnostics failed.' });
      }
      return false;
    }

    function registerDiagnosticsListener(chromeApi = typeof chrome !== 'undefined' ? chrome : null) {
      if (!chromeApi?.runtime?.onMessage?.addListener) return false;
      chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) =>
        handleDiagnosticsMessage(message, sender, sendResponse)
      );
      return true;
    }

    return {
      DIAGNOSTICS_MESSAGE_TYPE,
      selectorCounts,
      diagnosticStatus,
      collectProviderDiagnostics,
      handleDiagnosticsMessage,
      registerDiagnosticsListener
    };
  }
);

if (typeof module === 'undefined' && globalThis.LocalChatContentDiagnostics) {
  globalThis.LocalChatContentDiagnostics.registerDiagnosticsListener();
}
