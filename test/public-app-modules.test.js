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
    mainModule
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
    import(publicModulePath('main.mjs'))
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
  const view = renderModule.createRenderer({
    state,
    el,
    storage,
    escapeHtml: markdown.escapeHtml,
    renderMarkdown: markdown.renderMarkdown,
    formatDate: stateModule.formatDate,
    getBotName: stateModule.getBotName
  });
  const modal = modalModule.createModalController({
    state,
    el,
    doc: dom.window.document,
    raf: (callback) => callback()
  });
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
    getBotName: stateModule.getBotName
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
    doc: dom.window.document
  });

  return { dom, storage, calls, state, el, api, view, modal, clipboard, controllers };
}

test('web UI loads a single native ES module entry point instead of ordered global scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\.\/app\/main\.mjs"><\/script>/);
  assert.doesNotMatch(html, /<script src="app-/);
  assert.doesNotMatch(html, /<script src="markdown\.js"/);
  assert.equal(typeof mainModule.createRuntime, 'function');
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
  assert.match(harness.el.folderList.innerHTML, /&lt;Work&gt;/);
  assert.doesNotMatch(harness.el.folderList.innerHTML, /<Work>/);

  harness.state.selectedFolderId = 'f1';
  harness.view.renderSessions();
  assert.match(harness.el.sessionList.textContent, /<Pinned>/);
  assert.doesNotMatch(harness.el.sessionList.textContent, /Unfiled/);

  harness.state.selectedFolderId = 'unfiled';
  harness.view.renderSessions();
  assert.match(harness.el.sessionList.textContent, /Unfiled/);
  assert.doesNotMatch(harness.el.sessionList.textContent, /<Pinned>/);
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

test('event wiring delegates sidebar folder clicks and copy buttons to controllers', async () => {
  const harness = createHarness();
  let selectedFolder = null;
  let copiedMessage = null;
  eventsModule.wireEvents({
    state: harness.state,
    el: harness.el,
    view: { ...harness.view, applySidebarState() {}, toggleSidebar() {}, syncSenderCheckbox() {} },
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
});
