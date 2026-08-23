const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('node:url');

let markdown;
let apiModule;
let stateModule;
let renderModule;
let exportModule;
let modalModule;
let clipboardModule;
let controllersModule;
let eventsModule;
let mainModule;
let accessibilityModule;
let messageNavigatorModule;

function publicModulePath(name) {
  return pathToFileURL(path.join(__dirname, '..', 'public', 'app', name)).href;
}

before(async () => {
  [
    markdown,
    apiModule,
    stateModule,
    renderModule,
    exportModule,
    modalModule,
    clipboardModule,
    controllersModule,
    eventsModule,
    mainModule,
    accessibilityModule,
    messageNavigatorModule
  ] = await Promise.all([
    import(publicModulePath('markdown.mjs')),
    import(publicModulePath('api.mjs')),
    import(publicModulePath('state.mjs')),
    import(publicModulePath('render.mjs')),
    import(publicModulePath('export.mjs')),
    import(publicModulePath('modals.mjs')),
    import(publicModulePath('clipboard.mjs')),
    import(publicModulePath('controllers.mjs')),
    import(publicModulePath('events.mjs')),
    import(publicModulePath('main.mjs')),
    import(pathToFileURL(path.join(__dirname, '..', 'e2e', 'accessibility-support.mjs')).href),
    import(publicModulePath('message-navigator.mjs'))
  ]);
});

function loadDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  return new JSDOM(html, { url: 'http://127.0.0.1:3000', pretendToBeVisual: true });
}

function createMemoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    dump() {
      return Object.fromEntries(values);
    }
  };
}

function createHarness({ routes = {} } = {}) {
  const dom = loadDom();
  const storage = createMemoryStorage();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const key = `${options.method || 'GET'} ${url}`;
    const response = routes[key];
    if (!response) throw new Error(`Unhandled route: ${key}`);
    const status = response.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof response.body === 'function' ? response.body({ url, options, calls }) : response.body)
    };
  };

  const state = stateModule.createInitialState({ storage });
  const el = stateModule.queryElements(dom.window.document);
  const api = apiModule.createApiClient({ fetchImpl });
  const messageNavigator = messageNavigatorModule.createMessageNavigator({
    messagesElement: el.messages,
    navigatorElement: el.messageNavigator,
    raf: (callback) => callback()
  });
  const view = renderModule.createRenderer({
    state,
    el,
    storage,
    escapeHtml: markdown.escapeHtml,
    renderMarkdown: markdown.renderMarkdown,
    formatDate: stateModule.formatDate,
    getBotName: stateModule.getBotName,
    nextMessageSender: stateModule.nextMessageSender,
    messageNavigator
  });
  const modal = modalModule.createModalController({
    state,
    el,
    doc: dom.window.document,
    raf: (callback) => callback()
  });
  const announceStatus = (message) => {
    el.appStatus.textContent = String(message || '');
  };
  const clipboard = clipboardModule.createClipboardController({
    state,
    el,
    doc: dom.window.document,
    win: dom.window,
    navigatorRef: {
      clipboard: {
        writeText: async (text) => {
          clipboard.lastText = text;
        }
      }
    },
    exportService: exportModule,
    getBotName: stateModule.getBotName,
    announceStatus
  });
  const controllers = controllersModule.createControllers({
    state,
    el,
    api,
    view,
    modal,
    stateUtils: stateModule,
    storage,
    win: dom.window,
    doc: dom.window.document,
    announceStatus,
    copyTextToClipboard: clipboard.copyTextToClipboard
  });

  return { dom, storage, calls, state, el, api, view, modal, clipboard, controllers, messageNavigator };
}

test('web UI loads a single native ES module entry point instead of ordered global scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\.\/app\/main\.mjs"><\/script>/);
  assert.doesNotMatch(html, /<script src="app-/);
  assert.doesNotMatch(html, /<script src="markdown\.js"/);
  assert.equal(typeof mainModule.createRuntime, 'function');
});

