const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

let mainModule;

function publicModulePath(name) {
  return pathToFileURL(path.join(__dirname, '..', 'public', 'app', name)).href;
}

before(async () => {
  mainModule = await import(publicModulePath('main.mjs'));
});

function loadDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3000', pretendToBeVisual: true });
  dom.window.alert = () => {};
  dom.window.confirm = () => true;
  dom.window.requestAnimationFrame = (callback) => callback();
  dom.window.setInterval = () => 1;
  dom.window.clearInterval = () => {};
  return dom;
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

function createFakeBackend() {
  const calls = [];
  const state = {
    folders: [{ id: 'f1', name: 'Work' }],
    sessions: [
      {
        id: 's1',
        title: 'Existing',
        aiName: 'Assistant',
        pinnedFolderId: 'f1',
        trashed: false,
        createdAt: '2026-07-09T09:00:00.000Z',
        updatedAt: '2026-07-09T09:00:00.000Z',
        messages: [{ id: 'm1', sender: 'me', text: 'Seed message', createdAt: '2026-07-09T09:00:00.000Z' }]
      }
    ],
    trash: [],
    activeSessionId: 's1',
    nextFolder: 2,
    nextSession: 2,
    nextMessage: 2
  };

  function now() {
    return `2026-07-09T09:${String(state.nextMessage).padStart(2, '0')}:00.000Z`;
  }

  function summarizeSession(session) {
    return {
      id: session.id,
      title: session.title,
      aiName: session.aiName,
      pinnedFolderId: session.pinnedFolderId || null,
      dateFolder: '2026-07-09',
      messageCount: session.messages.length,
      updatedAt: session.updatedAt,
      trashed: session.trashed
    };
  }

  function json(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  function readJson(options) {
    return options?.body ? JSON.parse(options.body) : {};
  }

  function findSession(id) {
    return state.sessions.find((session) => session.id === id) || state.trash.find((session) => session.id === id);
  }

  async function fetchImpl(url, options = {}) {
    const method = options.method || 'GET';
    calls.push({ method, url, body: options.body || null });

    if (method === 'GET' && url === '/api/folders') return json(state.folders);
    if (method === 'GET' && url === '/api/sessions')
      return json(state.sessions.filter((session) => !session.trashed).map(summarizeSession));
    if (method === 'GET' && url === '/api/trash') return json(state.trash.map(summarizeSession));
    if (method === 'GET' && url === '/api/active-session') {
      const session = state.activeSessionId ? findSession(state.activeSessionId) : null;
      return json({
        sessionId: session?.id || null,
        session: session ? summarizeSession(session) : null,
        updatedAt: session?.updatedAt || null
      });
    }

    if (method === 'PUT' && url === '/api/active-session') {
      state.activeSessionId = readJson(options).sessionId || null;
      return json({ sessionId: state.activeSessionId });
    }

    if (method === 'DELETE' && url === '/api/active-session') {
      state.activeSessionId = null;
      return json({ sessionId: null });
    }

    if (method === 'POST' && url === '/api/folders') {
      const body = readJson(options);
      const folder = { id: `f${state.nextFolder++}`, name: body.name };
      state.folders.push(folder);
      return json(folder, 201);
    }

    const folderMatch = url.match(/^\/api\/folders\/([^/]+)$/);
    if (folderMatch && method === 'PATCH') {
      const folder = state.folders.find((item) => item.id === folderMatch[1]);
      folder.name = readJson(options).name;
      return json(folder);
    }
    if (folderMatch && method === 'DELETE') {
      state.folders = state.folders.filter((item) => item.id !== folderMatch[1]);
      state.sessions.forEach((session) => {
        if (session.pinnedFolderId === folderMatch[1]) session.pinnedFolderId = null;
      });
      return json({ ok: true });
    }

    if (method === 'POST' && url === '/api/sessions') {
      const body = readJson(options);
      const session = {
        id: `s${state.nextSession++}`,
        title: body.title,
        aiName: '',
        pinnedFolderId: body.pinnedFolderId || null,
        trashed: false,
        createdAt: '2026-07-09T10:00:00.000Z',
        updatedAt: '2026-07-09T10:00:00.000Z',
        messages: []
      };
      state.sessions.push(session);
      return json(summarizeSession(session), 201);
    }

    const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'GET') return json(findSession(sessionMatch[1]));
    if (sessionMatch && method === 'PATCH') {
      const session = findSession(sessionMatch[1]);
      Object.assign(session, readJson(options), { updatedAt: '2026-07-09T10:01:00.000Z' });
      return json(session);
    }
    if (sessionMatch && method === 'DELETE') {
      const session = findSession(sessionMatch[1]);
      state.sessions = state.sessions.filter((item) => item.id !== session.id);
      session.trashed = true;
      state.trash.push(session);
      if (state.activeSessionId === session.id) state.activeSessionId = null;
      return json({ ok: true });
    }

    const pinMatch = url.match(/^\/api\/sessions\/([^/]+)\/pin$/);
    if (pinMatch && method === 'PATCH') {
      const session = findSession(pinMatch[1]);
      session.pinnedFolderId = readJson(options).pinnedFolderId || null;
      return json(session);
    }

    const messagePostMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagePostMatch && method === 'POST') {
      const session = findSession(messagePostMatch[1]);
      const body = readJson(options);
      const message = { id: `m${state.nextMessage++}`, sender: body.sender, text: body.text, createdAt: now() };
      session.messages.push(message);
      session.updatedAt = message.createdAt;
      return json(message, 201);
    }

    const trashRestoreMatch = url.match(/^\/api\/trash\/([^/]+)\/restore$/);
    if (trashRestoreMatch && method === 'POST') {
      const session = findSession(trashRestoreMatch[1]);
      state.trash = state.trash.filter((item) => item.id !== session.id);
      session.trashed = false;
      state.sessions.push(session);
      return json(summarizeSession(session));
    }

    const trashDeleteMatch = url.match(/^\/api\/trash\/([^/]+)$/);
    if (trashDeleteMatch && method === 'DELETE') {
      state.trash = state.trash.filter((session) => session.id !== trashDeleteMatch[1]);
      return json({ ok: true });
    }

    throw new Error(`Unhandled fake route: ${method} ${url}`);
  }

  return { state, calls, fetchImpl };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('browser-level web UI flow boots, creates folders/sessions, sends messages, and uses trash lifecycle', async () => {
  const dom = loadDom();
  const storage = createMemoryStorage();
  const backend = createFakeBackend();
  const runtime = mainModule.createRuntime({
    doc: dom.window.document,
    win: dom.window,
    storage,
    fetchImpl: backend.fetchImpl
  });

  await runtime.controllers.boot();
  assert.equal(runtime.state.currentSession.id, 's1');
  assert.match(runtime.el.sessionList.textContent, /Existing/);
  assert.match(runtime.el.messages.textContent, /Seed message/);

  runtime.el.newFolderBtn.click();
  await flush();
  runtime.el.appPromptInput.value = 'Research';
  runtime.el.saveAppPromptBtn.click();
  await flush();
  assert.match(runtime.el.folderList.textContent, /Research/);
  assert.ok(backend.calls.some((call) => call.method === 'POST' && call.url === '/api/folders'));

  runtime.el.folderList.querySelector('[data-folder="f2"]').click();
  runtime.el.newChatBtn.click();
  await flush();
  runtime.el.appPromptInput.value = 'New Browser Flow';
  runtime.el.saveAppPromptBtn.click();
  await flush();
  assert.equal(runtime.state.currentSession.title, 'New Browser Flow');
  assert.equal(runtime.state.currentSession.pinnedFolderId, 'f2');
  assert.match(runtime.el.chatTitle.textContent, /New Browser Flow/);

  runtime.el.messageInput.value = 'Hello from integration';
  runtime.el.sendBtn.click();
  await flush();
  assert.match(runtime.el.messages.textContent, /Hello from integration/);
  assert.equal(runtime.el.messageInput.value, '');
  assert.ok(backend.calls.some((call) => call.method === 'POST' && call.url.endsWith('/messages')));

  runtime.el.renameSessionBtn.click();
  await flush();
  runtime.el.appPromptInput.value = 'Renamed Browser Flow';
  runtime.el.saveAppPromptBtn.click();
  await flush();
  assert.equal(runtime.state.currentSession.title, 'Renamed Browser Flow');
  assert.match(runtime.el.chatTitle.textContent, /Renamed Browser Flow/);

  const currentSessionId = runtime.state.currentSession.id;
  runtime.el.sessionList.querySelector(`[data-trash-session="${currentSessionId}"]`).click();
  await flush();
  assert.equal(runtime.state.currentSession, null);
  assert.match(runtime.el.trashList.textContent, /Renamed Browser Flow/);

  runtime.el.trashList.querySelector(`[data-restore-session="${currentSessionId}"]`).click();
  await flush();
  assert.match(runtime.el.sessionList.textContent, /Renamed Browser Flow/);
});
