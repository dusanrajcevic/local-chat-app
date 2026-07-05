(function exposeChatGptProvider(root, factory) {
  const adapter = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (root) {
    root.LocalChatProviderAdapters = root.LocalChatProviderAdapters || {};
    root.LocalChatProviderAdapters.chatgpt = adapter;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatGptProviderAdapter() {
  'use strict';

  return {
    key: 'chatgpt',
    name: 'ChatGPT',
    hostIncludes: ['chatgpt.com', 'chat.openai.com'],
    turnContainerSelectors: ['[data-testid^="conversation-turn"]'],
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
      { selectors: ['[data-testid^="conversation-turn"]'], position: 'last' },
      { selectors: ['[data-message-author-role]'], position: 'last' },
      { kind: 'single-role', position: 'last' },
      { kind: 'labeled', position: 'first' }
    ],
    userLabelPattern: /\b(user|human)\b/i,
    assistantLabelPattern: /\b(assistant|bot|ai|chatgpt)\b/i,
    streamingSelectors: [
      '[aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-streaming="true"]',
      '[class*="streaming" i]',
      '[class*="generating" i]'
    ]
  };
});