test('core controls expose accessible names and valid ARIA references', () => {
  const harness = createHarness();
  const issues = accessibilityModule.findAccessibilityIssues(harness.dom.window.document);

  assert.deepEqual(issues, []);
  assert.equal(harness.el.messageInput.labels[0].textContent.trim(), 'Message');
  assert.equal(harness.el.pinSelect.labels[0].textContent.trim(), 'Pin current session to folder');
  assert.equal(harness.el.editMessageTextarea.labels[0].textContent.trim(), 'Edit message text');
  assert.equal(harness.el.appStatus.getAttribute('role'), 'status');
  assert.equal(harness.el.appStatus.getAttribute('aria-live'), 'polite');
});

test('chat search modal renders recent chats and highlights message matches', async () => {
  const harness = createHarness({
    routes: {
      'GET /api/recent-chats?limit=12': {
        body: [
          {
            id: 'chat_recent',
            title: 'Recent architecture notes',
            updatedAt: '2026-08-10T12:00:00.000Z'
          }
        ]
      },
      'GET /api/search-chats?q=atomic&limit=50': {
        body: {
          query: 'atomic',
          count: 1,
          results: [
            {
              id: 'chat_search',
              title: 'Storage review',
              updatedAt: '2026-08-09T12:00:00.000Z',
              match: { preview: 'Use atomic writes and recovery journals.' }
            }
          ]
        }
      }
    }
  });

  harness.controllers.openChatSearch();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.el.chatSearchModal.classList.contains('hidden'), false);
  assert.equal(harness.el.chatSearchHeading.textContent, 'Recent chats');
  assert.equal(harness.el.chatSearchResults.querySelectorAll('[data-search-session-id]').length, 1);
  assert.match(harness.el.chatSearchResults.textContent, /Recent architecture notes/);

  harness.el.chatSearchInput.value = 'atomic';
  await harness.controllers.runSearch('atomic');

  assert.equal(harness.el.chatSearchHeading.textContent, 'Search results');
  assert.match(harness.el.chatSearchResults.textContent, /Storage review/);
  assert.match(harness.el.chatSearchResults.textContent, /Use atomic writes and recovery journals/);
  assert.equal(harness.el.chatSearchResults.querySelector('strong')?.textContent, 'atomic');
  assert.equal(harness.el.clearChatSearchBtn.hidden, true);

  harness.controllers.closeChatSearch();
  assert.equal(harness.el.chatSearchModal.classList.contains('hidden'), true);
});

test('message navigator renders one preview rail item per user message and jumps to its target', () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 'chat_nav',
    title: 'Navigator test',
    trashed: false,
    messages: [
      { id: 'm1', sender: 'me', text: 'One two three four five six seven eight nine ten' },
      { id: 'm2', sender: 'bot', text: 'Assistant response' },
      { id: 'm3', sender: 'me', text: 'Follow-up question' }
    ]
  };

  harness.view.renderMessages();

  const items = harness.el.messageNavigator.querySelectorAll('[data-message-nav-id]');
  assert.equal(harness.el.messageNavigator.hidden, false);
  assert.equal(items.length, 2);
  assert.equal(
    items[0].querySelector('.message-nav-preview').textContent,
    'One two three four five six seven eight...'
  );
  assert.equal(items[1].querySelector('.message-nav-preview').textContent, 'Follow-up question');
  assert.equal(harness.el.messageNavigator.querySelectorAll('.message-nav-line').length, 2);
  assert.match(items[0].getAttribute('aria-label'), /your message 1/i);

  const target = harness.el.messages.querySelector('[data-chat-message-id="m1"]');
  let scrollOptions = null;
  target.scrollIntoView = (options) => {
    scrollOptions = options;
  };
  items[0].click();

  assert.deepEqual(scrollOptions, { behavior: 'smooth', block: 'start' });
  assert.equal(items[0].getAttribute('aria-current'), 'location');
  assert.equal(items[0].tabIndex, 0);
});

