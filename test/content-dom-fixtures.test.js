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

test('DeepSeek current icon-only action rows expose structural Copy controls and Save local buttons', () => {
  installDomFixture('deepseek-current', 'https://chat.deepseek.com/a/chat/s/test');

  const targets = contentDom.providerActionBarSaveTargets();
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => target.sender),
    ['me', 'bot']
  );

  const [userTarget, assistantTarget] = targets;
  assert.equal(userTarget.copyButton.getAttribute('aria-label'), null);
  assert.equal(assistantTarget.copyButton.getAttribute('aria-label'), null);
  assert.equal(content.isProviderActionBarControl(userTarget.copyButton), true);
  assert.equal(content.isProviderActionBarControl(assistantTarget.copyButton), true);
  assert.equal(content.extractMessageTextFallback(userTarget.container, 'me'), 'Hey there');
  assert.match(content.extractMessageTextFallback(assistantTarget.container, 'bot'), /How can I help you today/i);

  content.injectButtons();

  for (const target of targets) {
    const saveButton = target.copyButton.nextElementSibling;
    assert.ok(saveButton?.hasAttribute(content.markers.EXT_MARKER));
    assert.equal(saveButton.textContent, 'Save local');
    assert.equal(saveButton.dataset.localChatProvider, 'deepseek');
    assert.equal(saveButton.__localChatContainer, target.container);
    assert.equal(content.saveButtonForCopyButton(target.copyButton), saveButton);
  }
});

test('Claude current transcript tree resolves MessageActions toolbars by transcript-row sender', () => {
  installDomFixture('claude', 'https://claude.ai/chat/test');

  const targets = contentDom.providerActionBarSaveTargets();
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => target.sender),
    ['me', 'bot']
  );

  const assistantTarget = targets.find((target) => target.sender === 'bot');
  assert.ok(assistantTarget);
  assert.equal(assistantTarget.container.tagName, 'DIV');
  assert.equal(assistantTarget.container.getAttribute('role'), 'article');
  assert.equal(assistantTarget.container.getAttribute('aria-label'), 'Message 2 of 2');
  assert.equal(content.isCopyButton(assistantTarget.copyButton), true);
  assert.equal(content.isProviderActionBarControl(assistantTarget.copyButton), true);
  assert.match(content.extractMessageTextFallback(assistantTarget.container, 'bot'), /Start with JSON/i);

  content.injectButtons();

  for (const target of targets) {
    const saveButton = target.copyButton.nextElementSibling;
    assert.ok(saveButton?.hasAttribute(content.markers.EXT_MARKER));
    assert.equal(saveButton.textContent, 'Save local');
    assert.equal(saveButton.__localChatContainer, target.container);
  }
});

test('Claude transcript-row streaming metadata participates in completion detection', () => {
  installDomFixture('claude', 'https://claude.ai/chat/test');

  const assistantContainer = containersBySender().get('bot').container;
  const row = assistantContainer.closest('[data-perf-row="assistant"]');
  assert.ok(row);
  assert.equal(contentDom.hasStreamingMarker(assistantContainer), false);

  row.setAttribute('data-perf-row-streaming', 'true');
  assert.equal(contentDom.hasStreamingMarker(assistantContainer), true);
});

