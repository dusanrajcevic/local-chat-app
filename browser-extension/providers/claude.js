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
    turnContainerSelectors: ['[role="article"]', 'article'],
    actionBarSelectors: [
      '[data-cds="MessageActions"]',
      '[role="toolbar"][aria-label="Message actions" i]'
    ],
    actionBarCompletionSignal: true,
    actionBarCopySelectors: ['button[aria-label="Copy" i]', '[role="button"][aria-label="Copy" i]'],
    roleContainerSelectors: [],
    senderFromContainer(container) {
      const row = container?.closest?.('[data-testid="transcript-row"][data-perf-row]');
      const role = String(row?.getAttribute?.('data-perf-row') || '').toLowerCase();
      if (role === 'human' || role === 'user') return 'me';
      if (role === 'assistant') return 'bot';
      return null;
    },
    contentSelectors: [
      ':scope [data-testid="user-message"]',
      ':scope .standard-markdown',
      ':scope .font-claude-response',
      ':scope .prose',
      ':scope [data-testid="message-content"]',
      '[data-testid="user-message"]',
      '.standard-markdown',
      '.font-claude-response',
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