test('compacted sessions render expandable context without turning it into a message', async () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 'chat_compacted',
    kind: 'compacted',
    parentSessionId: 'chat_parent',
    title: 'Architecture review (compacted)',
    aiName: 'Assistant',
    trashed: false,
    compaction: {
      text: ['**Current plan**', '', '```bash', 'npm run verify', '```', '', '<img src=x onerror=alert(1)>'].join('\n'),
      sourceMessageCount: 12
    },
    messages: [
      { id: 'm1', sender: 'me', text: 'Continue with the next patch.' },
      { id: 'm2', sender: 'bot', text: 'Ready to continue.' }
    ]
  };

  harness.view.renderMessages();

  const context = harness.el.messages.querySelector('.compacted-context');
  const toggle = context.querySelector('[data-toggle-compacted-context]');
  const content = context.querySelector('#compactedContextContent');

  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(content.hidden, true);
  assert.match(context.textContent, /Compacted context/);
  assert.match(context.textContent, /12 source messages/);
  assert.equal(context.querySelectorAll('.message-actions, .message-footer-actions').length, 0);
  assert.equal(context.querySelector('img'), null);
  assert.equal(harness.el.messages.querySelectorAll('[data-chat-message-id]').length, 2);
  assert.equal(harness.el.messageNavigator.querySelectorAll('[data-message-nav-id]').length, 1);

  harness.view.toggleCompactedContext();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(content.hidden, false);
  assert.equal(content.querySelector('strong').textContent, 'Current plan');

  const codeCopyButton = content.querySelector('[data-copy-code]');
  await harness.clipboard.copyCodeBlock(codeCopyButton);
  assert.equal(harness.clipboard.lastText, 'npm run verify');

  harness.view.renderMessages();
  assert.equal(
    harness.el.messages.querySelector('[data-toggle-compacted-context]').getAttribute('aria-expanded'),
    'true'
  );
  assert.equal(harness.el.messages.querySelector('#compactedContextContent').hidden, false);
});

test('compacted context renders before an empty continuation tail and stays off normal parents', () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 'chat_compacted_empty',
    kind: 'compacted',
    title: 'Fresh compacted chat',
    aiName: 'Assistant',
    trashed: false,
    compaction: { text: 'Preserved compacted state.', sourceMessageCount: 1 },
    messages: []
  };

  harness.view.renderMessages();
  assert.equal(harness.el.messages.firstElementChild.classList.contains('compacted-context'), true);
  assert.match(harness.el.messages.textContent, /No messages after compaction yet/);
  assert.match(harness.el.messages.textContent, /Continue the conversation below/);

  harness.state.currentSession = {
    id: 'chat_parent',
    kind: 'normal',
    title: 'Parent archive',
    aiName: 'Assistant',
    trashed: false,
    compaction: { text: 'Should not render on a normal parent.', sourceMessageCount: 2 },
    messages: []
  };

  harness.view.renderMessages();
  assert.equal(harness.el.messages.querySelector('.compacted-context'), null);
  assert.match(harness.el.messages.textContent, /No messages yet/);
});

test('rendered messages expose hover quick actions with icon tooltips', async () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 's-actions',
    title: 'Message actions',
    aiName: 'Assistant',
    trashed: false,
    messages: [{ id: 'm-actions', sender: 'bot', text: 'Hello from the assistant.' }]
  };

  harness.view.renderMessages();

  const message = harness.el.messages.querySelector('[data-chat-message-id="m-actions"]');
  const topActions = message.querySelector('.message-top .message-actions');
  const footerActions = message.querySelector('.message-footer-actions');
  const buttons = footerActions.querySelectorAll('.message-action-icon');

  assert.match(topActions.textContent, /Copy Markdown/);
  assert.match(topActions.textContent, /Edit/);
  assert.match(topActions.textContent, /Delete/);
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    Array.from(buttons, (button) => button.dataset.tooltip),
    ['Copy markdown', 'Edit', 'Delete']
  );
  assert.deepEqual(
    Array.from(buttons, (button) => button.getAttribute('aria-label')),
    ['Copy markdown', 'Edit', 'Delete']
  );
  assert.equal(footerActions.textContent.trim(), '');

  await harness.clipboard.copyMessageMarkdown('m-actions', buttons[0]);

  assert.equal(harness.clipboard.lastText, 'Hello from the assistant.');
  assert.equal(buttons[0].dataset.copied, 'true');
  assert.equal(buttons[0].querySelector('.message-action-copy-svg') !== null, true);
  assert.equal(buttons[0].querySelector('.message-action-check-svg') !== null, true);
  assert.equal(harness.el.appStatus.textContent, 'Message copied to clipboard.');
});

