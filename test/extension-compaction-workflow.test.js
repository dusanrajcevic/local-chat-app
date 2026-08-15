const test = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../browser-extension/content-compaction');
const { createCompactionWorkflow } = require('../browser-extension/content-compaction-workflow');
const { createAutosaveController } = require('../browser-extension/content-autosave');

function responseText(requestId, compactedMessage = 'Compact continuation context.') {
  return [
    protocol.RESPONSE_START,
    JSON.stringify({
      protocol: protocol.COMPACTION_PROTOCOL,
      version: protocol.COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage
    }),
    protocol.RESPONSE_END
  ].join('\n');
}

function fakeContainer(sender, text) {
  const attributes = new Map();
  const classes = new Set();
  return {
    sender,
    text,
    attributes,
    classes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    classList: {
      add(value) {
        classes.add(value);
      }
    }
  };
}

function createHarness(options = {}) {
  const requestId = options.requestId || 'compact:req:workflow-001';
  const workflowProtocol = {
    ...protocol,
    createCompactionRequestId: () => requestId
  };
  const stateChanges = [];
  const runtimeMessages = [];
  const toasts = [];
  const requestContainer = fakeContainer('me', '');
  const responseContainer = fakeContainer('bot', '');
  const containers = [];
  let target = { sessionId: 'chat_1700000000000_11111111', sessionTitle: 'Source chat' };
  let pageIdentity = 'https://chatgpt.com/c/source';
  let composerText = '';
  let sent = false;
  let activeSessionUpdate = null;
  let refreshCount = 0;

  const workflow = createCompactionWorkflow(
    {
      protocol: workflowProtocol,
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      currentLocalChatTarget: () => target,
      currentPageIdentity: () => pageIdentity,
      replaceComposerWithText: async (text) => {
        composerText = text;
      },
      findComposerContainer: () => ({ id: 'composer' }),
      findSendButtonNear: () => ({
        click() {
          sent = true;
          requestContainer.text = composerText;
          containers.push(requestContainer);
          if (options.response !== false) {
            responseContainer.text = options.responseText || responseText(requestId);
            containers.push(responseContainer);
          }
          options.afterSend?.({
            setPageIdentity(value) {
              pageIdentity = value;
            },
            setTarget(value) {
              target = value;
            }
          });
        }
      }),
      isDisabledControl: () => false,
      visibleMessageContainers: () => containers.filter((container) => !container.classes.has('hidden-for-test')),
      inferSender: (container) => container.sender,
      extractMessageTextFallback: (container) => container.text,
      hasStreamingMarker: () => false,
      sendRuntimeMessage: async (message) => {
        runtimeMessages.push(message);
        if (message.type === 'UPSERT_LOCAL_CHAT_COMPACTION') {
          options.afterPersist?.({
            setPageIdentity(value) {
              pageIdentity = value;
            },
            setTarget(value) {
              target = value;
            }
          });
          return {
            ok: true,
            sessionId: 'chat_1700000000000_22222222',
            sessionTitle: 'Source chat (compacted)',
            session: {
              id: 'chat_1700000000000_22222222',
              title: 'Source chat (compacted)',
              kind: 'compacted',
              parentSessionId: target.sessionId
            }
          };
        }
        if (message.type === 'SET_ACTIVE_LOCAL_CHAT_SESSION') {
          return {
            ok: true,
            sessionId: message.payload.sessionId,
            sessionTitle: 'Source chat (compacted)'
          };
        }
        throw new Error(`Unexpected runtime message: ${message.type}`);
      },
      setActiveSession: (value) => {
        activeSessionUpdate = value;
        target = { sessionId: value.sessionId, sessionTitle: value.session?.title || 'Compacted chat' };
      },
      refreshSidebar: () => {
        refreshCount += 1;
      },
      showToast: (message, isError) => toasts.push({ message, isError: Boolean(isError) }),
      sleep: async () => {},
      onStateChange: (value) => stateChanges.push(value.phase)
    },
    {
      sendButtonTimeoutMs: 50,
      responseTimeoutMs: 50,
      responsePollMs: 0,
      responseStableMs: 0
    }
  );

  return {
    workflow,
    requestId,
    requestContainer,
    responseContainer,
    runtimeMessages,
    stateChanges,
    toasts,
    get composerText() {
      return composerText;
    },
    get sent() {
      return sent;
    },
    get activeSessionUpdate() {
      return activeSessionUpdate;
    },
    get refreshCount() {
      return refreshCount;
    }
  };
}

