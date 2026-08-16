const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const contentProviders = require('../browser-extension/content-providers');
const contentDom = require('../browser-extension/content-dom');
const content = require('../browser-extension/content');

const fixtureDir = path.join(__dirname, 'fixtures', 'provider-dom');

function installDomFixture(name, url) {
  const html = fs.readFileSync(path.join(fixtureDir, `${name}.html`), 'utf8');
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true
  });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.MutationObserver = window.MutationObserver;
  global.navigator = window.navigator;
  global.location = window.location;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

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
    return { x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 34, width: 100, height: 24 };
  };

  global.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true })
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults };
        },
        async set() {}
      },
      onChanged: {
        addListener() {}
      }
    }
  };

  content.resetContentScriptStateForTest();
  content.setContentScriptStateForTest({
    localChatAppAvailable: true,
    localChatAppAvailabilityLoaded: true,
    localChatAutoSendEnabled: false,
    autoSendPreferenceLoaded: true
  });

  return dom;
}

function copyButtons() {
  return Array.from(document.querySelectorAll('button, [role="button"]'));
}

function validMessageCopyButtons() {
  return copyButtons().filter((button) => content.isCopyButton(button));
}

function containersBySender() {
  const result = new Map();
  for (const copyButton of validMessageCopyButtons()) {
    const container = content.findMessageContainer(copyButton);
    assert.ok(container, `expected a message container for ${copyButton.outerHTML}`);
    result.set(content.inferSender(container), { container, copyButton });
  }
  return result;
}

test.afterEach(() => {
  content.resetContentScriptStateForTest();
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.MutationObserver;
  delete global.navigator;
  delete global.location;
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
  delete global.chrome;
});

test('provider adapter registry resolves supported hosts and exposes provider-specific selectors', () => {
  const expected = {
    'chatgpt.com': 'chatgpt',
    'chat.openai.com': 'chatgpt',
    'claude.ai': 'claude',
    'chat.deepseek.com': 'deepseek',
    'gemini.google.com': 'gemini'
  };

  for (const [host, key] of Object.entries(expected)) {
    const adapter = contentProviders.adapterForHostname(host);
    assert.equal(adapter.key, key);
    assert.ok(adapter.turnContainerSelectors.length, `${key} should define turn selectors`);
    assert.ok(adapter.contentSelectors.length, `${key} should define content selectors`);
    assert.ok(adapter.containerPreference.length, `${key} should define container preference`);
  }
});

test('content script exports the same extracted DOM utility functions used by the runtime', () => {
  assert.equal(content.providerInfo, contentDom.providerInfo);
  assert.equal(content.findMessageContainer, contentDom.findMessageContainer);
  assert.equal(content.inferSender, contentDom.inferSender);
  assert.equal(content.extractMessageTextFallback, contentDom.extractMessageTextFallback);
  assert.equal(content.isCopyButton, contentDom.isCopyButton);
});

const providerCases = [
  {
    name: 'chatgpt',
    url: 'https://chatgpt.com/c/test',
    providerName: 'ChatGPT',
    providerKey: 'chatgpt',
    expectedUser: /tradeoffs of local-first chat storage/i,
    expectedAssistant: /Local-first storage improves privacy/i,
    expectedAssistantMarkdown: /```js\nconst mode = "local";\n```/
  },
  {
    name: 'claude',
    url: 'https://claude.ai/chat/test',
    providerName: 'Claude',
    providerKey: 'claude',
    expectedUser: /Compare JSON files and SQLite/i,
    expectedAssistant: /## Recommendation\n\nStart with JSON/i,
    expectedAssistantMarkdown: /> SQLite becomes better/i
  },
  {
    name: 'deepseek',
    url: 'https://chat.deepseek.com/a/chat/s/test',
    providerName: 'DeepSeek',
    providerKey: 'deepseek',
    expectedUser: /threat model for a localhost-only chat archive/i,
    expectedAssistant: /main risks are cross-origin localhost access/i,
    expectedAssistantMarkdown: /\| Risk \| Mitigation \|/
  },
  {
    name: 'gemini',
    url: 'https://gemini.google.com/app/test',
    providerName: 'Gemini',
    providerKey: 'gemini',
    expectedUser: /tested before refactoring a content script/i,
    expectedAssistant: /Preserve extraction, sender inference/i,
    expectedAssistantMarkdown: /1\. Create DOM fixtures\.\n2\. Add regression tests\./
  }
];

