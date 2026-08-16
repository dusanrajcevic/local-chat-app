(function exposeLocalChatContentProviders(root, factory) {
  const loadedAdapters =
    typeof require === 'function'
      ? [
          require('./providers/chatgpt'),
          require('./providers/claude'),
          require('./providers/deepseek'),
          require('./providers/gemini')
        ]
      : Object.values(root?.LocalChatProviderAdapters || {});

  const api = factory(loadedAdapters);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentProviders(loadedAdapters) {
  'use strict';

  const DEFAULT_CONTENT_SELECTORS = [
    ':scope .markdown',
    ':scope .prose',
    ':scope [data-testid="message-content"]',
    '.markdown',
    '.prose',
    '[data-testid="message-content"]'
  ];

  const DEFAULT_STREAMING_SELECTORS = [
    '[aria-busy="true"]',
    '[data-is-streaming="true"]',
    '[data-streaming="true"]',
    '[class*="streaming" i]',
    '[class*="generating" i]'
  ];

  const DEFAULT_CONTAINER_PREFERENCE = [
    { selectors: ['[data-testid^="conversation-turn"]'], position: 'last' },
    { selectors: ['[data-message-author-role]'], position: 'last' },
    { kind: 'single-role', position: 'last' },
    { selectors: ['article'], position: 'first' },
    { kind: 'labeled', position: 'first' }
  ];

  function normalizeAdapter(adapter) {
    return Object.freeze({
      hostIncludes: [],
      turnContainerSelectors: [],
      actionBarSelectors: [],
      actionBarCompletionSignal: false,
      roleContainerSelectors: ['[data-message-author-role]'],
      contentSelectors: DEFAULT_CONTENT_SELECTORS,
      containerPreference: DEFAULT_CONTAINER_PREFERENCE,
      userLabelPattern: /\b(user|human)\b/i,
      assistantLabelPattern: /\b(assistant|bot|ai)\b/i,
      streamingSelectors: DEFAULT_STREAMING_SELECTORS,
      ...adapter
    });
  }

  function fallbackAdapterForHostname(hostname) {
    return normalizeAdapter({
      key: String(hostname || 'provider').replace(/^www\./, '') || 'provider',
      name: 'AI Chat',
      hostIncludes: []
    });
  }

  const adapters = Object.freeze((loadedAdapters || []).filter(Boolean).map(normalizeAdapter));

  function hostnameFromLocation(locationLike) {
    return String(locationLike?.hostname || '').toLowerCase();
  }

  function adapterForHostname(hostname) {
    const normalizedHost = String(hostname || '').toLowerCase();
    return (
      adapters.find((adapter) =>
        adapter.hostIncludes.some((hostPart) => normalizedHost.includes(String(hostPart).toLowerCase()))
      ) || fallbackAdapterForHostname(normalizedHost)
    );
  }

  function adapterForLocation(locationLike) {
    return adapterForHostname(hostnameFromLocation(locationLike));
  }

  function providerInfoForLocation(locationLike) {
    const adapter = adapterForLocation(locationLike);
    return { name: adapter.name, key: adapter.key };
  }

  return {
    adapters,
    adapterForHostname,
    adapterForLocation,
    providerInfoForLocation,
    fallbackAdapterForHostname
  };
});