test('Compact workflow sends the protocol prompt, persists the response, and activates the compacted child', async () => {
  const harness = createHarness();
  const result = await harness.workflow.startCompaction();

  assert.equal(harness.sent, true);
  assert.equal(protocol.isCompactionRequestText(harness.composerText), true);
  assert.match(harness.composerText, new RegExp(harness.requestId.replaceAll(':', '\\:')));
  assert.deepEqual(
    harness.runtimeMessages.map((message) => message.type),
    ['UPSERT_LOCAL_CHAT_COMPACTION', 'SET_ACTIVE_LOCAL_CHAT_SESSION']
  );
  assert.deepEqual(harness.runtimeMessages[0].payload, {
    sessionId: 'chat_1700000000000_11111111',
    requestId: harness.requestId,
    compactedMessage: 'Compact continuation context.',
    providerKey: 'chatgpt'
  });
  assert.equal(harness.runtimeMessages[1].payload.sessionId, 'chat_1700000000000_22222222');
  assert.equal(result.sessionId, 'chat_1700000000000_22222222');
  assert.equal(harness.activeSessionUpdate.sessionId, result.sessionId);
  assert.equal(harness.refreshCount, 1);
  assert.deepEqual(harness.stateChanges, [
    'sending-request',
    'waiting-response',
    'persisting',
    'activating',
    'complete'
  ]);
  assert.equal(harness.requestContainer.attributes.get('data-local-chat-compaction-turn'), 'request');
  assert.equal(harness.responseContainer.attributes.get('data-local-chat-compaction-turn'), 'response');
  assert.equal(harness.toasts.at(-1).isError, false);
});

test('Compact workflow rejects malformed matching provider responses without persisting them', async () => {
  const requestId = 'compact:req:workflow-bad';
  const harness = createHarness({
    requestId,
    responseText: [protocol.RESPONSE_START, '{bad json', protocol.RESPONSE_END].join('\n') + `\n${requestId}`
  });

  await assert.rejects(() => harness.workflow.startCompaction(), /text outside|invalid json/i);
  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(harness.workflow.getState().phase, 'error');
  assert.equal(harness.toasts.at(-1).isError, true);
});

test('Compact workflow stops if the provider conversation changes while waiting', async () => {
  const harness = createHarness({
    response: false,
    afterSend({ setPageIdentity }) {
      setPageIdentity('https://chatgpt.com/c/another-chat');
    }
  });

  await assert.rejects(() => harness.workflow.startCompaction(), /provider conversation changed/i);
  assert.equal(harness.runtimeMessages.length, 0);
});

test('Compact workflow does not steal activation if the user switches local sessions during persistence', async () => {
  const harness = createHarness({
    afterPersist({ setTarget }) {
      setTarget({ sessionId: 'chat_1700000000000_99999999', sessionTitle: 'Another local chat' });
    }
  });

  await assert.rejects(() => harness.workflow.startCompaction(), /active Local Chat session changed/i);
  assert.deepEqual(
    harness.runtimeMessages.map((message) => message.type),
    ['UPSERT_LOCAL_CHAT_COMPACTION']
  );
});

test('Compact workflow refuses a second concurrent compaction request', async () => {
  let releaseComposer;
  const composerGate = new Promise((resolve) => {
    releaseComposer = resolve;
  });
  const harness = createHarness();
  const original = harness.workflow;
  const protocolWithId = { ...protocol, createCompactionRequestId: () => 'compact:req:concurrent-001' };
  const workflow = createCompactionWorkflow(
    {
      protocol: protocolWithId,
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      currentLocalChatTarget: () => ({ sessionId: 'chat_1700000000000_11111111', sessionTitle: 'Source' }),
      currentPageIdentity: () => 'https://chatgpt.com/c/source',
      replaceComposerWithText: async () => composerGate,
      findComposerContainer: () => null,
      visibleMessageContainers: () => [],
      sendRuntimeMessage: async () => ({ ok: true }),
      showToast: () => {},
      sleep: async () => {}
    },
    { sendButtonTimeoutMs: 1, responseTimeoutMs: 1, responsePollMs: 0, responseStableMs: 0 }
  );

  const first = workflow.startCompaction();
  await assert.rejects(() => workflow.startCompaction(), /already in progress/i);
  releaseComposer();
  await assert.rejects(first, /send button/i);
  assert.equal(workflow.isRunning(), false);
  assert.equal(original.isRunning(), false);
});

test('autosave skips structured compaction request and response turns', async () => {
  let sendCount = 0;
  const requestId = 'compact:req:autosave-001';
  const requestText = protocol.buildCompactionPrompt({ requestId });
  const response = responseText(requestId);
  const button = { textContent: 'Save local', disabled: false, dataset: {} };
  let extracted = requestText;

  const controller = createAutosaveController({
    normalizeText: (value) => String(value || '').trim(),
    providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
    inferSender: () => 'me',
    extractMessageText: async () => extracted,
    cleanExtractedMessageText: (value) => String(value || '').trim(),
    isCompactionProtocolText: (text) =>
      protocol.isCompactionRequestText(text) || protocol.isCompactionResponseText(text),
    sendLocalChatMessage: async () => {
      sendCount += 1;
      return { sessionTitle: 'Should not happen' };
    }
  });

  const requestResult = await controller.saveContainer({}, button);
  assert.equal(requestResult.reason, 'compaction-protocol');
  assert.equal(sendCount, 0);

  extracted = response;
  const responseResult = await controller.saveContainer({}, button);
  assert.equal(responseResult.reason, 'compaction-protocol');
  assert.equal(sendCount, 0);
});

