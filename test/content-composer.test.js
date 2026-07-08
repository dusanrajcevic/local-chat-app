const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const composer = require('../browser-extension/content-composer');
const contentDom = require('../browser-extension/content-dom');

function installComposerDom(bodyHtml = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://chatgpt.com/c/test?temporary-chat=true',
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
  global.InputEvent = window.InputEvent;
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
    if (this.hasAttribute('hidden') || this.getAttribute('aria-hidden') === 'true' || this.dataset.hidden === 'true') {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    if (this.textContent?.trim() === '+') {
      return { x: 8, y: 8, top: 8, left: 8, right: 48, bottom: 48, width: 40, height: 40 };
    }
    return { x: 10, y: 10, top: 10, left: 10, right: 410, bottom: 90, width: 400, height: 80 };
  };

  return dom;
}

function createChromeMock(responses) {
  const calls = [];
  return {
    calls,
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        const handler = responses[message.type];
        if (typeof handler === 'function') return handler(message, calls);
        return handler || { ok: true };
      }
    }
  };
}

function createController(overrides = {}, options = {}) {
  const toasts = [];
  const activeExports = [];
  const scheduledRefreshes = [];
  const pinEvents = [];
  const controller = composer.createComposerController(
    {
      markers: contentDom.markers,
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
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      shouldExposeLocalChatUi: () => true,
      showToast: (message, isError = false) => toasts.push({ message, isError }),
      resetComposerSnapshot: () => {},
      getSidebarData: () => ({
        folders: [
          { id: 'folder_work', name: 'Work' },
          { id: 'folder_personal', name: 'Personal' }
        ],
        activeSessionId: 'chat_alpha'
      }),
      getActiveLocalSidebarSession: () => ({ id: 'chat_alpha', title: 'Alpha', pinnedFolderId: 'folder_work' }),
      setActiveSessionFromExport: (...args) => activeExports.push(args),
      requestLocalSidebarData: async () => ({ folders: [], sessions: [], activeSessionId: 'chat_alpha' }),
      scheduleLocalSidebarRefresh: (force = false) => scheduledRefreshes.push(force),
      isLocalPinSelectElement: (element) => Boolean(element?.matches?.('[data-local-sidebar-pin-select]')),
      markLocalPinSelectInteraction: () => pinEvents.push('mark'),
      isLocalPinSelectInteracting: () => false,
      handleLocalPinSelectInteractionEvent: () => pinEvents.push('interact'),
      handleLocalSidebarChange: (event) => pinEvents.push(`change:${event.target?.value || ''}`),
      chromeApi: createChromeMock({}),
      ...overrides
    },
    {
      pastedAttachmentWatchMs: 1,
      pastedAttachmentPollMs: 1,
      composerReadyTimeoutMs: 30,
      composerReadyPollMs: 1,
      composerClearSettleMs: 0,
      modalSearchDebounceMs: 1,
      ...options
    }
  );

  return { controller, toasts, activeExports, scheduledRefreshes, pinEvents };
}

async function waitFor(condition, timeoutMs = 120) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), 'condition was not met before timeout');
}

test.afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.navigator;
  delete global.location;
  delete global.InputEvent;
  delete global.Event;
});

test('content composer detects composer, attach button, send button, and current text', () => {
  installComposerDom(`
    <main>
      <form id="composer-form">
        <button id="attach" aria-label="Attach file">+</button>
        <textarea id="prompt" aria-label="Message ChatGPT">Draft prompt</textarea>
        <button id="send" aria-label="Send message">Send</button>
      </form>
    </main>
  `);
  const { controller } = createController();
  const input = document.querySelector('#prompt');

  assert.equal(controller.findComposerContainer().id, 'composer-form');
  assert.equal(controller.composerInputs(controller.findComposerContainer())[0], input);
  assert.equal(controller.textFromComposer(controller.findComposerContainer()), 'Draft prompt');
  assert.equal(controller.findAttachButton().id, 'attach');
  assert.equal(controller.findSendButtonNear(input).id, 'send');
  assert.equal(controller.isSendButton(document.querySelector('#attach')), false);
});

test('content composer replaces the composer text and emits input/change events', async () => {
  installComposerDom(`
    <main>
      <form id="composer-form">
        <textarea id="prompt" aria-label="Message ChatGPT">Old text</textarea>
        <button aria-label="Send message">Send</button>
      </form>
    </main>
  `);
  const { controller } = createController();
  const input = document.querySelector('#prompt');
  const events = [];
  input.addEventListener('input', () => events.push('input'));
  input.addEventListener('change', () => events.push('change'));

  await controller.replaceComposerWithText('Loaded local transcript');

  assert.equal(input.value, 'Loaded local transcript');
  assert.ok(events.includes('input'));
  assert.ok(events.includes('change'));
});

