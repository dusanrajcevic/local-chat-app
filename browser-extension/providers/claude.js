(function exposeClaudeProvider(root, factory) {
  const adapter = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (root) {
    root.LocalChatProviderAdapters = root.LocalChatProviderAdapters || {};
    root.LocalChatProviderAdapters.claude = adapter;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createClaudeProviderAdapter() {
  'use strict';

  return {
    key: 'claude',
    name: 'Claude',
    hostIncludes: ['claude.ai'],
    turnContainerSelectors: ['article'],
    roleContainerSelectors: [],
    contentSelectors: [
      ':scope .prose',
      ':scope [data-testid="message-content"]',
      '.prose',
      '[data-testid="message-content"]'
    ],
    containerPreference: [
      { selectors: ['article'], position: 'first' },
      { kind: 'labeled', position: 'first' }
    ],
    userLabelPattern: /\b(user|human)\b/i,
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
