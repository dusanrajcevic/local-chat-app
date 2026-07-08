const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const sidebar = require('../browser-extension/content-sidebar');
const contentDom = require('../browser-extension/content-dom');

function installSidebarDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
    <nav id="provider-sidebar" aria-label="Chat history">
      <button id="new-chat">New chat</button>
      <section id="native-history" class="chat-list">
        <h2>Chats</h2>
        <button>Native chat one</button>
        <button>Native chat two</button>
      </section>
    </nav>
    <main><textarea id="composer"></textarea></main>
  </body></html>`,
    {
      url: 'https://chatgpt.com/c/test?temporary-chat=true',
      pretendToBeVisual: true
    }
  );

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.navigator = window.navigator;
  global.location = window.location;
  global.sessionStorage = window.sessionStorage;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
      set(value) {
        this.textContent = value;
      }
    });
  }

  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.hasAttribute('hidden') || this.getAttribute('aria-hidden') === 'true') {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    if (this.id === 'provider-sidebar') {
      return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 760, width: 300, height: 760 };
    }
    if (this.id === 'native-history') {
      return { x: 10, y: 90, top: 90, left: 10, right: 290, bottom: 650, width: 280, height: 560 };
    }
    return { x: 10, y: 10, top: 10, left: 10, right: 210, bottom: 58, width: 200, height: 48 };
  };

  return dom;
}

function createChromeMock(responses) {
  const calls = [];
  const storage = {};
  return {
    calls,
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        const handler = responses[message.type];
        if (typeof handler === 'function') return handler(message, calls);
        if (handler) return handler;
        return { ok: true };
      }
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    }
  };
}

function createController(chromeApi, overrides = {}) {
  const toasts = [];
  const pasted = [];
  const loadPastUpdates = [];
  const availability = [];
  const controller = sidebar.createSidebarController(
    {
      markers: contentDom.markers,
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      normalizeText: contentDom.normalizeText,
      isVisibleElement: (element) => {
        const rect = element?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      },
      escapeHtml(value) {
        return String(value ?? '').replace(
          /[&<>"']/g,
          (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
        );
      },
      formatLocalDate: () => 'Jul 9',
      isAutoSendEnabled: () => true,
      shouldExposeLocalChatUi: () => true,
      ensureTemporaryChatUrlForLocalMode: () => false,
      isLocalChatAppConnectionError: (message) => /failed|network/i.test(String(message || '')),
      setLocalChatAppAvailability: (available, error) => availability.push({ available, error }),
      replaceComposerWithText: async (text) => {
        pasted.push(text);
      },
      updateLoadPastControls: (options) => loadPastUpdates.push(options || {}),
      showToast: (message, isError = false) => toasts.push({ message, isError }),
      chromeApi,
      ...overrides
    },
    { localSidebarRefreshMs: 50 }
  );

  return { controller, toasts, pasted, loadPastUpdates, availability };
}

test.afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.navigator;
  delete global.location;
  delete global.sessionStorage;
  delete global.requestAnimationFrame;
});

const sidebarPayload = {
  ok: true,
  folders: [
    { id: 'folder_work', name: 'Work' },
    { id: 'folder_personal', name: 'Personal' }
  ],
  sessions: [
    {
      id: 'chat_alpha',
      title: 'Alpha',
      dateFolder: '2026-07-09',
      messageCount: 3,
      pinnedFolderId: 'folder_work',
      updatedAt: '2026-07-09T10:00:00Z'
    },
    {
      id: 'chat_beta',
      title: 'Beta',
      dateFolder: '2026-07-08',
      messageCount: 1,
      pinnedFolderId: null,
      updatedAt: '2026-07-08T10:00:00Z'
    }
  ],
  activeSessionId: 'chat_alpha',
  active: {
    sessionId: 'chat_alpha',
    session: { id: 'chat_alpha', title: 'Alpha', pinnedFolderId: 'folder_work' }
  }
};

test('content sidebar renders local folders and sessions from a provider-sidebar fixture', async () => {
  installSidebarDom();
  const chromeApi = createChromeMock({ LIST_LOCAL_SIDEBAR: sidebarPayload });
  const { controller } = createController(chromeApi);

  await controller.refreshLocalSidebarReplacement(true);

  const panel = document.querySelector(`[${contentDom.markers.LOCAL_SIDEBAR_MARKER}]`);
  assert.ok(panel, 'expected local sidebar panel to be inserted');
  assert.equal(panel.parentElement.id, 'provider-sidebar');
  assert.match(panel.textContent, /Local folders/);
  assert.match(panel.textContent, /Work/);
  assert.match(panel.textContent, /Personal/);
  assert.match(panel.textContent, /Alpha/);
  assert.match(panel.textContent, /Beta/);
  assert.equal(panel.querySelector('.local-chat-sidebar-chat.active')?.dataset.localSidebarSessionId, 'chat_alpha');
  assert.equal(panel.querySelector('[data-local-sidebar-pin-select]')?.value, 'folder_work');
});

test('content sidebar selects a session, loads its export, and updates active state', async () => {
  installSidebarDom();
  let activeId = 'chat_alpha';
  const chromeApi = createChromeMock({
    LIST_LOCAL_SIDEBAR: () => ({
      ...sidebarPayload,
      activeSessionId: activeId,
      active: {
        sessionId: activeId,
        session:
          activeId === 'chat_beta'
            ? { id: 'chat_beta', title: 'Beta', pinnedFolderId: null }
            : { id: 'chat_alpha', title: 'Alpha', pinnedFolderId: 'folder_work' }
      }
    }),
    LOAD_LOCAL_CHAT_EXPORT: () => {
      activeId = 'chat_beta';
      return {
        ok: true,
        sessionId: 'chat_beta',
        sessionTitle: 'Beta',
        text: 'Previously saved Beta transcript',
        session: { id: 'chat_beta', title: 'Beta', pinnedFolderId: null }
      };
    }
  });
  const { controller, pasted, toasts } = createController(chromeApi);

  await controller.refreshLocalSidebarReplacement(true);
  await controller.selectLocalSidebarSession('chat_beta');

  assert.deepEqual(pasted, ['Previously saved Beta transcript']);
  assert.equal(controller.getActiveLocalSidebarSession().id, 'chat_beta');
  assert.ok(
    chromeApi.calls.some((call) => call.type === 'LOAD_LOCAL_CHAT_EXPORT' && call.payload.sessionId === 'chat_beta')
  );
  assert.ok(toasts.some((toast) => /Loaded local chat → Beta/.test(toast.message)));
});

test('content sidebar refresh action re-requests data and re-renders changed sessions', async () => {
  installSidebarDom();
  let title = 'Alpha';
  const chromeApi = createChromeMock({
    LIST_LOCAL_SIDEBAR: () => ({
      ...sidebarPayload,
      sessions: sidebarPayload.sessions.map((session) =>
        session.id === 'chat_alpha' ? { ...session, title } : session
      ),
      active: { sessionId: 'chat_alpha', session: { id: 'chat_alpha', title, pinnedFolderId: 'folder_work' } }
    })
  });
  const { controller } = createController(chromeApi);

  await controller.refreshLocalSidebarReplacement(true);
  assert.match(document.querySelector(`[${contentDom.markers.LOCAL_SIDEBAR_MARKER}]`).textContent, /Alpha/);

  title = 'Alpha renamed remotely';
  document.querySelector('[data-local-sidebar-refresh]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.match(
    document.querySelector(`[${contentDom.markers.LOCAL_SIDEBAR_MARKER}]`).textContent,
    /Alpha renamed remotely/
  );
  assert.equal(chromeApi.calls.filter((call) => call.type === 'LIST_LOCAL_SIDEBAR').length, 2);
});

test('content sidebar hides native provider history sections and restores them on removal', async () => {
  installSidebarDom();
  const chromeApi = createChromeMock({ LIST_LOCAL_SIDEBAR: sidebarPayload });
  const { controller } = createController(chromeApi);

  await controller.refreshLocalSidebarReplacement(true);

  const nativeHistory = document.querySelector('#native-history');
  assert.equal(nativeHistory.getAttribute(contentDom.markers.LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER), 'true');
  assert.equal(nativeHistory.style.getPropertyValue('display'), 'none');

  controller.removeLocalSidebarReplacement();

  assert.equal(document.querySelector(`[${contentDom.markers.LOCAL_SIDEBAR_MARKER}]`), null);
  assert.equal(nativeHistory.hasAttribute(contentDom.markers.LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER), false);
  assert.equal(nativeHistory.style.getPropertyValue('display'), '');
});