for (const providerCase of providerCases) {
  test(`${providerCase.providerName} fixture extracts sender roles and message markdown`, () => {
    installDomFixture(providerCase.name, providerCase.url);

    const provider = content.providerInfo();
    assert.equal(provider.name, providerCase.providerName);
    assert.equal(provider.key, providerCase.providerKey);

    const bySender = containersBySender();
    assert.equal(bySender.size, 2);
    assert.ok(bySender.has('me'), 'fixture should expose a user turn');
    assert.ok(bySender.has('bot'), 'fixture should expose an assistant turn');

    const userText = content.extractMessageTextFallback(bySender.get('me').container, 'me');
    const assistantText = content.extractMessageTextFallback(bySender.get('bot').container, 'bot');

    assert.match(userText, providerCase.expectedUser);
    assert.match(assistantText, providerCase.expectedAssistant);
    assert.match(assistantText, providerCase.expectedAssistantMarkdown);
  });

  test(`${providerCase.providerName} fixture injects one Save local button beside each message-level copy control`, () => {
    installDomFixture(providerCase.name, providerCase.url);

    const bySender = containersBySender();
    assert.equal(content.markAssistantContainerReadyForTest(bySender.get('bot').container), true);

    content.injectButtons();

    const saveButtons = Array.from(document.querySelectorAll(`[${content.markers.EXT_MARKER}]`));
    assert.equal(saveButtons.length, 2);

    for (const saveButton of saveButtons) {
      assert.equal(saveButton.textContent, 'Save local');
      assert.equal(saveButton.previousElementSibling, saveButton.__localChatCopyButton);
      assert.ok(saveButton.__localChatContainer);
      assert.equal(content.findMessageContainer(saveButton.__localChatCopyButton), saveButton.__localChatContainer);
      assert.equal(content.saveButtonForCopyButton(saveButton.__localChatCopyButton), saveButton);
    }
  });
}

test('Claude associates the current MessageActions toolbar with the preceding assistant turn', () => {
  installDomFixture('claude', 'https://claude.ai/chat/test');

  const toolbar = document.querySelector('[data-cds="MessageActions"]');
  const copyButton = toolbar.querySelector('button[aria-label="Copy"]');
  const container = content.findMessageContainer(copyButton);

  assert.ok(container, 'expected Claude toolbar Copy button to resolve to an assistant message');
  assert.equal(container.tagName, 'ARTICLE');
  assert.equal(container.getAttribute('aria-label'), 'Assistant response');
  assert.equal(content.inferSender(container), 'bot');
  assert.equal(content.isCopyButton(copyButton), true);

  content.markAssistantContainerReadyForTest(container);
  content.injectButtons();

  const saveButton = copyButton.nextElementSibling;
  assert.ok(saveButton?.hasAttribute(content.markers.EXT_MARKER));
  assert.equal(saveButton.textContent, 'Save local');
  assert.equal(saveButton.__localChatContainer, container);
});

test('ChatGPT fixture rejects nested code-copy controls while accepting message-level copy controls', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  const codeCopy = document.querySelector('[aria-label="Copy code"]');
  const messageCopies = validMessageCopyButtons();

  assert.equal(content.isCopyButton(codeCopy), false);
  assert.equal(messageCopies.length, 2);
  assert.ok(
    messageCopies.every((button) => /copy/i.test(button.textContent || button.getAttribute('aria-label') || ''))
  );
});

test('ChatGPT static Tailwind streaming variants do not keep completed responses marked as streaming', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  const assistantContainer = containersBySender().get('bot').container;
  assert.equal(contentDom.hasStreamingMarker(assistantContainer), false);

  const streamingMarker = document.createElement('span');
  streamingMarker.className = 'result-streaming';
  assistantContainer.append(streamingMarker);

  assert.equal(contentDom.hasStreamingMarker(assistantContainer), true);
});

test('assistant completion signatures do not clone and re-render the whole message tree', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  const assistantContainer = containersBySender().get('bot').container;
  const contentRoot = contentDom.messageExtractionSource(assistantContainer, 'bot');
  contentRoot.cloneNode = () => {
    throw new Error('completion checks should use live text, not clone the rendered message');
  };

  assert.match(contentDom.assistantContentSignature(assistantContainer), /^\d+:[a-z0-9]+$/);
});

test('provider transcript and transient assistant status text are rejected before saving', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  assert.equal(content.isProviderTranscriptText('You said:\nHello\n\nChatGPT said:\nThinking'), true);
  assert.equal(content.shouldSkipExtractedMessageText('Thinking...', 'bot', 'assistant'), true);
  assert.equal(
    content.shouldSkipExtractedMessageText('You said:\nHello\n\nChatGPT said:\nDone', 'me', 'dom-user-message'),
    true
  );
  assert.equal(content.shouldSkipExtractedMessageText('A real answer with enough context.', 'bot', 'assistant'), false);
});
