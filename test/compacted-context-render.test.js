const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let markdown;
let renderModule;

before(async () => {
  [markdown, renderModule] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'markdown.mjs')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'render.mjs')).href)
  ]);
});

function createView(session, el = {}) {
  const state = { currentSession: session };
  return renderModule.createRenderer({
    state,
    el,
    escapeHtml: markdown.escapeHtml,
    renderMarkdown: markdown.renderMarkdown,
    nextMessageSender: () => 'me'
  });
}

test('compacted context renders collapsed, escaped Markdown with source-message metadata', () => {
  const view = createView({
    id: 'chat_compacted',
    kind: 'compacted',
    compaction: {
      text: ['**Current plan**', '', '<img src=x onerror=alert(1)>'].join('\n'),
      sourceMessageCount: 12
    }
  });

  const html = view.renderCompactedContext();

  assert.match(html, /class="compacted-context"/);
  assert.match(html, /data-toggle-compacted-context/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="compactedContextContent"/);
  assert.match(html, /12 source messages/);
  assert.match(html, /<strong>Current plan<\/strong>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\s/i);
  assert.doesNotMatch(html, /message-actions|message-footer-actions/);
});

test('compacted context is only rendered for compacted child sessions with non-empty context', () => {
  const normal = createView({
    id: 'chat_parent',
    kind: 'normal',
    compaction: { text: 'Should stay hidden.', sourceMessageCount: 2 }
  });
  const empty = createView({
    id: 'chat_empty',
    kind: 'compacted',
    compaction: { text: '   ', sourceMessageCount: 1 }
  });

  assert.equal(normal.hasCompactedContext(), false);
  assert.equal(normal.renderCompactedContext(), '');
  assert.equal(empty.hasCompactedContext(), false);
  assert.equal(empty.renderCompactedContext(), '');
});

test('compacted context expansion state survives renderer refreshes for the same session', () => {
  const session = {
    id: 'chat_compacted_toggle',
    kind: 'compacted',
    compaction: { text: 'Durable compacted state.', sourceMessageCount: 3 }
  };
  const attributes = new Map([['aria-expanded', 'false']]);
  const toggle = {
    getAttribute(name) {
      return attributes.get(name) || null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    }
  };
  const content = { hidden: true };
  const el = {
    messages: {
      querySelector(selector) {
        if (selector === '[data-toggle-compacted-context]') return toggle;
        if (selector === '#compactedContextContent') return content;
        return null;
      }
    }
  };
  const view = createView(session, el);

  view.toggleCompactedContext();

  assert.equal(attributes.get('aria-expanded'), 'true');
  assert.equal(content.hidden, false);
  assert.match(view.renderCompactedContext(), /aria-expanded="true"/);
  assert.doesNotMatch(view.renderCompactedContext(), /\s+hidden\s*>/);

  view.toggleCompactedContext();
  assert.equal(attributes.get('aria-expanded'), 'false');
  assert.equal(content.hidden, true);
  assert.match(view.renderCompactedContext(), /aria-expanded="false"/);
  assert.match(view.renderCompactedContext(), /\s+hidden\s*>/);
});