test('rendered code blocks expose language labels and copy only code text', async () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 's-code',
    title: 'Code test',
    aiName: 'Assistant',
    trashed: false,
    messages: [
      {
        id: 'm-code',
        sender: 'bot',
        text: '```cpp\nstd::cout << "hello";\n```',
        createdAt: '2026-08-11T04:00:00Z'
      }
    ]
  };

  harness.view.renderMessages();

  const block = harness.el.messages.querySelector('.code-block');
  const button = block.querySelector('[data-copy-code]');
  assert.equal(block.querySelector('.code-language').textContent, 'c++');
  assert.equal(button.getAttribute('aria-label'), 'Copy code');

  await harness.clipboard.copyCodeBlock(button);

  assert.equal(harness.clipboard.lastText, 'std::cout << "hello";');
  assert.equal(harness.el.appStatus.textContent, 'Code copied to clipboard.');
  assert.equal(button.dataset.copied, 'true');
  assert.equal(button.getAttribute('aria-label'), 'Code copied');
});

test('app API client sends JSON by default, merges headers, and surfaces server errors', async () => {
  const calls = [];
  const api = apiModule.createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: false, json: async () => ({ error: 'Bad input' }) };
    }
  });

  await assert.rejects(
    () => api('/api/test', { method: 'POST', headers: { 'X-Test': 'yes' }, body: '{}' }),
    /Bad input/
  );

  assert.equal(calls[0].url, '/api/test');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['X-Test'], 'yes');
});

test('next message sender alternates from the last actual sender', () => {
  assert.equal(stateModule.nextMessageSender({ messages: [] }), 'me');
  assert.equal(stateModule.nextMessageSender({ messages: [{ sender: 'me' }, { sender: 'me' }] }), 'bot');
  assert.equal(stateModule.nextMessageSender({ messages: [{ sender: 'bot' }, { sender: 'bot' }] }), 'me');
});

test('renderer filters folder views and escapes rendered titles', () => {
  const harness = createHarness();
  harness.state.folders = [{ id: 'f1', name: '<Work>' }];
  harness.state.sessions = [
    {
      id: 's1',
      title: '<Pinned>',
      pinnedFolderId: 'f1',
      dateFolder: '2026-07-09',
      messageCount: 2,
      updatedAt: '2026-07-09T10:00:00Z'
    },
    {
      id: 's2',
      title: 'Unfiled',
      pinnedFolderId: null,
      dateFolder: '2026-07-09',
      messageCount: 0,
      updatedAt: '2026-07-09T11:00:00Z'
    }
  ];

  harness.view.renderFolders();

  const folderButton = harness.el.folderList.querySelector('[data-folder="f1"]');
  const folderActions = harness.el.folderList.querySelector('.item-actions');
  const renameFolderButton = harness.el.folderList.querySelector('[data-rename-folder="f1"]');
  const deleteFolderButton = harness.el.folderList.querySelector('[data-delete-folder="f1"]');

  assert.equal(folderButton?.querySelector('.item-title')?.textContent, '<Work>');
  assert.equal(harness.el.folderList.querySelector('work'), null);
  assert.equal(folderActions?.getAttribute('aria-label'), 'Actions for <Work>');
  assert.equal(renameFolderButton?.getAttribute('aria-label'), 'Rename <Work> folder');
  assert.equal(deleteFolderButton?.getAttribute('aria-label'), 'Delete <Work> folder');

  harness.state.selectedFolderId = 'f1';
  harness.view.renderSessions();
  assert.match(harness.el.sessionList.textContent, /<Pinned>/);
  assert.doesNotMatch(harness.el.sessionList.textContent, /Unfiled/);

  harness.state.selectedFolderId = 'unfiled';
  harness.view.renderSessions();
  assert.match(harness.el.sessionList.textContent, /Unfiled/);
  assert.doesNotMatch(harness.el.sessionList.textContent, /<Pinned>/);
});