test('Claude MessageActions toolbar resolves to the nearest preceding article across unrelated wrappers', () => {
  installDomFixture('claude', 'https://claude.ai/chat/test');

  document.body.innerHTML = `
    <article aria-label="Assistant response">
      <div class="font-claude-response">
        <p>This completed Claude response deliberately uses no configured prose or message-content class.</p>
      </div>
    </article>
    <div data-cds="MessageActions" data-reveal="fade" role="toolbar" aria-label="Message actions" data-size="xs" tabindex="-1">
      <button type="button" data-cds="Button" data-size="xs" aria-label="Copy" tabindex="0"><span aria-hidden="true">Copy</span></button>
      <button type="button" data-cds="Button" data-size="xs" aria-label="Read aloud" tabindex="-1"><span aria-hidden="true">Read aloud</span></button>
      <button type="button" data-cds="Button" data-size="xs" aria-label="Retry" tabindex="-1"><span aria-hidden="true">Retry</span></button>
      <time data-cds="RelativeTime">just now</time>
    </div>
  `;

  const copyButton = document.querySelector('button[aria-label="Copy"]');
  const container = content.findMessageContainer(copyButton);

  assert.ok(container, 'expected the external Claude toolbar to resolve to the preceding response article');
  assert.equal(container.tagName, 'ARTICLE');
  assert.match(content.extractMessageTextFallback(container, 'bot'), /completed Claude response/i);
  assert.equal(content.isCopyButton(copyButton), true);

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

test('ChatGPT completion detection requires the message-level Copy control, not nested code copy', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  const assistantContainer = containersBySender().get('bot').container;
  assert.equal(contentDom.hasMessageCompletionCopyControl(assistantContainer), true);

  document.querySelector('[data-testid="copy-turn-action-button"]').remove();
  assert.equal(contentDom.hasMessageCompletionCopyControl(assistantContainer), false);
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
  assert.equal(contentDom.isTransientAssistantStatusText('ChatGPT said: Thinking'), true);
  assert.equal(contentDom.isTransientAssistantStatusText('ChatGPT said:\nThinking'), true);
  assert.equal(contentDom.cleanExtractedMessageText('ChatGPT said:\nThinking', 'bot'), '');
  assert.equal(
    contentDom.cleanExtractedMessageText('ChatGPT said:\nFinished assistant response.', 'bot'),
    'Finished assistant response.'
  );
  assert.equal(content.shouldSkipExtractedMessageText('Thinking...', 'bot', 'assistant'), true);
  assert.equal(
    content.shouldSkipExtractedMessageText('You said:\nHello\n\nChatGPT said:\nDone', 'me', 'dom-user-message'),
    true
  );
  assert.equal(content.shouldSkipExtractedMessageText('A real answer with enough context.', 'bot', 'assistant'), false);
});

test('ChatGPT current response-actions layout maps Copy response to its assistant turn', () => {
  installDomFixture('chatgpt-current', 'https://chatgpt.com/c/test');

  const copyButton = document.querySelector('[data-testid="copy-turn-action-button"]');
  assert.ok(copyButton);
  assert.equal(content.isCopyButton(copyButton), true);

  const container = content.findMessageContainer(copyButton);
  assert.ok(container);
  assert.equal(container.hasAttribute('data-conversation-screenshot-content'), true);
  assert.equal(content.inferSender(container), 'bot');
  assert.match(content.extractMessageTextFallback(container, 'bot'), /Current ChatGPT response/i);

  assert.equal(content.markAssistantContainerReadyForTest(container), true);
  content.injectButtons();

  const saveButton = document.querySelector(`[${content.markers.EXT_MARKER}]`);
  assert.ok(saveButton, 'expected Save local beside ChatGPT response actions');
  assert.equal(saveButton.previousElementSibling, copyButton);
});

test('ChatGPT September 2026 search-unit DOM resolves assistant action row and injects Save local', () => {
  installDomFixture('chatgpt-sep-2026', 'https://chatgpt.com/c/test');

  const targets = contentDom.providerActionBarSaveTargets();
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => target.sender),
    ['me', 'bot']
  );

  const assistantTarget = targets.find((target) => target.sender === 'bot');
  assert.ok(assistantTarget);
  assert.match(
    assistantTarget.container.getAttribute('data-content-search-unit-key') || '',
    /:assistant$/
  );
  assert.equal(assistantTarget.copyButton.getAttribute('aria-label'), 'Copy');
  assert.equal(content.isProviderActionBarControl(assistantTarget.copyButton), true);
  assert.equal(
    content.extractMessageTextFallback(assistantTarget.container, 'bot'),
    'Hi! 😊 How can I help you today?'
  );

  content.injectButtons();

  const saveButton = content.saveButtonForCopyButton(assistantTarget.copyButton);
  assert.ok(saveButton?.hasAttribute(content.markers.EXT_MARKER));
  assert.equal(saveButton.textContent, 'Save local');
  assert.equal(saveButton.dataset.localChatProvider, 'chatgpt');
  assert.equal(saveButton.__localChatContainer, assistantTarget.container);
  assert.equal(content.inferSender(saveButton.__localChatContainer), 'bot');
  assert.equal(saveButton.previousElementSibling, assistantTarget.copyButton.parentElement);
});

test('ChatGPT September 2026 multi-turn DOM keeps action bars associated with their own turns', () => {
  installDomFixture('chatgpt-sep-2026-full', 'https://chatgpt.com/c/test');

  const targets = contentDom.providerActionBarSaveTargets();
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((target) => target.sender),
    ['me', 'bot', 'me', 'bot']
  );
  assert.deepEqual(
    targets.map((target) => target.container.getAttribute('data-content-search-unit-key')),
    [
      'fallback-turn-0:0:user',
      'fallback-turn-0:2:assistant',
      'fallback-turn-1:0:user',
      'fallback-turn-1:1:assistant'
    ]
  );

  const assistantTargets = targets.filter((target) => target.sender === 'bot');
  assert.equal(assistantTargets.length, 2);
  assert.deepEqual(
    assistantTargets.map((target) => content.extractMessageTextFallback(target.container, 'bot')),
    [
      'Hi! 😊 How can I help you today?',
      'I’m doing well too, thanks 😊 What are we working on today?'
    ]
  );

  content.injectButtons();

  for (const target of targets) {
    const saveButton = content.saveButtonForCopyButton(target.copyButton);
    assert.ok(saveButton?.hasAttribute(content.markers.EXT_MARKER));
    assert.equal(saveButton.textContent, 'Save local');
    assert.equal(saveButton.__localChatContainer, target.container);
    assert.equal(content.inferSender(saveButton.__localChatContainer), target.sender);
  }
});
