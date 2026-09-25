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
    turnContainerSelectors: [
      '[data-testid^="conversation-turn"]',
      '[data-conversation-screenshot-content]',
      '[data-content-search-unit-key$=":user"]',
      '[data-content-search-unit-key$=":assistant"]',
      '[data-chatgpt-search-unit-key$=":user"]',
      '[data-chatgpt-search-unit-key$=":assistant"]'
    ],
    actionBarSelectors: [
      '[aria-label="Response actions"][role="group"]',
      '[aria-label="Message actions"][role="group"]',
      '[data-testid*="turn-action" i]',
      '.turn-action-controls'
    ],
    actionBarCompletionSignal: true,
    actionBarAllowShortTurnText: true,
    actionBarCopySelectors: [
      '[data-testid="copy-turn-action-button"]',
      'button[aria-label="Copy response"]',
      'button[aria-label="Copy message"]',
      'button[aria-label="Copy"]'
    ],
    senderFromContainer(container) {
      if (!container) return null;

      const keys = [
        container.getAttribute?.('data-content-search-unit-key'),
        container.getAttribute?.('data-chatgpt-search-unit-key')
      ]
        .filter(Boolean)
        .join(' ');

      if (/:user(?:\s|$)/i.test(keys)) return 'me';
      if (/:assistant(?:\s|$)/i.test(keys)) return 'bot';
      if (container.matches?.('[data-user-message-bubble="true"]')) return 'me';
      if (container.querySelector?.('[data-user-message-bubble="true"]')) return 'me';

      const role =
        container.getAttribute?.('data-conversation-role') ||
        container.querySelector?.('[data-conversation-role]')?.getAttribute?.('data-conversation-role');
      if (role === 'assistant') return 'bot';
      if (role === 'user') return 'me';

      return null;
    },
    roleContainerSelectors: ['[data-message-author-role]'],
    contentSelectors: [
      ':scope [data-markdown-text-style="assistant-message"]',
      ':scope [data-user-message-bubble="true"]',
      ':scope .markdown',
      ':scope .prose',
      ':scope [data-testid="message-content"]',
      '[data-markdown-text-style="assistant-message"]',
      '[data-user-message-bubble="true"]',
      '.markdown',
      '.prose',
      '[data-testid="message-content"]'
    ],
    containerPreference: [
      {
        selectors: [
          '[data-content-search-unit-key$=":user"]',
          '[data-content-search-unit-key$=":assistant"]',
          '[data-chatgpt-search-unit-key$=":user"]',
          '[data-chatgpt-search-unit-key$=":assistant"]'
        ],
        position: 'last'
      },
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
      '.result-streaming',
      '.result-thinking'
    ]
  };
});