test('renderer exposes selected folder, session, and trash state to assistive technology', () => {
  const harness = createHarness();
  harness.state.folders = [{ id: 'f1', name: 'Work' }];
  harness.state.selectedFolderId = 'f1';
  harness.state.sessions = [
    {
      id: 's1',
      title: 'Selected session',
      pinnedFolderId: 'f1',
      dateFolder: '2026-07-09',
      messageCount: 0,
      updatedAt: '2026-07-09T10:00:00Z'
    }
  ];
  harness.state.currentSession = { id: 's1', trashed: false, messages: [] };
  harness.state.trashOpen = true;

  harness.view.renderFolders();
  harness.view.renderSessions();
  harness.view.renderTrash();

  assert.equal(harness.el.folderList.querySelector('[data-folder="f1"]').getAttribute('aria-current'), 'true');
  assert.equal(harness.el.sessionList.querySelector('[data-open-session="s1"]').getAttribute('aria-current'), 'true');
  assert.equal(harness.el.toggleTrashBtn.getAttribute('aria-expanded'), 'true');
});

test('renderer escapes assistant names in message labels', () => {
  const harness = createHarness();
  const unsafeName = '<img src=x onerror=alert(1)>';
  harness.state.currentSession = {
    id: 's1',
    title: 'Demo',
    aiName: unsafeName,
    trashed: false,
    messages: [
      {
        id: 'm1',
        sender: 'bot',
        text: 'Safe message',
        createdAt: '2026-07-09T09:00:00Z'
      }
    ]
  };

  harness.view.renderMessages();

  const messageLabel = harness.el.messages.querySelector('.message-label');
  assert.ok(messageLabel);
  assert.equal(messageLabel.textContent, unsafeName);
  assert.equal(messageLabel.querySelector('img'), null);
  assert.doesNotMatch(harness.el.messages.innerHTML, /<img\b/i);
});

test('renderer handles cleared session sender state without an override', () => {
  const harness = createHarness();

  harness.state.currentSession = null;
  harness.state.nextSenderOverride = null;

  assert.doesNotThrow(() => harness.view.renderMessages());
  assert.equal(harness.el.isMeCheckbox.checked, true);
  assert.equal(harness.el.isMeCheckbox.disabled, true);
});

test('controllers refresh, open, mark active, and render markdown messages', async () => {
  const session = {
    id: 's1',
    title: 'Demo',
    aiName: 'Assistant',
    pinnedFolderId: 'f1',
    trashed: false,
    createdAt: '2026-07-09T09:00:00Z',
    updatedAt: '2026-07-09T10:00:00Z',
    messages: [
      { id: 'm1', sender: 'me', text: 'Hello **there**', createdAt: '2026-07-09T09:00:00Z' },
      { id: 'm2', sender: 'bot', text: '<safe>', createdAt: '2026-07-09T09:01:00Z' }
    ]
  };
  const harness = createHarness({
    routes: {
      'GET /api/folders': { body: [{ id: 'f1', name: 'Work' }] },
      'GET /api/sessions': {
        body: [
          {
            id: 's1',
            title: 'Demo',
            pinnedFolderId: 'f1',
            dateFolder: '2026-07-09',
            messageCount: 2,
            updatedAt: session.updatedAt
          }
        ]
      },
      'GET /api/trash': { body: [] },
      'GET /api/sessions/s1': { body: session },
      'PUT /api/active-session': { body: { sessionId: 's1' } }
    }
  });

  await harness.controllers.refreshAll();
  await harness.controllers.openSession('s1');

  assert.equal(harness.state.currentSession.id, 's1');
  assert.equal(harness.storage.getItem('currentSessionId'), 's1');
  assert.match(harness.el.chatEyebrow.textContent, /AI: Assistant/);
  assert.match(harness.el.messages.innerHTML, /<strong>there<\/strong>/);
  assert.match(harness.el.messages.innerHTML, /&lt;safe&gt;/);
  assert.ok(harness.calls.some((call) => call.url === '/api/active-session' && call.options.method === 'PUT'));
});

