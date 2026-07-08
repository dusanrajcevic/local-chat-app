const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const runtime = require('../browser-extension/content-runtime');
const contentDom = require('../browser-extension/content-dom');

function installRuntimeDom(bodyHtml = '', url = 'https://chatgpt.com/c/test?temporary-chat=true') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url,
    pretendToBeVisual: true
  });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.navigator = window.navigator;
  global.location = window.location;
  global.Event = window.Event;

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
    if (this.id === 'composer-form') {
      return { x: 10, y: 640, top: 640, left: 10, right: 510, bottom: 720, width: 500, height: 80 };
    }
    if (this.tagName === 'MAIN') {
      return { x: 0, y: 600, top: 600, left: 0, right: 700, bottom: 760, width: 700, height: 160 };
    }
    return { x: 10, y: 10, top: 10, left: 10, right: 160, bottom: 42, width: 150, height: 32 };
  };

  return dom;
}

function createChromeMock(responses = {}) {
  const calls = [];
  const storage = {};
  return {
    calls,
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        const handler = responses[message.type];
        if (typeof handler === 'function') return handler(message, calls);
        return handler || { ok: true };
      }
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          calls.push({ type: 'storage.set', values });
          Object.assign(storage, values);
        }
      },
      onChanged: {
        addListener() {}
      }
    }
  };
}

function visible(element) {
  const rect = element?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function createController(overrides = {}, options = {}) {
  const toasts = [];
  const sidebarCalls = [];
  const autosaveCalls = [];
  const chromeApi = overrides.chromeApi || createChromeMock();
  const sidebarController = {
    invalidateLocalSidebarCache: () => sidebarCalls.push('invalidate'),
    removeLocalSidebarReplacement: () => sidebarCalls.push('remove'),
    scheduleLocalSidebarRefresh: (force = false) => sidebarCalls.push(`refresh:${force}`),
    shouldShowLocalSidebarReplacement: () => false,
    loadLocalSidebarPreference: async () => sidebarCalls.push('load-pref'),
    consumePendingLocalSidebarLoad: () => sidebarCalls.push('consume-pending'),
    currentLocalChatTarget: () => ({ sessionId: 'chat_alpha' }),
    ...overrides.sidebarController
  };
  const autosaveController = {
    clearTransientState: (...args) => autosaveCalls.push(['clear', ...args]),
    isAssistantMessageReadyForButton: () => true,
    scheduleOutgoingDomSaveIfNeeded: () => autosaveCalls.push(['schedule-outgoing']),
    scheduleAssistantAutoSave: (...args) => autosaveCalls.push(['schedule-assistant', ...args]),
    saveContainer: (...args) => autosaveCalls.push(['save-container', ...args]),
    installOutgoingPromptAutoSave: () => autosaveCalls.push(['install-outgoing']),
    ...overrides.autosaveController
  };

  const controller = runtime.createRuntimeController(
    {
      markers: contentDom.markers,
      normalizeText: contentDom.normalizeText,
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      isVisibleElement: visible,
      findMessageContainer: contentDom.findMessageContainer,
      inferSender: contentDom.inferSender,
      isCopyButton: contentDom.isCopyButton,
      isNestedContentCopyButton: contentDom.isNestedContentCopyButton,
      buttonLabel: (button) =>
        [button?.getAttribute?.('aria-label'), button?.textContent].filter(Boolean).join(' ').toLowerCase(),
      findComposerContainer: () => document.querySelector('#composer-form'),
      composerInputs: (composer) =>
        Array.from(composer?.querySelectorAll?.('textarea, [contenteditable="true"]') || []),
      showToast: (message, isError = false) => toasts.push({ message, isError }),
      removeLoadPastButtons: () =>
        document.querySelectorAll(`[${contentDom.markers.LOAD_PAST_MARKER}]`).forEach((button) => button.remove()),
      injectLoadPastButton: () => {},
      getSidebarController: () => sidebarController,
      getAutosaveController: () => autosaveController,
      chromeApi,
      requestAnimationFrame: (callback) => {
        callback();
        return 0;
      },
      ...overrides.deps
    },
    {
      localChatAppHealthCheckMinMs: 0,
      localChatAppHealthCheckOfflineMs: 10_000,
      localChatAppHealthCheckOnlineMs: 10_000,
      periodicInjectMs: 10_000,
      ...options
    }
  );

  return { controller, chromeApi, toasts, sidebarCalls, autosaveCalls };
}

test.afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.navigator;
  delete global.location;
  delete global.Event;
});

