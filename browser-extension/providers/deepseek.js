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
    turnContainerSelectors: ['.ds-message', 'section.chat-message', '.chat-message', '[class*="chat-message" i]'],
    roleContainerSelectors: ['[data-message-author-role]'],
    contentSelectors: [
      ':scope .ds-assistant-message-main-content',
      ':scope .ds-markdown',
      ':scope .markdown',
      ':scope .prose',
      ':scope [data-testid="message-content"]',
      '.ds-assistant-message-main-content',
      '.ds-markdown',
      '.markdown',
      '.prose',
      '[data-testid="message-content"]'
    ],
    actionBarSelectors: [
      '[data-virtual-list-item-key] > .ds-message + .ds-flex > .ds-flex',
      '[data-virtual-list-item-key] > .ds-message + div > div > .ds-flex'
    ],
    actionBarCopySelectors: [':scope > [role="button"]:first-child', ':scope > button:first-child'],
    actionBarCompletionSignal: true,
    actionBarAllowShortTurnText: true,
    containerPreference: [
      { selectors: ['[data-message-author-role]'], position: 'last' },
      { selectors: ['.ds-message'], position: 'last' },
      { kind: 'single-role', position: 'last' },
      { selectors: ['section.chat-message', '.chat-message', '[class*="chat-message" i]'], position: 'last' },
      { kind: 'labeled', position: 'first' }
    ],
    userLabelPattern: /\b(user|human|human-turn)\b/i,
    assistantLabelPattern: /\b(assistant|bot|ai|assistant-turn)\b/i,
    senderFromContainer(container) {
      const explicitRole = container
        ?.querySelector?.('[data-message-author-role]')
        ?.getAttribute('data-message-author-role');
      if (explicitRole === 'user') return 'me';
      if (explicitRole === 'assistant') return 'bot';

      if (!container?.matches?.('.ds-message')) return null;
      return container.querySelector?.('.ds-assistant-message-main-content, .ds-markdown') ? 'bot' : 'me';
    },
    streamingSelectors: [
      '[aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-streaming="true"]',
      '[class*="streaming" i]',
      '[class*="generating" i]'
    ]
  };
});