test('message controller sends alternating sender messages and refreshes current session', async () => {
  const sessionBefore = {
    id: 's1',
    title: 'Demo',
    aiName: '',
    pinnedFolderId: null,
    trashed: false,
    createdAt: '2026-07-09T09:00:00Z',
    updatedAt: '2026-07-09T09:00:00Z',
    messages: []
  };
  const sessionAfter = {
    ...sessionBefore,
    updatedAt: '2026-07-09T09:01:00Z',
    messages: [{ id: 'm1', sender: 'me', text: 'Hi', createdAt: '2026-07-09T09:01:00Z' }]
  };
  let postedBody = null;
  const harness = createHarness({
    routes: {
      'POST /api/sessions/s1/messages': {
        body: ({ options }) => {
          postedBody = JSON.parse(options.body);
          return { id: 'm1' };
        }
      },
      'GET /api/sessions/s1': { body: () => sessionAfter },
      'PUT /api/active-session': { body: { sessionId: 's1' } },
      'GET /api/folders': { body: [] },
      'GET /api/sessions': { body: [] },
      'GET /api/trash': { body: [] }
    }
  });
  harness.state.currentSession = sessionBefore;
  harness.el.messageInput.value = 'Hi';

  await harness.controllers.sendMessage();

  assert.deepEqual(postedBody, { text: 'Hi', sender: 'me' });
  assert.equal(harness.el.messageInput.value, '');
  assert.equal(harness.state.currentSession.messages.length, 1);
  assert.equal(harness.el.isMeCheckbox.checked, false);
  assert.equal(harness.el.appStatus.textContent, 'Message sent.');
});

test('message controller honors a manual sender selection before continuing alternation', async () => {
  const sessionBefore = {
    id: 's1',
    title: 'Demo',
    aiName: '',
    pinnedFolderId: null,
    trashed: false,
    createdAt: '2026-07-09T09:00:00Z',
    updatedAt: '2026-07-09T09:00:00Z',
    messages: [{ id: 'm1', sender: 'me', text: 'First', createdAt: '2026-07-09T09:00:00Z' }]
  };
  const sessionAfter = {
    ...sessionBefore,
    updatedAt: '2026-07-09T09:01:00Z',
    messages: [
      ...sessionBefore.messages,
      { id: 'm2', sender: 'me', text: 'Manual override', createdAt: '2026-07-09T09:01:00Z' }
    ]
  };
  let postedBody = null;
  const harness = createHarness({
    routes: {
      'POST /api/sessions/s1/messages': {
        body: ({ options }) => {
          postedBody = JSON.parse(options.body);
          return { id: 'm2' };
        }
      },
      'GET /api/sessions/s1': { body: () => sessionAfter },
      'PUT /api/active-session': { body: { sessionId: 's1' } },
      'GET /api/folders': { body: [] },
      'GET /api/sessions': { body: [] },
      'GET /api/trash': { body: [] }
    }
  });
  harness.state.currentSession = sessionBefore;
  harness.view.renderMessages();
  assert.equal(harness.el.isMeCheckbox.checked, false);

  harness.el.isMeCheckbox.checked = true;
  harness.el.messageInput.value = 'Manual override';
  await harness.controllers.sendMessage();

  assert.deepEqual(postedBody, { text: 'Manual override', sender: 'me' });
  assert.equal(harness.state.currentSession.messages.at(-1).sender, 'me');
  assert.equal(harness.el.isMeCheckbox.checked, false);
});

test('clipboard falls back when Clipboard API write permission is denied', async () => {
  const harness = createHarness();
  const copiedValues = [];
  harness.dom.window.document.execCommand = (command) => {
    assert.equal(command, 'copy');
    copiedValues.push(harness.dom.window.document.querySelector('textarea[readonly]')?.value);
    return true;
  };

  const deniedClipboard = clipboardModule.createClipboardController({
    state: harness.state,
    el: harness.el,
    doc: harness.dom.window.document,
    win: harness.dom.window,
    navigatorRef: {
      clipboard: {
        writeText: async () => {
          throw new harness.dom.window.DOMException('Write permission denied.', 'NotAllowedError');
        }
      }
    },
    exportService: exportModule,
    getBotName: stateModule.getBotName
  });

  await deniedClipboard.copyTextToClipboard('ABCDEF123456');
  assert.deepEqual(copiedValues, ['ABCDEF123456']);
});

