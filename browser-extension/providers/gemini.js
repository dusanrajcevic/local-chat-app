(function exposeGeminiProvider(root, factory) {
  const adapter = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (root) {
    root.LocalChatProviderAdapters = root.LocalChatProviderAdapters || {};
    root.LocalChatProviderAdapters.gemini = adapter;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGeminiProviderAdapter() {
  'use strict';

  return {
    key: 'gemini',
    name: 'Gemini',
    hostIncludes: ['gemini.google.com'],
    turnContainerSelectors: ['article'],
    roleContainerSelectors: [],
    contentSelectors: [
      ':scope [data-testid="message-content"]',
      ':scope .markdown',
      ':scope .prose',
      '[data-testid="message-content"]',
      '.markdown',
      '.prose'
    ],
    containerPreference: [
      { selectors: ['article'], position: 'first' },
      { kind: 'labeled', position: 'first' }
    ],
    userLabelPattern: /\b(user|human|query)\b/i,
    assistantLabelPattern: /\b(assistant|bot|ai|response|answer)\b/i,
    streamingSelectors: [
      '[aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-streaming="true"]',
      '[class*="streaming" i]',
      '[class*="generating" i]'
    ]
  };
});
