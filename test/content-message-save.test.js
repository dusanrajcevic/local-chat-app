const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const messageSave = require('../browser-extension/content-message-save');
const contentDom = require('../browser-extension/content-dom');

function installDom(bodyHtml = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://chatgpt.com/c/test',
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
    return { x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 34, width: 100, height: 24 };
  };

  return dom;
}

function createController(overrides = {}, options = {}) {
  return messageSave.createMessageSaveController(
    {
      markers: contentDom.markers,
      normalizeText: contentDom.normalizeText,
      selectionInside: contentDom.selectionInside,
      findMessageContainer: contentDom.findMessageContainer,
      extractMessageTextFallback: contentDom.extractMessageTextFallback,
      isInsideComposer: () => false,
      ...overrides
    },
    {
      clipboardCaptureTimeoutMs: 20,
      clipboardCapturePollMs: 0,
      ...options
    }
  );
}

test.afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.navigator;
  delete global.location;
});

test('message-save extraction prefers selected text without clicking the provider copy button', async () => {
  installDom('<article><p>Fallback text</p><button id="copy">Copy</button></article>');
  let clicked = false;
  const controller = createController({ selectionInside: () => 'Selected text' });
  const button = document.querySelector('#copy');
  button.addEventListener('click', () => {
    clicked = true;
  });

  const text = await controller.extractMessageText(document.querySelector('article'), button, 'bot');

  assert.equal(text, 'Selected text');
  assert.equal(clicked, false);
});

test('message-save extraction captures provider clipboard output and restores prior clipboard text', async () => {
  installDom(
    '<article data-message-author-role="assistant"><p>Copied assistant answer</p><button id="copy">Copy</button></article>'
  );
  let clipboardValue = 'Previous clipboard';
  const writes = [];
  const controller = createController({
    navigator: {
      clipboard: {
        async readText() {
          return clipboardValue;
        },
        async writeText(value) {
          writes.push(value);
          clipboardValue = value;
        }
      }
    }
  });
  const button = document.querySelector('#copy');
  button.addEventListener('click', () => {
    clipboardValue = 'Copied assistant answer';
  });

  const text = await controller.extractMessageText(document.querySelector('article'), button, 'bot');

  assert.equal(text, 'Copied assistant answer');
  assert.deepEqual(writes, ['Previous clipboard']);
  assert.equal(clipboardValue, 'Previous clipboard');
});

test('message-save extraction falls back to DOM text when clipboard capture is unavailable', async () => {
  installDom(
    '<article data-message-author-role="assistant"><div data-testid="message-content">DOM fallback answer</div><button id="copy">Copy</button></article>'
  );
  const controller = createController({ navigator: { clipboard: {} } });

  const text = await controller.extractMessageText(
    document.querySelector('article'),
    document.querySelector('#copy'),
    'bot'
  );

  assert.equal(text, 'DOM fallback answer');
});

test('message-save visibleMessageContainers filters extension UI, composer content, hidden elements, and duplicates', () => {
  installDom(`
    <main>
      <article id="user" data-message-author-role="user"><p>Hello</p></article>
      <article id="assistant" data-message-author-role="assistant"><div data-testid="message-content">Answer</div></article>
      <article id="hidden" data-message-author-role="assistant" hidden><p>Hidden</p></article>
      <article id="extension" ${contentDom.markers.EXT_MARKER}="true"><p>Extension UI</p></article>
      <form id="composer"><article id="composer-message" data-message-author-role="user"><p>Draft prompt</p></article></form>
    </main>
  `);
  const controller = createController({
    isInsideComposer: (element) => Boolean(element.closest('#composer'))
  });

  const ids = controller
    .visibleMessageContainers()
    .map((element) => element.id)
    .sort();

  assert.deepEqual(ids, ['assistant', 'user']);
});
