const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const content = require('../browser-extension/content');
const diagnostics = require('../browser-extension/content-diagnostics');

const fixtureDir = path.join(__dirname, 'fixtures', 'provider-dom');

const providerCases = [
  { name: 'chatgpt', url: 'https://chatgpt.com/c/test', key: 'chatgpt', privateText: 'local-first chat storage' },
  { name: 'claude', url: 'https://claude.ai/chat/test', key: 'claude', privateText: 'Compare JSON files and SQLite' },
  {
    name: 'deepseek',
    url: 'https://chat.deepseek.com/a/chat/s/test',
    key: 'deepseek',
    privateText: 'localhost-only chat archive'
  },
  { name: 'gemini', url: 'https://gemini.google.com/app/test', key: 'gemini', privateText: 'content script' }
];

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

  content.resetContentScriptStateForTest();
  content.setContentScriptStateForTest({
    localChatAppAvailable: true,
    localChatAppAvailabilityLoaded: true,
    localChatAutoSendEnabled: false,
    autoSendPreferenceLoaded: true
  });
  return dom;
}

function wrapElement(element, marker) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-provider-fixture-wrapper', marker);
  element.replaceWith(wrapper);
  wrapper.appendChild(element);
}

function mutateProviderFixture(name) {
  document.querySelectorAll('main > *').forEach((turn, index) => wrapElement(turn, `turn-${index}`));

  document
    .querySelectorAll('.markdown, .prose, [data-testid="message-content"]')
    .forEach((contentRoot, index) => wrapElement(contentRoot, `content-${index}`));

  document.querySelectorAll('footer, .actions, [data-testid="turn-actions"]').forEach((actions, index) => {
    wrapElement(actions, `actions-${index}`);
  });

  if (name === 'gemini') {
    const articles = Array.from(document.querySelectorAll('article'));
    articles[0]?.setAttribute('aria-label', 'User query');
    articles[1]?.setAttribute('aria-label', 'Assistant response');
  }

  document.querySelectorAll('[data-testid]').forEach((element) => {
    element.setAttribute('data-provider-fixture-testid', element.getAttribute('data-testid'));
    element.removeAttribute('data-testid');
  });

  document.querySelectorAll('[class]').forEach((element) => {
    if (element.closest('pre, code, table')) return;
    element.setAttribute('data-provider-fixture-class', element.getAttribute('class'));
    element.setAttribute('class', 'provider-layout-v2');
  });

  document.querySelectorAll('button[aria-label*="Copy" i], [role="button"][aria-label*="Copy" i]').forEach((button) => {
    if (button.closest('pre, code, table')) return;
    wrapElement(button, 'copy-control');
  });
}

function validMessageCopyButtons() {
  return Array.from(document.querySelectorAll('button, [role="button"]')).filter((button) =>
    content.isCopyButton(button)
  );
}

function extractedMessages() {
  return validMessageCopyButtons().map((button) => {
    const container = content.findMessageContainer(button);
    assert.ok(container, `expected a message container for ${button.outerHTML}`);
    const sender = content.inferSender(container);
    return {
      sender,
      text: content.extractMessageTextFallback(container, sender)
    };
  });
}

test.afterEach(() => {
  content.resetContentScriptStateForTest();
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
  delete global.location;
});

for (const providerCase of providerCases) {
  test(`${providerCase.name} diagnostics report healthy extraction without exposing message text`, () => {
    installDomFixture(providerCase.name, providerCase.url);

    const report = diagnostics.collectProviderDiagnostics();
    assert.equal(report.provider.key, providerCase.key);
    assert.equal(report.provider.supported, true);
    assert.equal(report.status, 'pass');
    assert.equal(report.summary.messageContainers, 2);
    assert.equal(report.summary.extractableMessages, 2);
    assert.equal(report.summary.userMessages, 1);
    assert.equal(report.summary.assistantMessages, 1);
    assert.equal(report.messages.length, 2);
    assert.ok(report.messages.every((message) => message.textLength > 0));
    assert.equal(JSON.stringify(report).includes(providerCase.privateText), false);
  });

  test(`${providerCase.name} extraction survives neutral wrappers and renamed presentation attributes`, () => {
    installDomFixture(providerCase.name, providerCase.url);
    mutateProviderFixture(providerCase.name);

    const messages = extractedMessages();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((message) => message.sender).sort(), ['bot', 'me']);
    assert.ok(messages.every((message) => message.text.length > 20));

    const assistant = validMessageCopyButtons()
      .map((button) => content.findMessageContainer(button))
      .find((container) => content.inferSender(container) === 'bot');
    assert.equal(content.markAssistantContainerReadyForTest(assistant), true);
    content.injectButtons();
    assert.equal(document.querySelectorAll('[data-local-chat-save-button]').length, 2);

    const report = diagnostics.collectProviderDiagnostics();
    assert.equal(report.provider.key, providerCase.key);
    assert.equal(report.summary.messageContainers, 2);
    assert.equal(report.summary.extractableMessages, 2);
    assert.equal(report.summary.userMessages, 1);
    assert.equal(report.summary.assistantMessages, 1);
    assert.ok(['pass', 'warning'].includes(report.status));
  });
}

test('diagnostics report unsupported pages without including page text', () => {
  const dom = new JSDOM('<main><p>Private page content must not be returned.</p></main>', {
    url: 'https://example.com/private',
    pretendToBeVisual: true
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.location = dom.window.location;

  const report = diagnostics.collectProviderDiagnostics();
  assert.equal(report.provider.supported, false);
  assert.equal(report.status, 'unsupported');
  assert.match(report.warnings[0], /supported provider/i);
  assert.equal(JSON.stringify(report).includes('Private page content'), false);
});

test('diagnostics message handler ignores unrelated messages and returns a serializable report', () => {
  installDomFixture('chatgpt', 'https://chatgpt.com/c/test');

  assert.equal(
    diagnostics.handleDiagnosticsMessage({ type: 'OTHER' }, {}, () => {}),
    false
  );

  let response;
  const handled = diagnostics.handleDiagnosticsMessage({ type: 'GET_PROVIDER_DIAGNOSTICS' }, {}, (value) => {
    response = value;
  });

  assert.equal(handled, false);
  assert.equal(response.ok, true);
  assert.equal(response.diagnostics.provider.key, 'chatgpt');
  assert.doesNotThrow(() => JSON.stringify(response));
});