test('extension wiring exposes Compact and hides protocol turns from extension capture UI', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts[0].js;
  const workflowIndex = scripts.indexOf('content-compaction-workflow.js');
  const bootstrapIndex = scripts.indexOf('content.js');

  assert.ok(workflowIndex >= 0);
  assert.ok(workflowIndex < bootstrapIndex);

  const sidebar = fs.readFileSync(path.join(root, 'browser-extension/content-sidebar.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, 'browser-extension/content-runtime.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'browser-extension/content.css'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(root, 'browser-extension/content.js'), 'utf8');

  assert.match(sidebar, /data-local-sidebar-compact/);
  assert.match(runtime, /shouldHideMessageSaveTarget/);
  assert.match(css, /data-local-chat-compaction-turn/);
  assert.match(css, /display:\s*none\s*!important/);
  assert.match(bootstrap, /isCompactionProtocolText/);
  assert.match(bootstrap, /UPSERT_LOCAL_CHAT_COMPACTION|createCompactionWorkflow/);
});

test('outgoing autosave queue ignores a compaction protocol prompt before arming assistant capture', async () => {
  let sendCount = 0;
  let removedEmptyButtons = 0;
  const requestText = protocol.buildCompactionPrompt({ requestId: 'compact:req:queue-001' });
  const controller = createAutosaveController(
    {
      normalizeText: (value) => String(value || '').trim(),
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      currentLocalChatTarget: () => ({ sessionId: 'chat_1700000000000_11111111' }),
      isAutoSendEnabled: () => true,
      isCompactionProtocolText: (text) =>
        protocol.isCompactionRequestText(text) || protocol.isCompactionResponseText(text),
      sendLocalChatMessage: async () => {
        sendCount += 1;
        return { ok: true };
      },
      removeEmptyChatOnlyButtons: () => {
        removedEmptyButtons += 1;
      }
    },
    { outgoingAutoSaveDelayMs: 0 }
  );

  controller.queueOutgoingPromptSave(requestText, 'send-button');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sendCount, 0);
  assert.equal(removedEmptyButtons, 1);
});

test('Compact workflow can be cancelled before persistence and reports a terminal cancelled state', async () => {
  let releaseComposer;
  const composerGate = new Promise((resolve) => {
    releaseComposer = resolve;
  });
  const stateChanges = [];
  const toasts = [];
  const workflow = createCompactionWorkflow(
    {
      protocol: { ...protocol, createCompactionRequestId: () => 'compact:req:cancel-001' },
      providerInfo: () => ({ name: 'ChatGPT', key: 'chatgpt' }),
      currentLocalChatTarget: () => ({ sessionId: 'chat_1700000000000_11111111', sessionTitle: 'Source' }),
      currentPageIdentity: () => 'https://chatgpt.com/c/source',
      replaceComposerWithText: async () => composerGate,
      findComposerContainer: () => ({ id: 'composer' }),
      findSendButtonNear: () => ({ click() {} }),
      visibleMessageContainers: () => [],
      sendRuntimeMessage: async () => {
        throw new Error('persistence should not run after cancellation');
      },
      showToast: (message, isError) => toasts.push({ message, isError: Boolean(isError) }),
      sleep: async () => {},
      onStateChange: (value) => stateChanges.push(value.phase)
    },
    { sendButtonTimeoutMs: 50, responseTimeoutMs: 50, responsePollMs: 0, responseStableMs: 0 }
  );

  const pending = workflow.startCompaction();
  assert.equal(workflow.getState().phase, 'sending-request');
  assert.equal(workflow.getState().cancellable, true);
  assert.equal(workflow.cancelCompaction(), true);
  assert.equal(workflow.getState().phase, 'cancelling');
  assert.equal(workflow.cancelCompaction(), false);

  releaseComposer();
  const result = await pending;

  assert.deepEqual(result, {
    ok: false,
    cancelled: true,
    requestId: 'compact:req:cancel-001',
    sessionId: 'chat_1700000000000_11111111'
  });
  assert.equal(workflow.getState().phase, 'cancelled');
  assert.equal(workflow.getState().running, false);
  assert.equal(workflow.getState().cancellable, false);
  assert.deepEqual(stateChanges, ['sending-request', 'cancelling', 'cancelled']);
  assert.deepEqual(toasts, [{ message: 'Compaction cancelled.', isError: false }]);
});

test('Compact workflow status can be cleared only after the workflow is terminal', async () => {
  const harness = createHarness();
  const result = await harness.workflow.startCompaction();
  assert.equal(result.ok, true);
  assert.equal(harness.workflow.getState().phase, 'complete');
  assert.equal(harness.workflow.clearStatus(), true);
  assert.deepEqual(harness.workflow.getState(), {
    phase: 'idle',
    requestId: '',
    sessionId: '',
    error: '',
    running: false,
    cancellable: false
  });
});