test('extension pairing code controller renders a short-lived code in the local app', async () => {
  const harness = createHarness({
    routes: {
      'POST /api/extension/pairing-code': {
        body: { code: 'ABCDEF123456', expiresAt: '2026-08-11T03:00:00.000Z' }
      }
    }
  });

  const result = await harness.controllers.createExtensionPairingCode();
  assert.equal(result.code, 'ABCDEF123456');
  assert.equal(harness.el.extensionPairingCode.textContent, 'ABCDEF123456');
  assert.equal(harness.el.extensionPairingModal.getAttribute('aria-hidden'), 'false');
  assert.equal(harness.dom.window.document.body.classList.contains('modal-open'), true);

  assert.equal(await harness.controllers.copyExtensionPairingCode(), true);
  assert.equal(harness.clipboard.lastText, 'ABCDEF123456');
  assert.equal(harness.el.appStatus.textContent, 'Pairing code copied to clipboard.');

  harness.controllers.closeExtensionPairing();
  assert.equal(harness.el.extensionPairingModal.getAttribute('aria-hidden'), 'true');
  assert.equal(harness.dom.window.document.body.classList.contains('modal-open'), false);
});

test('text prompt modal resolves values and toggles the global modal class', async () => {
  const harness = createHarness();
  const pending = harness.modal.openTextPrompt({ title: 'Rename', label: 'Name', defaultValue: 'Old' });

  assert.equal(harness.el.appPromptModal.getAttribute('aria-hidden'), 'false');
  assert.equal(harness.dom.window.document.body.classList.contains('modal-open'), true);
  assert.equal(harness.el.appPromptInput.value, 'Old');

  harness.el.appPromptInput.value = 'New';
  harness.modal.submitTextPrompt();

  assert.equal(await pending, 'New');
  assert.equal(harness.el.appPromptModal.getAttribute('aria-hidden'), 'true');
  assert.equal(harness.dom.window.document.body.classList.contains('modal-open'), false);
});

test('modals trap keyboard focus and restore it to the opening control', async () => {
  const harness = createHarness();
  harness.el.newFolderBtn.focus();
  const pending = harness.modal.openTextPrompt({ title: 'Create folder', label: 'Folder name' });

  assert.equal(harness.dom.window.document.activeElement, harness.el.appPromptInput);
  assert.equal(harness.el.appShell.hasAttribute('inert'), true);

  const backwardTab = new harness.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
  assert.equal(harness.modal.trapFocus(backwardTab), true);
  assert.equal(backwardTab.defaultPrevented, true);
  assert.equal(harness.dom.window.document.activeElement, harness.el.saveAppPromptBtn);

  const forwardTab = new harness.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
  assert.equal(harness.modal.trapFocus(forwardTab), true);
  assert.equal(forwardTab.defaultPrevented, true);
  assert.equal(harness.dom.window.document.activeElement, harness.el.appPromptInput);

  harness.modal.closeTextPrompt(null);
  assert.equal(await pending, null);
  assert.equal(harness.el.appShell.hasAttribute('inert'), false);
  assert.equal(harness.dom.window.document.activeElement, harness.el.newFolderBtn);
});

test('clipboard actions announce completion through the live status region', async () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 's1',
    title: 'Demo',
    aiName: 'Assistant',
    trashed: false,
    createdAt: '2026-07-09T09:00:00Z',
    updatedAt: '2026-07-09T09:00:00Z',
    messages: [{ id: 'm1', sender: 'me', text: 'Hello', createdAt: '2026-07-09T09:00:00Z' }]
  };

  await harness.clipboard.copyEntireChat();
  assert.equal(harness.el.appStatus.textContent, 'Chat copied to clipboard.');
});

test('copying part of a rendered message preserves only the selected text', () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 's1',
    title: 'Demo',
    aiName: 'Assistant',
    trashed: false,
    messages: [
      {
        id: 'm1',
        sender: 'bot',
        text: 'Copy only this selected phrase, not the entire message.',
        createdAt: '2026-07-09T09:00:00Z'
      }
    ]
  };
  harness.view.renderMessages();

  const messageText = harness.el.messages.querySelector('[data-message-id="m1"]');
  const textNode = messageText.querySelector('p').firstChild;
  const start = textNode.nodeValue.indexOf('this selected phrase');
  const range = harness.dom.window.document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + 'this selected phrase'.length);

  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let prevented = false;
  let copiedText = null;
  harness.clipboard.handleCopyEvent({
    preventDefault() {
      prevented = true;
    },
    clipboardData: {
      setData(type, value) {
        assert.equal(type, 'text/plain');
        copiedText = value;
      }
    }
  });

  assert.equal(prevented, true);
  assert.equal(copiedText, 'this selected phrase');
});

