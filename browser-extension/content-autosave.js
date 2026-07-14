(function exposeLocalChatContentAutosave(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentAutosave = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentAutosave() {
  'use strict';

  const DEFAULTS = Object.freeze({
    autoAssistantSaveDelayMs: 650,
    autoAssistantSaveDedupLimit: 250,
    assistantAutoSaveArmWindowMs: 10 * 60 * 1000,
    assistantReadyForButtonStableMs: 1200,
    assistantCompletePollMs: 350,
    assistantCompleteTimeoutMs: 2 * 60 * 1000,
    assistantAutoSaveArmDedupMs: 3500,
    outgoingDomSaveArmWindowMs: 30 * 1000,
    composerSnapshotMaxAgeMs: 60 * 1000,
    userMessageDomSaveDelayMs: 180,
    outgoingAutoSaveDedupMs: 3500,
    outgoingAutoSaveDelayMs: 90,
    outgoingAutoUserFingerprintTtlMs: 10 * 60 * 1000,
    outgoingAutoUserFingerprintLimit: 300
  });

  function createNoopDependency(name) {
    return function missingDependency() {
      throw new Error(`LocalChatContentAutosave dependency is missing: ${name}`);
    };
  }

  function createAutosaveController(deps = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const normalizeText = deps.normalizeText || ((value) => String(value || '').trim());
    const hashText = deps.hashText || ((value) => String(value || '').length.toString(36));
    const providerInfo = deps.providerInfo || (() => ({ name: 'AI Chat', key: 'provider' }));
    const currentLocalChatTarget = deps.currentLocalChatTarget || (() => null);
    const isAutoSendEnabled = deps.isAutoSendEnabled || (() => true);
    const inferSender = deps.inferSender || (() => 'bot');
    const findMessageContainer = deps.findMessageContainer || ((element) => element || null);
    const isVisibleElement = deps.isVisibleElement || (() => true);
    const isDisabledControl = deps.isDisabledControl || (() => false);
    const findComposerContainerNear = deps.findComposerContainerNear || (() => null);
    const findComposerContainer = deps.findComposerContainer || (() => null);
    const findComposerInputFromTarget = deps.findComposerInputFromTarget || (() => null);
    const findSendButtonNear = deps.findSendButtonNear || (() => null);
    const isSendButton = deps.isSendButton || (() => false);
    const textFromComposer = deps.textFromComposer || (() => '');
    const visibleMessageContainers = deps.visibleMessageContainers || (() => []);
    const extractMessageText = deps.extractMessageText || createNoopDependency('extractMessageText');
    const extractMessageTextFallback = deps.extractMessageTextFallback || (() => '');
    const cleanExtractedMessageText = deps.cleanExtractedMessageText || ((value) => normalizeText(value));
    const shouldSkipExtractedMessageText = deps.shouldSkipExtractedMessageText || (() => false);
    const assistantContentSignature = deps.assistantContentSignature || (() => '');
    const hasStreamingMarker = deps.hasStreamingMarker || (() => false);
    const sendLocalChatMessage = deps.sendLocalChatMessage || createNoopDependency('sendLocalChatMessage');
    const showToast = deps.showToast || (() => {});
    const removeEmptyChatOnlyButtons = deps.removeEmptyChatOnlyButtons || (() => {});
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const markers = deps.markers || {};

    const autoSavedAssistantFingerprints = new Set();
    const pendingAssistantContainers = new WeakSet();
    const attemptedAssistantContainers = new WeakSet();
    const assistantCompletionStates = new WeakMap();
    const assistantContainersIgnoredByArm = new WeakMap();
    let assistantAutoSaveArmId = 0;
    let lastAssistantAutoSaveArm = { key: '', at: 0 };
    let assistantAutoSaveArmedAt = 0;
    let assistantAutoSaveBudget = 0;
    let assistantAutoSaveTarget = null;

    let outgoingAutoSaveInstalled = false;
    let lastOutgoingAutoSave = { text: '', at: 0 };
    const pendingOutgoingAutoSaves = new Map();
    const autoSavedOutgoingUserFingerprints = new Map();
    const attemptedOutgoingDomContainers = new WeakSet();
    const pendingOutgoingDomContainers = new WeakSet();
    let outgoingDomSaveArmedAt = 0;
    let lastComposerSnapshot = { text: '', at: 0 };

    function messageFingerprint(providerKey, sender, text) {
      const normalized = normalizeText(text);
      return [providerKey || 'provider', sender || 'bot', normalized.length, hashText(normalized)].join(':');
    }

    function buildSaveIdempotencyKey(source, providerKey, sender, text, sessionId = '') {
      const normalized = normalizeText(text);
      const parts = [
        'lc',
        source || 'save',
        providerKey || providerInfo().key || 'provider',
        sender || 'bot',
        sessionId || 'active',
        normalized.length,
        hashText(normalized)
      ];
      return parts
        .join('-')
        .replace(/[^a-zA-Z0-9._:-]/g, '-')
        .slice(0, 160);
    }

    function armAssistantAutoSave(key = 'submit', target = currentLocalChatTarget()) {
      const now = Date.now();
      const normalizedKey = normalizeText(key).slice(0, 240) || 'submit';

      assistantAutoSaveTarget = target || null;
      assistantAutoSaveArmedAt = now;
      assistantAutoSaveBudget = Math.max(assistantAutoSaveBudget, 1);

      if (
        now - lastAssistantAutoSaveArm.at < 1500 ||
        (lastAssistantAutoSaveArm.key === normalizedKey &&
          now - lastAssistantAutoSaveArm.at < config.assistantAutoSaveArmDedupMs)
      ) {
        lastAssistantAutoSaveArm.at = now;
        return;
      }

      assistantAutoSaveArmId += 1;
      lastAssistantAutoSaveArm = { key: normalizedKey, at: now };
      markExistingAssistantContainersIgnoredForCurrentArm();
    }

    function reserveAssistantAutoSaveSlot() {
      if (!assistantAutoSaveBudget) return false;
      if (Date.now() - assistantAutoSaveArmedAt > config.assistantAutoSaveArmWindowMs) {
        assistantAutoSaveBudget = 0;
        return false;
      }

      assistantAutoSaveBudget -= 1;
      return true;
    }

    function rememberAutoSavedAssistant(fingerprint) {
      autoSavedAssistantFingerprints.add(fingerprint);

      if (autoSavedAssistantFingerprints.size > config.autoAssistantSaveDedupLimit) {
        const first = autoSavedAssistantFingerprints.values().next().value;
        if (first) autoSavedAssistantFingerprints.delete(first);
      }
    }

    function buttonLabel(button) {
      return [
        button?.getAttribute?.('aria-label'),
        button?.getAttribute?.('title'),
        button?.getAttribute?.('data-testid'),
        button?.getAttribute?.('data-state'),
        button?.textContent
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .toLowerCase();
    }

    function hasAnyMarker(button) {
      return Boolean(
        button?.hasAttribute?.(markers.EXT_MARKER) ||
        button?.hasAttribute?.(markers.NEW_SESSION_MARKER) ||
        button?.hasAttribute?.(markers.LOAD_PAST_MARKER) ||
        button?.hasAttribute?.(markers.TOP_PIN_SELECT_MARKER) ||
        button?.hasAttribute?.(markers.AUTO_SEND_TOGGLE_MARKER) ||
        button?.closest?.(`[${markers.LOAD_PAST_MARKER}], [${markers.LOCAL_SIDEBAR_MARKER}]`)
      );
    }

    function isGenerationStopControl(button) {
      if (!button || button.nodeType !== Node.ELEMENT_NODE) return false;
      if (!button.matches?.('button, [role="button"]')) return false;
      if (!isVisibleElement(button) || isDisabledControl(button)) return false;
      if (hasAnyMarker(button)) return false;

      const label = buttonLabel(button);
      if (!label) return false;
      if (/(copy|close|dismiss|remove|delete|attach|upload|file|new chat|new session)/i.test(label)) return false;

      if (/\b(stop generating|stop response|stop streaming|interrupt response|stop generation)\b/i.test(label))
        return true;

      return /^\s*(stop|cancel|interrupt)\s*$/i.test(label) && Boolean(findComposerContainerNear(button));
    }

    function hasVisibleGenerationStopControl() {
      return Array.from(document.querySelectorAll('button, [role="button"]')).some(isGenerationStopControl);
    }

    function isLikelyNewestAssistantContainer(container) {
      if (!container || container.nodeType !== Node.ELEMENT_NODE) return false;

      const seen = new Set();
      const candidates = Array.from(
        document.querySelectorAll(
          [
            '[data-message-author-role="assistant"]',
            '[data-testid^="conversation-turn"]',
            '[data-testid="message-content"]',
            'article'
          ].join(',')
        )
      )
        .map((element) => findMessageContainer(element) || element)
        .filter((element) => {
          if (!element || seen.has(element) || !isVisibleElement(element)) return false;
          seen.add(element);
          return inferSender(element) === 'bot';
        });

      const latest = candidates[candidates.length - 1];
      if (!latest) return false;
      return latest === container || latest.contains(container) || container.contains(latest);
    }

    function markExistingAssistantContainersIgnoredForCurrentArm() {
      for (const container of visibleMessageContainers()) {
        if (inferSender(container) === 'bot') {
          assistantContainersIgnoredByArm.set(container, assistantAutoSaveArmId);
        }
      }
    }

    function hasActiveGenerationSignal(container, options = {}) {
      if (hasStreamingMarker(container)) return true;
      return (options.assumeNewest || isLikelyNewestAssistantContainer(container)) && hasVisibleGenerationStopControl();
    }

    function isAssistantMessageReadyForButton(container, options = {}) {
      if (!container) return false;
      if (inferSender(container) !== 'bot') return true;

      const signature = assistantContentSignature(container);
      if (!signature) return false;

      const now = Date.now();
      let state = assistantCompletionStates.get(container);

      if (!state || state.signature !== signature) {
        state = { signature, stableSince: now };
        assistantCompletionStates.set(container, state);
        return false;
      }

      if (hasActiveGenerationSignal(container, options)) {
        state.stableSince = now;
        return false;
      }

      return now - state.stableSince >= config.assistantReadyForButtonStableMs;
    }

    async function waitForAssistantMessageCompletion(container, options = {}) {
      const startedAt = Date.now();

      while (Date.now() - startedAt < config.assistantCompleteTimeoutMs) {
        if (!document.documentElement.contains(container)) return false;
        if (isAssistantMessageReadyForButton(container, options)) return true;
        await sleep(config.assistantCompletePollMs);
      }

      return false;
    }

    async function saveContainer(container, button, copyButton = null, options = {}) {
      const isAuto = Boolean(options.auto);
      const originalText = button.textContent;
      const { name, key } = providerInfo();

      button.disabled = true;
      button.textContent = isAuto ? 'Auto-saving…' : 'Saving…';

      try {
        const sender = inferSender(container);
        const text = cleanExtractedMessageText(await extractMessageText(container, copyButton, sender), sender);

        if (!text) {
          if (!isAuto) showToast('No message text found.', true);
          return { ok: false, skipped: true, reason: 'empty' };
        }

        const source = isAuto ? 'auto-assistant-complete' : 'manual-save-button';
        if (shouldSkipExtractedMessageText(text, sender, source)) {
          if (!isAuto) showToast('That does not look like a complete chat message yet.', true);
          return { ok: true, skipped: true, reason: 'transient-or-transcript' };
        }

        const fingerprint = messageFingerprint(key, sender, text);
        if (isAuto && sender === 'bot' && autoSavedAssistantFingerprints.has(fingerprint)) {
          button.textContent = 'Saved local';
          button.dataset.localChatAutoSaved = 'true';
          return { ok: true, skipped: true, reason: 'duplicate' };
        }

        const target = isAuto ? assistantAutoSaveTarget : currentLocalChatTarget();
        const response = await sendLocalChatMessage({
          provider: name,
          providerKey: key,
          sender,
          text,
          source,
          ...(target || {}),
          idempotencyKey: isAuto ? buildSaveIdempotencyKey(source, key, sender, text, target?.sessionId) : ''
        });

        if (sender === 'bot') rememberAutoSavedAssistant(fingerprint);

        button.textContent = isAuto ? 'Saved local' : 'Saved';
        button.dataset.localChatAutoSaved = 'true';
        showToast(
          `${isAuto ? 'Auto-saved response' : 'Saved to Local Chat'} → ${response.sessionTitle || 'active session'}`
        );
        return { ok: true, response };
      } catch (error) {
        button.textContent = isAuto ? 'Save local' : 'Error';
        if (isAuto) {
          button.dataset.localChatAutoSaveError = error.message || 'Auto-save failed';
          showToast(`AI response auto-save failed: ${error.message || 'Could not save message.'}`, true);
        } else {
          showToast(error.message || 'Could not save message.', true);
        }
        return { ok: false, error };
      } finally {
        setTimeout(
          () => {
            button.disabled = false;
            if (!button.dataset.localChatAutoSaved) button.textContent = originalText;
          },
          isAuto ? 650 : 1200
        );
      }
    }

    function scheduleAssistantAutoSave(container, button, copyButton, options = {}) {
      if (!isAutoSendEnabled()) return;
      if (!container || !button || !copyButton) return;
      if (inferSender(container) !== 'bot') return;
      if (!options.assumeNewest && !isLikelyNewestAssistantContainer(container)) return;
      if (assistantContainersIgnoredByArm.get(container) === assistantAutoSaveArmId) return;
      if (attemptedAssistantContainers.has(container) || pendingAssistantContainers.has(container)) return;
      if (!reserveAssistantAutoSaveSlot()) return;

      pendingAssistantContainers.add(container);
      button.dataset.localChatAutoPending = 'true';

      setTimeout(async () => {
        try {
          delete button.dataset.localChatAutoPending;
          if (!isAutoSendEnabled()) return;
          if (!document.documentElement.contains(container) || !document.documentElement.contains(button)) return;

          const isComplete = await waitForAssistantMessageCompletion(container, options);
          if (!isAutoSendEnabled()) return;
          if (
            !isComplete ||
            !document.documentElement.contains(container) ||
            !document.documentElement.contains(button)
          )
            return;

          attemptedAssistantContainers.add(container);

          await sleep(120);
          if (!isAutoSendEnabled()) return;
          await saveContainer(container, button, copyButton, { auto: true });
        } finally {
          pendingAssistantContainers.delete(container);
        }
      }, config.autoAssistantSaveDelayMs);
    }

    function rememberComposerSnapshot(target = document.activeElement) {
      const input = findComposerInputFromTarget(target) || findComposerInputFromTarget(document.activeElement);
      const composer = input ? findComposerContainerNear(input) : findComposerContainer();
      const text = textFromComposer(composer, input);

      if (text) lastComposerSnapshot = { text, at: Date.now() };
      return text;
    }

    function recentComposerSnapshotText() {
      if (!lastComposerSnapshot.text) return '';
      if (Date.now() - lastComposerSnapshot.at > config.composerSnapshotMaxAgeMs) return '';
      return lastComposerSnapshot.text;
    }

    function resetComposerSnapshot() {
      lastComposerSnapshot = { text: '', at: 0 };
    }

    function handleComposerSnapshotEvent(event) {
      rememberComposerSnapshot(event.target);
    }

    function armOutgoingDomSave(text = '', trigger = 'submit', target = currentLocalChatTarget()) {
      outgoingDomSaveArmedAt = Date.now();
      armAssistantAutoSave(normalizeText(text) || recentComposerSnapshotText() || trigger || 'submit', target);
    }

    function rememberOutgoingSave(text) {
      lastOutgoingAutoSave = { text: normalizeText(text), at: Date.now() };
    }

    function pruneAutoSavedOutgoingUserFingerprints(now = Date.now()) {
      for (const [fingerprint, savedAt] of autoSavedOutgoingUserFingerprints) {
        if (now - savedAt > config.outgoingAutoUserFingerprintTtlMs) {
          autoSavedOutgoingUserFingerprints.delete(fingerprint);
        }
      }

      while (autoSavedOutgoingUserFingerprints.size > config.outgoingAutoUserFingerprintLimit) {
        const oldest = autoSavedOutgoingUserFingerprints.keys().next().value;
        if (!oldest) break;
        autoSavedOutgoingUserFingerprints.delete(oldest);
      }
    }

    function outgoingUserFingerprint(providerKey, text) {
      return messageFingerprint(providerKey || providerInfo().key, 'me', text);
    }

    function wasOutgoingUserAutoSaved(providerKey, text) {
      const fingerprint = outgoingUserFingerprint(providerKey, text);
      const now = Date.now();
      pruneAutoSavedOutgoingUserFingerprints(now);
      const savedAt = autoSavedOutgoingUserFingerprints.get(fingerprint) || 0;
      return Boolean(savedAt && now - savedAt <= config.outgoingAutoUserFingerprintTtlMs);
    }

    function rememberOutgoingUserAutoSaved(providerKey, text) {
      const fingerprint = outgoingUserFingerprint(providerKey, text);
      autoSavedOutgoingUserFingerprints.set(fingerprint, Date.now());
      pruneAutoSavedOutgoingUserFingerprints();
    }

    async function saveOutgoingUserMessageFromDom(container, trigger = 'dom-user-message') {
      if (!isAutoSendEnabled()) return { ok: false, skipped: true, reason: 'auto-save-disabled' };

      const provider = providerInfo();
      const text = normalizeText(extractMessageTextFallback(container, 'me'));
      if (!text) return { ok: false, skipped: true, reason: 'empty' };
      if (shouldSkipExtractedMessageText(text, 'me', trigger)) {
        return { ok: true, skipped: true, reason: 'transient-or-transcript' };
      }

      if (wasOutgoingUserAutoSaved(provider.key, text)) {
        return { ok: true, skipped: true, reason: 'already-auto-saved' };
      }

      const pendingAt = pendingOutgoingAutoSaves.get(text) || 0;
      if (pendingAt && Date.now() - pendingAt < config.outgoingAutoSaveDedupMs) {
        return { ok: true, skipped: true, reason: 'already-pending' };
      }

      if (lastOutgoingAutoSave.text === text && Date.now() - lastOutgoingAutoSave.at < config.outgoingAutoSaveDedupMs) {
        return { ok: true, skipped: true, reason: 'duplicate' };
      }

      pendingOutgoingAutoSaves.set(text, Date.now());

      try {
        const target = assistantAutoSaveTarget || currentLocalChatTarget();
        const response = await sendLocalChatMessage({
          provider: provider.name,
          providerKey: provider.key,
          sender: 'me',
          text,
          source: 'auto-submit-dom-fallback',
          trigger,
          ...(target || {}),
          idempotencyKey: buildSaveIdempotencyKey(
            'auto-submit-dom-fallback',
            provider.key,
            'me',
            text,
            target?.sessionId
          )
        });

        rememberOutgoingSave(text);
        rememberOutgoingUserAutoSaved(provider.key, text);
        outgoingDomSaveArmedAt = 0;
        showToast(`Saved your prompt → ${response.sessionTitle || 'active session'}`);
        return { ok: true, response };
      } finally {
        setTimeout(() => pendingOutgoingAutoSaves.delete(text), config.outgoingAutoSaveDedupMs);
      }
    }

    function scheduleOutgoingDomSaveIfNeeded() {
      if (!isAutoSendEnabled()) return;
      if (!outgoingDomSaveArmedAt) return;
      if (Date.now() - outgoingDomSaveArmedAt > config.outgoingDomSaveArmWindowMs) {
        outgoingDomSaveArmedAt = 0;
        return;
      }

      const candidates = visibleMessageContainers().filter((container) => inferSender(container) === 'me');
      const container = candidates[candidates.length - 1];
      if (!container) return;
      if (attemptedOutgoingDomContainers.has(container) || pendingOutgoingDomContainers.has(container)) return;

      const text = normalizeText(extractMessageTextFallback(container, 'me'));
      if (!text || shouldSkipExtractedMessageText(text, 'me', 'dom-user-message-preview')) return;
      if (pendingOutgoingAutoSaves.has(text)) return;
      if (lastOutgoingAutoSave.text === text && Date.now() - lastOutgoingAutoSave.at < config.outgoingAutoSaveDedupMs)
        return;

      pendingOutgoingDomContainers.add(container);

      setTimeout(async () => {
        try {
          if (!document.documentElement.contains(container)) return;
          attemptedOutgoingDomContainers.add(container);
          const result = await saveOutgoingUserMessageFromDom(container);
          if (result?.ok && !result.skipped) outgoingDomSaveArmedAt = 0;
        } catch (error) {
          showToast(error.message || 'Could not auto-save your prompt.', true);
        } finally {
          pendingOutgoingDomContainers.delete(container);
        }
      }, config.userMessageDomSaveDelayMs);
    }

    function shouldIgnoreEnter(event) {
      return (
        event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing
      );
    }

    function queueOutgoingPromptSave(rawText, trigger = 'submit') {
      const text = normalizeText(rawText) || recentComposerSnapshotText();
      const saveTarget = currentLocalChatTarget();

      if (text) removeEmptyChatOnlyButtons();

      if (!isAutoSendEnabled()) return;

      if (text) {
        outgoingDomSaveArmedAt = 0;
        armAssistantAutoSave(text, saveTarget);
      } else {
        armOutgoingDomSave('', trigger, saveTarget);
        return;
      }

      const provider = providerInfo();
      if (wasOutgoingUserAutoSaved(provider.key, text)) return;

      const now = Date.now();
      const pendingAt = pendingOutgoingAutoSaves.get(text) || 0;
      if (pendingAt && now - pendingAt < config.outgoingAutoSaveDedupMs) return;
      if (lastOutgoingAutoSave.text === text && now - lastOutgoingAutoSave.at < config.outgoingAutoSaveDedupMs) return;

      pendingOutgoingAutoSaves.set(text, now);

      setTimeout(async () => {
        const provider = providerInfo();

        try {
          if (!isAutoSendEnabled()) return;
          const response = await sendLocalChatMessage({
            provider: provider.name,
            providerKey: provider.key,
            sender: 'me',
            text,
            source: 'auto-submit',
            trigger,
            ...(saveTarget || {}),
            idempotencyKey: buildSaveIdempotencyKey('auto-submit', provider.key, 'me', text, saveTarget?.sessionId)
          });

          rememberOutgoingSave(text);
          rememberOutgoingUserAutoSaved(provider.key, text);
          outgoingDomSaveArmedAt = 0;
          showToast(`Saved your prompt → ${response.sessionTitle || 'active session'}`);
        } catch (error) {
          showToast(error.message || 'Could not auto-save your prompt.', true);
        } finally {
          setTimeout(() => pendingOutgoingAutoSaves.delete(text), config.outgoingAutoSaveDedupMs);
        }
      }, config.outgoingAutoSaveDelayMs);
    }

    function handleOutgoingEnter(event) {
      if (shouldIgnoreEnter(event)) return;

      const input = findComposerInputFromTarget(event.target);
      if (!input) return;

      const composer = findComposerContainerNear(input);
      if (!composer) return;

      const sendButton = findSendButtonNear(input);
      if (sendButton && isDisabledControl(sendButton)) return;

      const text = textFromComposer(composer, input) || recentComposerSnapshotText();
      queueOutgoingPromptSave(text, 'enter');
    }

    function handleOutgoingSubmitButton(event) {
      if (event.type === 'pointerdown' && event.button !== undefined && event.button !== 0) return;

      const target = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement;
      const button = target?.closest?.('button, [role="button"]');
      if (!isSendButton(button)) return;

      const composer = findComposerContainerNear(button);
      if (!composer) return;

      const text = textFromComposer(composer) || recentComposerSnapshotText();
      queueOutgoingPromptSave(text, 'send-button');
    }

    function handleOutgoingFormSubmit(event) {
      const form = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : null;
      if (!form?.matches?.('form')) return;

      const text =
        textFromComposer(form, findComposerInputFromTarget(document.activeElement)) || recentComposerSnapshotText();
      queueOutgoingPromptSave(text, 'form-submit');
    }

    function installOutgoingPromptAutoSave() {
      if (outgoingAutoSaveInstalled) return;
      outgoingAutoSaveInstalled = true;

      document.addEventListener('input', handleComposerSnapshotEvent, true);
      document.addEventListener('keyup', handleComposerSnapshotEvent, true);
      document.addEventListener('keydown', handleOutgoingEnter, true);
      document.addEventListener('pointerdown', handleOutgoingSubmitButton, true);
      document.addEventListener('click', handleOutgoingSubmitButton, true);
      document.addEventListener('submit', handleOutgoingFormSubmit, true);
    }

    function clearTransientState(options = {}) {
      assistantAutoSaveBudget = 0;
      outgoingDomSaveArmedAt = 0;
      if (options.clearAssistantTarget) assistantAutoSaveTarget = null;
    }

    function markAssistantContainerReadyForTest(container) {
      const signature = assistantContentSignature(container);
      if (!signature) return false;
      assistantCompletionStates.set(container, {
        signature,
        stableSince: Date.now() - config.assistantReadyForButtonStableMs - 10
      });
      return true;
    }

    function resetForTest() {
      assistantAutoSaveTarget = null;
      assistantAutoSaveArmId = 0;
      lastAssistantAutoSaveArm = { key: '', at: 0 };
      assistantAutoSaveArmedAt = 0;
      assistantAutoSaveBudget = 0;
      autoSavedAssistantFingerprints.clear();
      lastOutgoingAutoSave = { text: '', at: 0 };
      pendingOutgoingAutoSaves.clear();
      autoSavedOutgoingUserFingerprints.clear();
      outgoingDomSaveArmedAt = 0;
      lastComposerSnapshot = { text: '', at: 0 };
      outgoingAutoSaveInstalled = false;
    }

    return {
      buildSaveIdempotencyKey,
      messageFingerprint,
      armAssistantAutoSave,
      clearTransientState,
      isAssistantMessageReadyForButton,
      waitForAssistantMessageCompletion,
      saveContainer,
      scheduleAssistantAutoSave,
      rememberComposerSnapshot,
      recentComposerSnapshotText,
      resetComposerSnapshot,
      queueOutgoingPromptSave,
      scheduleOutgoingDomSaveIfNeeded,
      installOutgoingPromptAutoSave,
      markAssistantContainerReadyForTest,
      resetForTest
    };
  }

  return {
    DEFAULTS,
    createAutosaveController
  };
});
