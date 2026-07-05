(function exposeDeepSeekProvider(root, factory) {
  const adapter = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (root) {
    root.LocalChatProviderAdapters = root.LocalChatProviderAdapters || {};
    root.LocalChatProviderAdapters.deepseek = adapter;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDeepSeekProviderAdapter() {
  'use strict';

  return {
    key: 'deepseek',
    name: 'DeepSeek',
    hostIncludes: ['chat.deepseek.com'],
    turnContainerSelectors: ['section.chat-message', '.chat-message', '[class*="chat-message" i]'],
    roleContainerSelectors: ['[data-message-author-role]'],
    contentSelectors: [
      ':scope .markdown',
      ':scope .prose',
      ':scope [data-testid="message-content"]',
      '.markdown',
      '.prose',
      '[data-testid="message-content"]'
    ],
    containerPreference: [
      { selectors: ['[data-message-author-role]'], position: 'last' },
      { kind: 'single-role', position: 'last' },
      { selectors: ['section.chat-message', '.chat-message', '[class*="chat-message" i]'], position: 'last' },
      { kind: 'labeled', position: 'first' }
    ],
    userLabelPattern: /\b(user|human|human-turn)\b/i,
    assistantLabelPattern: /\b(assistant|bot|ai|assistant-turn)\b/i,
    streamingSelectors: [
      '[aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-streaming="true"]',
      '[class*="streaming" i]',
      '[class*="generating" i]'
    ]
  };
});
