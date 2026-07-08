const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const autosave = require('../browser-extension/content-autosave');
const contentDom = require('../browser-extension/content-dom');

function installDom() {
  const dom = new JSDOM(
    '<!doctype html><html><body><article id="msg">Assistant answer</article><button id="save">Save local</button></body></html>'
  );
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  return dom;
}

test.afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.Element;
  delete global.HTMLElement;
});

test('content autosave builds stable sanitized idempotency keys', () => {
  const controller = autosave.createAutosaveController({
    normalizeText: contentDom.normalizeText,
    hashText: contentDom.hashText,
    providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' })
  });

  const keyA = controller.buildSaveIdempotencyKey('auto-submit', 'chatgpt', 'me', '  Hello world  ', 'chat_1');
  const keyB = controller.buildSaveIdempotencyKey('auto-submit', 'chatgpt', 'me', 'Hello world', 'chat_1');

  assert.equal(keyA, keyB);
  assert.match(keyA, /^lc-auto-submit-chatgpt-me-chat_1-11-/);
  assert.doesNotMatch(keyA, /\s/);
});

test('content autosave saveContainer uses the armed target and auto-save idempotency key', async () => {
  installDom();
  const payloads = [];
  const container = document.querySelector('#msg');
  const button = document.querySelector('#save');

  const controller = autosave.createAutosaveController({
    normalizeText: contentDom.normalizeText,
    hashText: contentDom.hashText,
    providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
    currentLocalChatTarget: () => ({ sessionId: 'chat_active', sessionTitle: 'Active' }),
    inferSender: () => 'bot',
    extractMessageText: async () => 'Assistant answer',
    cleanExtractedMessageText: contentDom.cleanExtractedMessageText,
    shouldSkipExtractedMessageText: () => false,
    sendLocalChatMessage: async (payload) => {
      payloads.push(payload);
      return { sessionTitle: payload.sessionTitle || 'Target' };
    },
    showToast: () => {}
  });

  controller.armAssistantAutoSave('What is local-first?', {
    sessionId: 'chat_1700000000000_target',
    sessionTitle: 'Pinned target'
  });

  const result = await controller.saveContainer(container, button, null, { auto: true });

  assert.equal(result.ok, true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].sessionId, 'chat_1700000000000_target');
  assert.equal(payloads[0].sessionTitle, 'Pinned target');
  assert.equal(payloads[0].source, 'auto-assistant-complete');
  assert.equal(payloads[0].sender, 'bot');
  assert.match(payloads[0].idempotencyKey, /^lc-auto-assistant-complete-chatgpt-bot-chat_1700000000000_target-/);
});

test('content autosave queues outgoing prompts once within the dedupe window', async () => {
  const payloads = [];
  const controller = autosave.createAutosaveController(
    {
      normalizeText: contentDom.normalizeText,
      hashText: contentDom.hashText,
      providerInfo: () => ({ name: 'Claude', key: 'claude' }),
      currentLocalChatTarget: () => ({ sessionId: 'chat_target', sessionTitle: 'Target' }),
      isAutoSendEnabled: () => true,
      sendLocalChatMessage: async (payload) => {
        payloads.push(payload);
        return { sessionTitle: 'Target' };
      },
      showToast: () => {},
      removeEmptyChatOnlyButtons: () => {}
    },
    {
      outgoingAutoSaveDelayMs: 1,
      outgoingAutoSaveDedupMs: 50
    }
  );

  controller.queueOutgoingPromptSave('  Save this prompt  ', 'enter');
  controller.queueOutgoingPromptSave('Save this prompt', 'send-button');

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].sender, 'me');
  assert.equal(payloads[0].text, 'Save this prompt');
  assert.equal(payloads[0].source, 'auto-submit');
  assert.equal(payloads[0].sessionId, 'chat_target');
  assert.match(payloads[0].idempotencyKey, /^lc-auto-submit-claude-me-chat_target-/);
});
