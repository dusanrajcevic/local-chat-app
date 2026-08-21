(function exposeLocalChatContentCompactionWorkflow(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentCompactionWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentCompactionWorkflow() {
  'use strict';

  const RUNNING_PHASES = new Set(['sending-request', 'waiting-response', 'cancelling', 'persisting', 'activating']);

  const CANCELLABLE_PHASES = new Set(['sending-request', 'waiting-response']);

  const DEFAULTS = Object.freeze({
    sendButtonTimeoutMs: 5000,
    responseTimeoutMs: 2 * 60 * 1000,
    responsePollMs: 250,
    responseStableMs: 600
  });

  function createNoopDependency(name) {
    return function missingDependency() {
      throw new Error(`LocalChatContentCompactionWorkflow dependency is missing: ${name}`);
    };
  }

  function createCompactionWorkflow(deps = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const protocol = deps.protocol || createNoopDependency('protocol')();
    const providerInfo = deps.providerInfo || (() => ({ name: 'AI Chat', key: 'provider' }));
    const currentLocalChatTarget = deps.currentLocalChatTarget || (() => null);
    const currentPageIdentity = deps.currentPageIdentity || (() => String(globalThis.location?.href || ''));
    const replaceComposerWithText = deps.replaceComposerWithText || createNoopDependency('replaceComposerWithText');
    const findComposerContainer = deps.findComposerContainer || (() => null);
    const findSendButtonNear = deps.findSendButtonNear || (() => null);
    const isDisabledControl = deps.isDisabledControl || (() => false);
    const visibleMessageContainers = deps.visibleMessageContainers || (() => []);
    const inferSender = deps.inferSender || (() => 'bot');
    const extractMessageTextFallback = deps.extractMessageTextFallback || (() => '');
    const hasStreamingMarker = deps.hasStreamingMarker || (() => false);
    const sendRuntimeMessage = deps.sendRuntimeMessage || createNoopDependency('sendRuntimeMessage');
    const setActiveSession = deps.setActiveSession || (() => {});
    const refreshSidebar = deps.refreshSidebar || (() => {});
    const showToast = deps.showToast || (() => {});
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const onStateChange = deps.onStateChange || (() => {});

    let state = { phase: 'idle', requestId: '', sessionId: '', error: '' };
    let activePromise = null;
    let activeRun = null;

    function setState(phase, details = {}) {
      state = {
        phase,
        requestId: details.requestId ?? state.requestId ?? '',
        sessionId: details.sessionId ?? state.sessionId ?? '',
        error: details.error || ''
      };
      onStateChange({ ...state });
      return state;
    }

    function getState() {
      return {
        ...state,
        running: RUNNING_PHASES.has(state.phase),
        cancellable: CANCELLABLE_PHASES.has(state.phase)
      };
    }

    function isRunning() {
      return Boolean(activePromise) || RUNNING_PHASES.has(state.phase);
    }

    function cancellationError() {
      const error = new Error('Compaction was cancelled.');
      error.name = 'CompactionCancelledError';
      return error;
    }

    function assertNotCancelled(run) {
      if (run?.cancelled) throw cancellationError();
    }

    function isCancellationError(error) {
      return error?.name === 'CompactionCancelledError';
    }

    function protocolTurnKind(text) {
      if (protocol.isCompactionRequestText(text)) return 'request';
      if (protocol.isCompactionResponseText(text)) return 'response';
      return null;
    }

    function markProtocolTurn(container, kind) {
      if (!container?.setAttribute) return false;
      container.setAttribute('data-local-chat-compaction-turn', kind || 'protocol');
      container.classList?.add?.('local-chat-compaction-protocol-turn');
      return true;
    }

    function matchingRequestIndex(containers, requestId) {
      for (let index = containers.length - 1; index >= 0; index -= 1) {
        const container = containers[index];
        if (inferSender(container) !== 'me') continue;
        const text = String(extractMessageTextFallback(container, 'me') || '');
        if (protocol.isCompactionRequestText(text) && text.includes(requestId)) return index;
      }
      return -1;
    }

    function hideMatchingRequestTurn(requestId) {
      const containers = visibleMessageContainers();
      const index = matchingRequestIndex(containers, requestId);
      if (index < 0) return null;
      const container = containers[index];
      markProtocolTurn(container, 'request');
      return container;
    }

    function responseCandidate(expected) {
      const requestId = typeof expected === 'string' ? expected : expected?.requestId;
      if (!requestId) return null;

      const containers = visibleMessageContainers();
      const requestIndex = matchingRequestIndex(containers, requestId);

      // Once the exact request turn is visible, the first assistant turn after it
      // is the response owned by this workflow. This is more reliable than
      // searching for response text because providers may ignore our envelope.
      if (requestIndex >= 0) {
        for (let index = requestIndex + 1; index < containers.length; index += 1) {
          const container = containers[index];
          if (inferSender(container) !== 'bot') continue;
          return {
            container,
            text: String(extractMessageTextFallback(container, 'bot') || ''),
            association: 'after-request'
          };
        }
      }

      // A correctly structured response can still be matched safely when a
      // virtualized provider has already removed the request turn from the DOM.
      for (let index = containers.length - 1; index >= 0; index -= 1) {
        const container = containers[index];
        if (inferSender(container) !== 'bot') continue;
        const text = String(extractMessageTextFallback(container, 'bot') || '');
        if (!protocol.isCompactionResponseText(text) || !text.includes(requestId)) continue;
        return { container, text, association: 'structured-request-id' };
      }

      // During the small window before the user request turn is rendered, only
      // consider assistant containers that did not exist before we clicked Send.
      const before = expected?.assistantContainersBeforeRequest;
      if (before instanceof Set) {
        for (const container of containers) {
          if (inferSender(container) !== 'bot' || before.has(container)) continue;
          return {
            container,
            text: String(extractMessageTextFallback(container, 'bot') || ''),
            association: 'new-assistant-container'
          };
        }
      }

      return null;
    }

    function hasGeneratingAssistant() {
      return visibleMessageContainers().some(
        (container) => inferSender(container) === 'bot' && Boolean(hasStreamingMarker(container))
      );
    }

    async function waitForSendButton(run) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < config.sendButtonTimeoutMs) {
        assertNotCancelled(run);
        const composer = findComposerContainer();
        const button = composer ? findSendButtonNear(composer) : null;
        if (button && !isDisabledControl(button)) return button;
        await sleep(100);
      }
      throw new Error('Could not find an enabled provider send button for compaction.');
    }

    function assertConversationUnchanged(expected) {
      const target = currentLocalChatTarget();
      if (!target?.sessionId || target.sessionId !== expected.sessionId) {
        throw new Error('The active Local Chat session changed while compaction was running.');
      }
      if (providerInfo().key !== expected.providerKey || currentPageIdentity() !== expected.pageIdentity) {
        throw new Error('The provider conversation changed while compaction was running.');
      }
    }

    async function waitForResponse(expected, run) {
      const startedAt = Date.now();
      let lastText = '';
      let stableSince = 0;
      let activeCandidate = null;

      while (Date.now() - startedAt < config.responseTimeoutMs) {
        assertNotCancelled(run);
        assertConversationUnchanged(expected);
        hideMatchingRequestTurn(expected.requestId);

        const discoveredCandidate = responseCandidate(expected);
        if (discoveredCandidate) activeCandidate = discoveredCandidate;
        if (activeCandidate?.container && activeCandidate.container.isConnected === false) activeCandidate = null;

        const candidate = activeCandidate
          ? {
              ...activeCandidate,
              text: String(extractMessageTextFallback(activeCandidate.container, 'bot') || '')
            }
          : null;

        if (!candidate) {
          lastText = '';
          stableSince = 0;
          await sleep(config.responsePollMs);
          continue;
        }

        // Hide the provider-owned implementation response as soon as it is
        // associated with this exact request, including plain-text fallbacks.
        markProtocolTurn(candidate.container, 'response');

        if (!candidate.text.trim()) {
          lastText = '';
          stableSince = 0;
          await sleep(config.responsePollMs);
          continue;
        }

        if (candidate.text !== lastText) {
          lastText = candidate.text;
          stableSince = Date.now();
        }

        const streaming = Boolean(hasStreamingMarker(candidate.container));
        const stable = stableSince > 0 && Date.now() - stableSince >= config.responseStableMs;
        if (!streaming && stable) {
          const parseResponse = protocol.parseCompactionResponseOrPlainText || protocol.parseCompactionResponse;
          const parsed = parseResponse(candidate.text, {
            expectedRequestId: expected.requestId
          });
          return { response: parsed, container: candidate.container };
        }

        await sleep(config.responsePollMs);
      }

      throw new Error('Timed out waiting for the provider compaction response.');
    }

    async function sendCompactionRequest(expected, run) {
      const prompt = protocol.buildCompactionPrompt({ requestId: expected.requestId });
      await replaceComposerWithText(prompt);
      assertNotCancelled(run);
      assertConversationUnchanged(expected);
      const sendButton = await waitForSendButton(run);
      sendButton.click();
      return prompt;
    }

    async function sendCheckedRuntimeMessage(type, payload) {
      const response = await sendRuntimeMessage({ type, payload });
      if (!response?.ok) throw new Error(response?.error || `Local Chat ${type} request failed.`);
      return response;
    }

    async function runCompaction(run) {
      const target = currentLocalChatTarget();
      if (!target?.sessionId) throw new Error('Open a local chat session before compacting this conversation.');
      if (hasGeneratingAssistant())
        throw new Error('Wait for the current assistant response to finish before compacting.');

      const provider = providerInfo();
      const requestId = protocol.createCompactionRequestId();
      const expected = {
        requestId,
        sessionId: target.sessionId,
        providerKey: provider.key,
        pageIdentity: currentPageIdentity(),
        assistantContainersBeforeRequest: new Set(
          visibleMessageContainers().filter((container) => inferSender(container) === 'bot')
        )
      };

      setState('sending-request', expected);
      await sendCompactionRequest(expected, run);

      assertNotCancelled(run);
      setState('waiting-response', expected);
      const parsed = await waitForResponse(expected, run);

      assertNotCancelled(run);
      markProtocolTurn(parsed.container, 'response');
      assertConversationUnchanged(expected);
      setState('persisting', expected);
      const persisted = await sendCheckedRuntimeMessage('UPSERT_LOCAL_CHAT_COMPACTION', {
        sessionId: expected.sessionId,
        ...protocol.compactionApiPayload(parsed.response, expected.providerKey)
      });

      assertConversationUnchanged(expected);
      setState('activating', {
        ...expected,
        sessionId: persisted.sessionId || persisted.session?.id || expected.sessionId
      });
      const compactedSessionId = persisted.sessionId || persisted.session?.id;
      if (!compactedSessionId) throw new Error('Local Chat App did not return the compacted session ID.');

      const active = await sendCheckedRuntimeMessage('SET_ACTIVE_LOCAL_CHAT_SESSION', {
        sessionId: compactedSessionId
      });

      hideMatchingRequestTurn(expected.requestId);
      setActiveSession({
        sessionId: compactedSessionId,
        session: persisted.session || active.active?.session || active.session || null
      });
      refreshSidebar(true);

      setState('complete', { requestId, sessionId: compactedSessionId });
      showToast(`Compacted → ${persisted.sessionTitle || active.sessionTitle || 'compacted session'}`);
      return {
        ok: true,
        requestId,
        sourceSessionId: expected.sessionId,
        sessionId: compactedSessionId,
        session: persisted.session || null
      };
    }

    function startCompaction() {
      if (activePromise || RUNNING_PHASES.has(state.phase)) {
        return Promise.reject(new Error('A compaction is already in progress.'));
      }

      const run = { cancelled: false };
      activeRun = run;
      activePromise = runCompaction(run)
        .catch((error) => {
          if (isCancellationError(error)) {
            setState('cancelled', {
              requestId: state.requestId,
              sessionId: state.sessionId
            });
            showToast('Compaction cancelled.');
            return { ok: false, cancelled: true, requestId: state.requestId, sessionId: state.sessionId };
          }

          setState('error', {
            requestId: state.requestId,
            sessionId: state.sessionId,
            error: error?.message || 'Compaction failed.'
          });
          showToast(error?.message || 'Could not compact this conversation.', true);
          throw error;
        })
        .finally(() => {
          activePromise = null;
          activeRun = null;
        });

      return activePromise;
    }

    function cancelCompaction() {
      if (!activeRun || !CANCELLABLE_PHASES.has(state.phase)) return false;
      activeRun.cancelled = true;
      setState('cancelling', { requestId: state.requestId, sessionId: state.sessionId });
      return true;
    }

    function clearStatus() {
      if (isRunning()) return false;
      setState('idle', { requestId: '', sessionId: '', error: '' });
      return true;
    }

    function resetForTest() {
      activePromise = null;
      activeRun = null;
      state = { phase: 'idle', requestId: '', sessionId: '', error: '' };
    }

    return {
      protocolTurnKind,
      markProtocolTurn,
      hideMatchingRequestTurn,
      responseCandidate,
      getState,
      isRunning,
      startCompaction,
      cancelCompaction,
      clearStatus,
      resetForTest
    };
  }

  return {
    DEFAULTS,
    RUNNING_PHASES,
    CANCELLABLE_PHASES,
    createCompactionWorkflow
  };
});
