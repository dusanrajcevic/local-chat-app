const test = require('node:test');
const assert = require('node:assert/strict');

const { createSidebarController } = require('../browser-extension/content-sidebar');

function createController(compactionState, callbacks = {}) {
  const controller = createSidebarController({
    providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
    escapeHtml(value) {
      return String(value ?? '').replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
      );
    },
    formatLocalDate: () => 'Aug 16',
    getCompactionState: () => compactionState,
    isCompactionRunning: () => Boolean(compactionState.running),
    cancelCompaction: callbacks.cancelCompaction || (() => false),
    clearCompactionStatus: callbacks.clearCompactionStatus || (() => false),
    startCompaction: callbacks.startCompaction || (() => Promise.resolve()),
    chromeApi: { runtime: { sendMessage: async () => ({ ok: true }) }, storage: { local: {} } }
  });

  controller.setStateForTest({
    data: {
      folders: [],
      activeSessionId: 'chat_compacted',
      sessions: [
        {
          id: 'chat_compacted',
          title: 'Architecture review (compacted)',
          kind: 'compacted',
          dateFolder: '2026-08-16',
          messageCount: 2,
          updatedAt: '2026-08-16T19:00:00Z'
        }
      ]
    }
  });
  return controller;
}

function render(controller) {
  const panel = { innerHTML: '' };
  controller.renderLocalSidebarPanel(panel);
  return panel.innerHTML;
}

test('compaction sidebar UX shows provider-wait progress and a cancel action', () => {
  const controller = createController({
    phase: 'waiting-response',
    running: true,
    cancellable: true,
    error: ''
  });
  const html = render(controller);

  assert.match(html, /Waiting for ChatGPT/);
  assert.match(html, /Keep this provider conversation open/);
  assert.match(html, /data-local-sidebar-cancel-compaction/);
  assert.match(html, /data-local-compaction-phase="waiting-response"/);
  assert.match(html, /data-local-sidebar-compact[^>]* disabled/);
  assert.match(html, />Waiting…<\/button>/);
  assert.match(html, /2 messages · Compacted/);
});

test('compaction sidebar UX exposes escaped errors and retry/dismiss controls', () => {
  const controller = createController({
    phase: 'error',
    running: false,
    cancellable: false,
    error: '<provider> returned invalid compaction JSON'
  });
  const html = render(controller);

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed/);
  assert.match(html, /&lt;provider&gt; returned invalid compaction JSON/);
  assert.doesNotMatch(html, /<provider>/);
  assert.match(html, />Retry compact<\/button>/);
  assert.match(html, /data-local-sidebar-dismiss-compaction/);
  assert.doesNotMatch(html, /data-local-sidebar-compact[^>]* disabled/);
});

test('compaction sidebar UX distinguishes non-cancellable persistence from provider waiting', () => {
  const controller = createController({ phase: 'persisting', running: true, cancellable: false, error: '' });
  const html = render(controller);

  assert.match(html, /Saving compacted context/);
  assert.match(html, />Saving…<\/button>/);
  assert.doesNotMatch(html, /data-local-sidebar-cancel-compaction/);
  assert.doesNotMatch(html, /data-local-sidebar-dismiss-compaction/);
});

test('content bootstrap wires workflow state, cancellation, and status refresh into the sidebar', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../browser-extension/content.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../browser-extension/content.css'), 'utf8');

  assert.match(source, /cancelCompaction: \(\) => compactionWorkflow\?\.cancelCompaction/);
  assert.match(source, /clearCompactionStatus: \(\) => compactionWorkflow\?\.clearStatus/);
  assert.match(source, /getCompactionState:/);
  assert.match(source, /onStateChange: \(\) => sidebarController\?\.refreshCompactionUi/);
  assert.match(css, /\.local-chat-compaction-status\.error/);
  assert.match(css, /@keyframes local-chat-compaction-spin/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