test('content composer detects pasted-text attachments and clears duplicate textbox content', async () => {
  installComposerDom(`
    <main>
      <form id="composer-form">
        <textarea id="prompt" aria-label="Message ChatGPT">Very long pasted transcript</textarea>
        <button aria-label="Send message">Send</button>
        <div id="chip" aria-label="Pasted text too long to show">
          Pasted text attachment
          <button id="remove" aria-label="Remove pasted text attachment">×</button>
        </div>
      </form>
    </main>
  `);
  const { controller, toasts } = createController();
  const input = document.querySelector('#prompt');
  const chip = document.querySelector('#chip');
  document.querySelector('#remove').addEventListener('click', () => chip.remove());

  assert.equal(controller.hasPastedTextAttachment(controller.findComposerContainer()), true);
  assert.equal(await controller.clearComposerTextIfPastedAttachmentAppears(input, 'Very long pasted transcript'), true);
  assert.equal(input.value, '');
  assert.ok(toasts.some((toast) => /pasted-text attachment/i.test(toast.message)));

  assert.equal(await controller.removePastedTextAttachmentsNearComposer(controller.findComposerContainer()), true);
  assert.equal(document.querySelector('#chip'), null);
});

test('content composer renders load-past modal, searches, loads export, and pastes transcript', async () => {
  installComposerDom(`
    <main>
      <form id="composer-form">
        <textarea id="prompt" aria-label="Message ChatGPT"></textarea>
        <button aria-label="Send message">Send</button>
      </form>
    </main>
  `);

  const chromeApi = createChromeMock({
    LIST_RECENT_LOCAL_CHATS: {
      ok: true,
      chats: [
        { id: 'chat_alpha', title: 'Alpha', aiName: 'ChatGPT', messageCount: 2, updatedAt: '2026-07-09T10:00:00Z' }
      ]
    },
    SEARCH_LOCAL_CHATS: {
      ok: true,
      chats: [
        {
          id: 'chat_beta',
          title: 'Beta <unsafe>',
          aiName: 'Claude',
          messageCount: 3,
          updatedAt: '2026-07-09T11:00:00Z',
          match: { messageCount: 1, preview: '<script>match</script>' }
        }
      ]
    },
    LOAD_LOCAL_CHAT_EXPORT: { ok: true, text: 'Exported Beta transcript', session: { id: 'chat_beta', title: 'Beta' } }
  });
  const { controller, activeExports, scheduledRefreshes, toasts } = createController({ chromeApi });

  controller.openLoadPastModal();
  await waitFor(() => /Alpha/.test(document.querySelector('.local-chat-modal-list')?.textContent || ''));

  const searchInput = document.querySelector('.local-chat-modal-search');
  searchInput.value = 'beta';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => /Beta <unsafe>/.test(document.querySelector('.local-chat-modal-list')?.textContent || ''));

  assert.equal(document.querySelector('.local-chat-modal-list').innerHTML.includes('<script>'), false);
  document.querySelector('[data-local-chat-session-id="chat_beta"]').click();

  await waitFor(() => document.querySelector('#prompt').value === 'Exported Beta transcript');
  assert.equal(activeExports.length, 1);
  assert.equal(activeExports[0][1], 'chat_beta');
  assert.deepEqual(scheduledRefreshes, [true]);
  assert.ok(toasts.some((toast) => /Selected local conversation → Beta/.test(toast.message)));
  assert.equal(document.querySelector('#local-chat-load-past-modal'), null);
});

test('content composer injects top load controls and wires active-folder changes', async () => {
  installComposerDom(`
    <main>
      <form id="composer-form">
        <textarea id="prompt" aria-label="Message ChatGPT"></textarea>
        <button aria-label="Send message">Send</button>
      </form>
    </main>
  `);
  const { controller, pinEvents } = createController();

  controller.injectLoadPastButton();
  await waitFor(() => document.querySelector(`[${contentDom.markers.LOAD_PAST_MARKER}]`));

  const controls = document.querySelector(`[${contentDom.markers.LOAD_PAST_MARKER}]`);
  const select = controls.querySelector('[data-local-sidebar-pin-select]');
  assert.ok(controls.textContent.includes('Load past conversations'));
  assert.equal(select.value, 'folder_work');

  select.value = 'folder_personal';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(pinEvents.includes('change:folder_personal'));

  const message = document.createElement('article');
  message.setAttribute('data-message-author-role', 'assistant');
  message.innerHTML = '<p>A visible assistant answer</p><button>Copy</button>';
  document.body.appendChild(message);

  controller.injectLoadPastButton();
  assert.equal(document.querySelector(`[${contentDom.markers.LOAD_PAST_MARKER}]`), null);
});