test('copy handler leaves selections outside message text to native browser behavior', () => {
  const harness = createHarness();
  harness.state.currentSession = {
    id: 's1',
    title: 'Demo',
    aiName: 'Assistant',
    trashed: false,
    messages: [{ id: 'm1', sender: 'bot', text: 'Message', createdAt: '2026-07-09T09:00:00Z' }]
  };
  harness.view.renderMessages();

  const range = harness.dom.window.document.createRange();
  range.selectNodeContents(harness.el.chatTitle);
  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let prevented = false;
  harness.clipboard.handleCopyEvent({
    preventDefault() {
      prevented = true;
    },
    clipboardData: {
      setData() {
        throw new Error('clipboard should not be overridden');
      }
    }
  });

  assert.equal(prevented, false);
});

test('event wiring delegates sidebar folder clicks and copy buttons to controllers', async () => {
  const harness = createHarness();
  let selectedFolder = null;
  let copiedMessage = null;
  let copiedCode = false;
  let compactedContextToggles = 0;
  eventsModule.wireEvents({
    state: harness.state,
    el: harness.el,
    view: {
      ...harness.view,
      applySidebarState() {},
      toggleSidebar() {},
      syncSenderCheckbox() {},
      toggleCompactedContext() {
        compactedContextToggles += 1;
      }
    },
    modal: harness.modal,
    controllers: {
      ...harness.controllers,
      selectFolder(folderId) {
        selectedFolder = folderId;
      },
      openSession() {},
      renameSession: async () => {},
      renameFolder: async () => {},
      deleteMessage: async () => {},
      trashSession: async () => {},
      restoreSession: async () => {},
      deleteTrashSession: async () => {},
      deleteFolder: async () => {},
      openMessageForEdit() {},
      pinCurrentSession: async () => {},
      createSession: async () => {},
      createFolder: async () => {},
      sendMessage: async () => {},
      saveEditedMessage: async () => {}
    },
    clipboard: {
      ...harness.clipboard,
      copyMessageMarkdown: async (messageId) => {
        copiedMessage = messageId;
      },
      copyCodeBlock: async () => {
        copiedCode = true;
      },
      copyEntireChat: async () => {},
      handleCopyEvent() {}
    },
    doc: harness.dom.window.document
  });

  harness.el.folderList.innerHTML = '<button data-folder="unfiled">Unfiled</button>';
  harness.el.folderList.querySelector('[data-folder]').click();
  assert.equal(selectedFolder, 'unfiled');

  harness.el.messages.innerHTML = '<button data-copy-message="m1">Copy</button>';
  harness.el.messages.querySelector('[data-copy-message]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copiedMessage, 'm1');

  harness.el.messages.innerHTML = '<button data-copy-code>Copy code</button>';
  harness.el.messages.querySelector('[data-copy-code]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copiedCode, true);

  harness.el.messages.innerHTML = '<button data-toggle-compacted-context>Compacted context</button>';
  harness.el.messages.querySelector('[data-toggle-compacted-context]').click();
  assert.equal(compactedContextToggles, 1);

  harness.state.currentSession = {
    id: 's1',
    title: 'Demo',
    aiName: '',
    pinnedFolderId: null,
    trashed: false,
    messages: [{ id: 'm1', sender: 'me', text: 'First', createdAt: '2026-07-09T09:00:00Z' }]
  };
  harness.view.renderMessages();
  assert.equal(harness.el.isMeCheckbox.checked, false);

  harness.el.isMeCheckbox.checked = true;
  harness.el.isMeCheckbox.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
  harness.view.renderMessages();

  assert.deepEqual(harness.state.nextSenderOverride, { sessionId: 's1', sender: 'me' });
  assert.equal(harness.el.isMeCheckbox.checked, true);
});