test('content runtime injects the auto-save toggle and persists toggle changes', async () => {
  installRuntimeDom(`
    <main>
      <form id="composer-form">
        <textarea aria-label="Message ChatGPT"></textarea>
      </form>
    </main>
  `);
  const { controller, chromeApi, toasts, autosaveCalls } = createController();
  controller.setStateForTest({
    localChatAppAvailable: true,
    localChatAppAvailabilityLoaded: true,
    localChatAutoSendEnabled: true,
    autoSendPreferenceLoaded: true
  });

  controller.injectAutoSendToggle();

  const mount = document.querySelector(`[${contentDom.markers.AUTO_SEND_TOGGLE_MOUNT_MARKER}]`);
  const toggle = document.querySelector(`[${contentDom.markers.AUTO_SEND_TOGGLE_MARKER}]`);
  const checkbox = toggle.querySelector('input[type="checkbox"]');
  assert.equal(mount.parentElement, document.querySelector('#composer-form').parentElement);
  assert.equal(checkbox.checked, true);
  assert.equal(toggle.querySelector('.local-chat-auto-send-status').textContent, 'On');

  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(
    chromeApi.calls.some((call) => call.type === 'storage.set' && call.values.localChatAutoSendEnabled === false)
  );
  assert.ok(toasts.some((toast) => /paused/i.test(toast.message)));
  assert.ok(autosaveCalls.some((call) => call[0] === 'clear'));
});

test('content runtime hides local UI when the local app becomes unavailable', () => {
  installRuntimeDom(`
    <main>
      <button ${contentDom.markers.EXT_MARKER}="true">Save local</button>
      <button ${contentDom.markers.LOAD_PAST_MARKER}="true">Load past</button>
      <label ${contentDom.markers.AUTO_SEND_TOGGLE_MARKER}="true"><input type="checkbox"></label>
      <div ${contentDom.markers.AUTO_SEND_TOGGLE_MOUNT_MARKER}="true"></div>
    </main>
  `);
  const { controller, sidebarCalls, autosaveCalls } = createController();
  controller.setStateForTest({ localChatAppAvailable: true, localChatAppAvailabilityLoaded: true });

  controller.setLocalChatAppAvailability(false, 'Connection refused');

  assert.equal(document.querySelector(`[${contentDom.markers.EXT_MARKER}]`), null);
  assert.equal(document.querySelector(`[${contentDom.markers.LOAD_PAST_MARKER}]`), null);
  assert.equal(document.querySelector(`[${contentDom.markers.AUTO_SEND_TOGGLE_MARKER}]`), null);
  assert.ok(sidebarCalls.includes('remove'));
  assert.ok(autosaveCalls.some((call) => call[0] === 'clear'));
  controller.resetForTest();
});

test('content runtime injects Save local buttons and delegates clicks to autosave', () => {
  installRuntimeDom(`
    <main>
      <article data-message-author-role="user">
        <div data-testid="message-content">Hello from the user</div>
        <button aria-label="Copy message">Copy</button>
      </article>
    </main>
  `);
  const { controller, autosaveCalls } = createController();
  controller.setStateForTest({
    localChatAppAvailable: true,
    localChatAppAvailabilityLoaded: true,
    localChatAutoSendEnabled: false,
    autoSendPreferenceLoaded: true
  });

  controller.injectButtons();

  const saveButton = document.querySelector(`[${contentDom.markers.EXT_MARKER}]`);
  assert.ok(saveButton, 'expected Save local button to be injected');
  assert.equal(saveButton.textContent, 'Save local');
  assert.equal(controller.saveButtonForCopyButton(document.querySelector('[aria-label="Copy message"]')), saveButton);

  saveButton.click();
  assert.ok(autosaveCalls.some((call) => call[0] === 'save-container'));
});

test('content runtime health checks update availability and invalidate sidebar after saves', async () => {
  installRuntimeDom('<main></main>');
  const chromeApi = createChromeMock({
    CHECK_LOCAL_CHAT_APP: { ok: true },
    SAVE_LOCAL_CHAT_MESSAGE: { ok: true, message: { id: 'msg_1' } }
  });
  const { controller, sidebarCalls } = createController({ chromeApi });

  assert.equal(await controller.checkLocalChatAppAvailability(true), true);
  assert.equal(controller.getStateForTest().localChatAppAvailable, true);

  await controller.sendLocalChatMessage({ text: 'Saved manually', sender: 'me' });

  assert.ok(chromeApi.calls.some((call) => call.type === 'CHECK_LOCAL_CHAT_APP'));
  assert.ok(chromeApi.calls.some((call) => call.type === 'SAVE_LOCAL_CHAT_MESSAGE'));
  assert.ok(sidebarCalls.includes('invalidate'));
  controller.resetForTest();
});
