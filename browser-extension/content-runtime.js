(function exposeLocalChatContentRuntime(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentRuntime() {
  'use strict';

  const DEFAULTS = Object.freeze({
    autoSendStorageKey: 'localChatAutoSendEnabled',
    localChatAppHealthCheckMinMs: 1500,
    localChatAppHealthCheckOfflineMs: 12000,
    localChatAppHealthCheckOnlineMs: 60000,
    localChatAppHealthCheckHiddenOfflineMs: 60000,
    localChatAppHealthCheckHiddenOnlineMs: 5 * 60 * 1000,
    localChatAppOfflineMessage: 'Local chat app is not running.',
    periodicInjectMs: 2000
  });

  function createRuntimeController(deps = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const markers = deps.markers || {};
    const EXT_MARKER = markers.EXT_MARKER || 'data-local-chat-save';
    const NEW_SESSION_MARKER = markers.NEW_SESSION_MARKER || 'data-local-chat-new-session';
    const AUTO_SEND_TOGGLE_MARKER = markers.AUTO_SEND_TOGGLE_MARKER || 'data-local-chat-auto-send';
    const AUTO_SEND_TOGGLE_MOUNT_MARKER = markers.AUTO_SEND_TOGGLE_MOUNT_MARKER || 'data-local-chat-auto-send-mount';
    const AUTO_SEND_COMPOSER_MARKER = markers.AUTO_SEND_COMPOSER_MARKER || 'data-local-chat-auto-send-composer';
    const AUTO_SEND_LAYOUT_MARKER = markers.AUTO_SEND_LAYOUT_MARKER || 'data-local-chat-auto-send-layout';
    const LOAD_PAST_MODAL_ID = markers.LOAD_PAST_MODAL_ID || 'local-chat-load-past-modal';

    const normalizeText =
      deps.normalizeText ||
      ((value) =>
        String(value || '')
          .trim()
          .replace(/\s+/g, ' '));
    const providerInfo = deps.providerInfo || (() => ({ name: 'AI', key: 'unknown' }));
    const isVisibleElement =
      deps.isVisibleElement ||
      ((element) => {
        const rect = element?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      });
    const findMessageContainer = deps.findMessageContainer || (() => null);
    const inferSender = deps.inferSender || (() => 'bot');
    const isCopyButton = deps.isCopyButton || (() => false);
    const isNestedContentCopyButton = deps.isNestedContentCopyButton || (() => false);
    const buttonLabel =
      deps.buttonLabel ||
      ((button) =>
        [
          button?.getAttribute?.('aria-label'),
          button?.getAttribute?.('title'),
          button?.getAttribute?.('data-testid'),
          button?.getAttribute?.('data-state'),
          button?.textContent
        ]
          .filter(Boolean)
          .join(' ')
          .trim()
          .toLowerCase());
    const findComposerContainer = deps.findComposerContainer || (() => null);
    const composerInputs = deps.composerInputs || (() => []);
    const showToast = deps.showToast || (() => {});
    const removeLoadPastButtons = deps.removeLoadPastButtons || (() => {});
    const injectLoadPastButton = deps.injectLoadPastButton || (() => {});
    const chromeApi = deps.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    const requestAnimationFrameImpl =
      deps.requestAnimationFrame ||
      ((callback) => {
        if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
        return setTimeout(callback, 0);
      });

    const getAutosaveController = deps.getAutosaveController || (() => null);
    const getSidebarController = deps.getSidebarController || (() => null);

    let localChatAutoSendEnabled = true;
    let autoSendPreferenceLoaded = false;
    let temporaryChatNavigationPending = false;
    let localChatAppAvailable = false;
    let localChatAppAvailabilityLoaded = false;
    let localChatAppHealthCheckPromise = null;
    let localChatAppLastHealthCheckAt = 0;
    let localChatAppLastHealthError = '';
    let localChatAppHealthCheckTimer = null;
    let scheduled = false;
    let started = false;
    let periodicInjectTimer = null;

    function sidebarController() {
      return getSidebarController?.() || null;
    }

    function autosaveController() {
      return getAutosaveController?.() || null;
    }

    function isTopLevelChatGptPage() {
      try {
        if (window.top !== window.self) return false;
      } catch {
        return false;
      }

      const host = location.hostname.toLowerCase();
      return host.includes('chatgpt.com') || host.includes('chat.openai.com');
    }

    function isTemporaryChatUrl() {
      try {
        return new URL(location.href).searchParams.get('temporary-chat') === 'true';
      } catch {
        return false;
      }
    }

    function shouldUseTemporaryChatForLocalMode(force = false) {
      if (!force && !autoSendPreferenceLoaded) return false;
      if (!isAutoSendEnabled()) return false;
      if (!isTopLevelChatGptPage()) return false;
      if (isTemporaryChatUrl()) return false;
      return true;
    }

    function ensureTemporaryChatUrlForLocalMode(options = {}) {
      const force = Boolean(options.force);
      if (temporaryChatNavigationPending) return true;
      if (!shouldUseTemporaryChatForLocalMode(force)) return false;

      try {
        if (options.pendingSessionId) {
          sidebarController()?.storePendingLocalSidebarLoad?.(options.pendingSessionId);
        }

        const url = new URL(location.href);
        url.searchParams.set('temporary-chat', 'true');
        temporaryChatNavigationPending = true;
        location.assign(url.toString());
        return true;
      } catch {
        return false;
      }
    }

    function consumePendingLocalSidebarLoad() {
      return sidebarController()?.consumePendingLocalSidebarLoad?.();
    }

    function currentLocalChatTarget() {
      return sidebarController()?.currentLocalChatTarget?.() || null;
    }

    async function sendLocalChatMessage(payload) {
      const response = await chromeApi.runtime.sendMessage({
        type: 'SAVE_LOCAL_CHAT_MESSAGE',
        payload
      });

      if (!response?.ok) {
        if (isLocalChatAppConnectionError(response?.error)) {
          setLocalChatAppAvailability(false, response?.error || config.localChatAppOfflineMessage);
        }
        throw new Error(response?.error || 'Save failed.');
      }

      setLocalChatAppAvailability(true);
      sidebarController()?.invalidateLocalSidebarCache?.();
      return response;
    }

    function isLocalChatAppConnectionError(message) {
      return /failed to fetch|networkerror|load failed|could not connect|connection refused|local chat app is not running/i.test(
        String(message || '')
      );
    }

    function shouldExposeLocalChatUi() {
      return localChatAppAvailabilityLoaded && localChatAppAvailable;
    }

    function removeAutoSendToggleUi() {
      document
        .querySelectorAll?.(`[${AUTO_SEND_TOGGLE_MARKER}], [${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`)
        .forEach((element) => element.remove());

      document.querySelectorAll?.(`[${AUTO_SEND_LAYOUT_MARKER}]`).forEach((element) => {
        element.removeAttribute(AUTO_SEND_LAYOUT_MARKER);
      });

      document.querySelectorAll?.(`[${AUTO_SEND_COMPOSER_MARKER}]`).forEach((element) => {
        element.removeAttribute(AUTO_SEND_COMPOSER_MARKER);
      });
    }

    function removeSaveLocalButtons() {
      document.querySelectorAll?.(`[${EXT_MARKER}]`).forEach((button) => button.remove());
    }

    function removeNewSessionButtons() {
      document.querySelectorAll?.(`[${NEW_SESSION_MARKER}]`).forEach((button) => button.remove());
    }

    function removeEmptyChatOnlyButtons() {
      removeNewSessionButtons();
      removeLoadPastButtons();
    }

    function removeLocalChatUnavailableUi() {
      removeAutoSendToggleUi();
      removeSaveLocalButtons();
      removeLoadPastButtons();
      sidebarController()?.removeLocalSidebarReplacement?.();
      autosaveController()?.clearTransientState?.();
    }

    function setLocalChatAppAvailability(available, error = '') {
      const nextAvailable = Boolean(available);
      const changed = localChatAppAvailabilityLoaded ? localChatAppAvailable !== nextAvailable : true;

      localChatAppAvailable = nextAvailable;
      localChatAppAvailabilityLoaded = true;
      localChatAppLastHealthError = nextAvailable
        ? ''
        : String(error || '').trim() || config.localChatAppOfflineMessage;

      if (!nextAvailable) {
        removeLocalChatUnavailableUi();
        if (changed) scheduleNextLocalChatAppHealthCheck();
        return;
      }

      if (changed) {
        updateAutoSendToggles();
        if (!ensureTemporaryChatUrlForLocalMode({ force: true })) {
          sidebarController()?.scheduleLocalSidebarRefresh?.(true);
          consumePendingLocalSidebarLoad();
        }
        scheduleInject();
        scheduleNextLocalChatAppHealthCheck();
      }
    }

    function localChatAppHealthCheckIntervalMs() {
      if (document.visibilityState === 'hidden') {
        return localChatAppAvailable
          ? config.localChatAppHealthCheckHiddenOnlineMs
          : config.localChatAppHealthCheckHiddenOfflineMs;
      }

      return localChatAppAvailable ? config.localChatAppHealthCheckOnlineMs : config.localChatAppHealthCheckOfflineMs;
    }

    function clearLocalChatAppHealthCheckTimer() {
      if (!localChatAppHealthCheckTimer) return;
      clearTimeout(localChatAppHealthCheckTimer);
      localChatAppHealthCheckTimer = null;
    }

    function scheduleNextLocalChatAppHealthCheck(delayMs = localChatAppHealthCheckIntervalMs()) {
      clearLocalChatAppHealthCheckTimer();
      const delay = Math.max(0, Number(delayMs) || 0);
      localChatAppHealthCheckTimer = setTimeout(() => {
        localChatAppHealthCheckTimer = null;
        runScheduledLocalChatAppHealthCheck();
      }, delay);
    }

    async function runScheduledLocalChatAppHealthCheck() {
      try {
        const available = await checkLocalChatAppAvailability(true);
        if (available) scheduleInject();
      } catch {
        // checkLocalChatAppAvailability already updates availability state.
      } finally {
        scheduleNextLocalChatAppHealthCheck();
      }
    }

    function checkLocalChatAppAvailabilityNow() {
      clearLocalChatAppHealthCheckTimer();
      runScheduledLocalChatAppHealthCheck();
    }

    async function checkLocalChatAppAvailability(force = false) {
      const now = Date.now();

      if (localChatAppHealthCheckPromise) return localChatAppHealthCheckPromise;
      if (
        !force &&
        localChatAppAvailabilityLoaded &&
        now - localChatAppLastHealthCheckAt < config.localChatAppHealthCheckMinMs
      ) {
        return localChatAppAvailable;
      }

      localChatAppHealthCheckPromise = chromeApi.runtime
        .sendMessage({
          type: 'CHECK_LOCAL_CHAT_APP'
        })
        .then((response) => {
          localChatAppLastHealthCheckAt = Date.now();
          setLocalChatAppAvailability(Boolean(response?.ok), response?.error);
          return localChatAppAvailable;
        })
        .catch((error) => {
          localChatAppLastHealthCheckAt = Date.now();
          setLocalChatAppAvailability(false, error?.message || config.localChatAppOfflineMessage);
          return false;
        })
        .finally(() => {
          localChatAppHealthCheckPromise = null;
        });

      return localChatAppHealthCheckPromise;
    }

    function isAutoSendEnabled() {
      return shouldExposeLocalChatUi() && localChatAutoSendEnabled !== false;
    }

    function updateAutoSendToggles() {
      if (!shouldExposeLocalChatUi()) {
        removeAutoSendToggleUi();
        sidebarController()?.removeLocalSidebarReplacement?.();
        return;
      }

      document.querySelectorAll(`[${AUTO_SEND_TOGGLE_MARKER}]`).forEach((toggle) => {
        const checkbox = toggle.querySelector?.('input[type="checkbox"]');
        const status = toggle.querySelector?.('.local-chat-auto-send-status');
        const enabled = isAutoSendEnabled();

        if (checkbox) checkbox.checked = enabled;
        if (status) status.textContent = enabled ? 'On' : 'Off';
        toggle.classList.toggle('is-off', !enabled);
        toggle.title = enabled
          ? 'Auto-save prompts and completed AI responses to Local Chat'
          : 'Auto-save is paused. Manual Save local buttons still work.';
      });

      if (!sidebarController()?.shouldShowLocalSidebarReplacement?.()) {
        sidebarController()?.removeLocalSidebarReplacement?.();
      }
    }

    async function loadAutoSendPreference() {
      try {
        const data = await chromeApi.storage.local.get({ [config.autoSendStorageKey]: true });
        localChatAutoSendEnabled = data[config.autoSendStorageKey] !== false;
      } catch {
        localChatAutoSendEnabled = true;
      }

      await sidebarController()?.loadLocalSidebarPreference?.();

      autoSendPreferenceLoaded = true;
      updateAutoSendToggles();

      if (shouldExposeLocalChatUi() && !ensureTemporaryChatUrlForLocalMode({ force: true })) {
        consumePendingLocalSidebarLoad();
      }
    }

    async function setAutoSendPreference(enabled) {
      localChatAutoSendEnabled = Boolean(enabled);
      autoSendPreferenceLoaded = true;
      updateAutoSendToggles();

      try {
        await chromeApi.storage.local.set({ [config.autoSendStorageKey]: localChatAutoSendEnabled });
      } catch (error) {
        showToast(error.message || 'Could not save the auto-save setting.', true);
      }

      if (!localChatAutoSendEnabled) {
        autosaveController()?.clearTransientState?.();
        sidebarController()?.removeLocalSidebarReplacement?.();
        return;
      }

      const appAvailable = await checkLocalChatAppAvailability(true);
      if (!appAvailable) {
        removeLocalChatUnavailableUi();
        return;
      }

      if (!ensureTemporaryChatUrlForLocalMode({ force: true })) {
        sidebarController()?.scheduleLocalSidebarRefresh?.(true);
        consumePendingLocalSidebarLoad();
      }
    }

    function createAutoSendToggle() {
      const label = document.createElement('label');
      label.className = 'local-chat-auto-send-toggle';
      label.setAttribute(AUTO_SEND_TOGGLE_MARKER, 'true');
      label.title = 'Auto-save prompts and completed AI responses to Local Chat';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isAutoSendEnabled();
      checkbox.setAttribute('aria-label', 'Auto-save messages to Local Chat');

      const text = document.createElement('span');
      text.className = 'local-chat-auto-send-text';
      text.textContent = 'Local';

      const status = document.createElement('span');
      status.className = 'local-chat-auto-send-status';
      status.textContent = isAutoSendEnabled() ? 'On' : 'Off';

      checkbox.addEventListener('change', () => {
        setAutoSendPreference(checkbox.checked);
        showToast(checkbox.checked ? 'Local Chat auto-save enabled.' : 'Local Chat auto-save paused.');
      });

      label.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      label.append(checkbox, text, status);
      updateAutoSendToggles();
      return label;
    }

    function clearAutoSendLayoutMarkers() {
      document.querySelectorAll?.(`[${AUTO_SEND_LAYOUT_MARKER}]`).forEach((element) => {
        const mount = element.querySelector?.(`[${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`);
        if (!mount) element.removeAttribute(AUTO_SEND_LAYOUT_MARKER);
      });

      document.querySelectorAll?.(`[${AUTO_SEND_COMPOSER_MARKER}]`).forEach((element) => {
        const parent = element.parentElement;
        const mount = parent?.querySelector?.(`[${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`);
        if (!mount) element.removeAttribute(AUTO_SEND_COMPOSER_MARKER);
      });
    }

    function removeInlineAutoSendToggles() {
      document.querySelectorAll?.(`[${AUTO_SEND_TOGGLE_MARKER}]`).forEach((toggle) => {
        if (!toggle.closest?.(`[${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`)) toggle.remove();
      });
    }

    function cleanupAutoSendToggleMounts(activeComposer = null) {
      document.querySelectorAll?.(`[${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`).forEach((mount) => {
        const composer = mount.__localChatComposer;
        const hasComposer = composer && document.documentElement.contains(composer);
        const keep = hasComposer && (!activeComposer || composer === activeComposer);

        if (!keep) {
          mount.remove();
          if (composer?.removeAttribute) composer.removeAttribute(AUTO_SEND_COMPOSER_MARKER);
        }
      });

      clearAutoSendLayoutMarkers();
    }

    function isChatGptProvider() {
      return providerInfo().key === 'chatgpt';
    }

    function canUseAutoSendSiblingLayout(composer) {
      if (!isChatGptProvider()) return false;

      const parent = composer?.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) return false;
      if (parent.closest?.(`[${EXT_MARKER}], #${LOAD_PAST_MODAL_ID}`)) return false;

      const rect = composer.getBoundingClientRect?.();
      const parentRect = parent.getBoundingClientRect?.();
      if (!rect || !parentRect || rect.width < 120 || parentRect.width < 160) return false;
      if (rect.height > Math.max(260, window.innerHeight * 0.45)) return false;

      const visibleChildren = Array.from(parent.children || []).filter((child) => {
        if (child === composer) return true;
        if (child.hasAttribute?.(AUTO_SEND_TOGGLE_MOUNT_MARKER)) return true;
        return isVisibleElement(child);
      });

      const parentText = normalizeText(parent.innerText || '');
      return (
        visibleChildren.includes(composer) &&
        visibleChildren.length <= 4 &&
        parentText.length < 3200 &&
        parentRect.width >= Math.min(rect.width, 120)
      );
    }

    function getOrCreateAutoSendMount(composer) {
      let mount = Array.from(document.querySelectorAll?.(`[${AUTO_SEND_TOGGLE_MOUNT_MARKER}]`) || []).find(
        (candidate) => candidate.__localChatComposer === composer
      );

      if (!mount) {
        mount = document.createElement('div');
        mount.className = 'local-chat-auto-send-mount';
        mount.setAttribute(AUTO_SEND_TOGGLE_MOUNT_MARKER, 'true');
      }

      mount.__localChatComposer = composer;

      let toggle = mount.querySelector?.(`[${AUTO_SEND_TOGGLE_MARKER}]`);
      if (!toggle) {
        toggle = createAutoSendToggle();
        mount.replaceChildren(toggle);
      }

      return mount;
    }

    function findExistingAutoSendComposer() {
      const existing = document.querySelector?.(`[${AUTO_SEND_COMPOSER_MARKER}]`);
      if (!existing || !document.documentElement.contains(existing)) return null;
      if (!isVisibleElement(existing)) return null;
      if (!composerInputs(existing).length) return null;
      return existing;
    }

    function injectAutoSendToggle() {
      if (!shouldExposeLocalChatUi()) {
        removeAutoSendToggleUi();
        return;
      }

      const composer = findExistingAutoSendComposer() || findComposerContainer();
      if (!composer) return;

      removeInlineAutoSendToggles();
      cleanupAutoSendToggleMounts(composer);

      const mount = getOrCreateAutoSendMount(composer);
      const parent = composer.parentElement;

      if (canUseAutoSendSiblingLayout(composer) && parent) {
        composer.setAttribute(AUTO_SEND_COMPOSER_MARKER, 'true');
        parent.setAttribute(AUTO_SEND_LAYOUT_MARKER, 'true');

        if (mount.parentElement !== parent || mount.previousElementSibling !== composer) {
          composer.insertAdjacentElement('afterend', mount);
        }
      } else {
        composer.removeAttribute(AUTO_SEND_COMPOSER_MARKER);
        parent?.removeAttribute?.(AUTO_SEND_LAYOUT_MARKER);

        if (mount.parentElement !== document.documentElement) {
          document.documentElement.appendChild(mount);
        }

        mount.classList.add('is-floating');
        positionFloatingAutoSendMount(mount, composer);
      }

      if (mount.parentElement !== document.documentElement) {
        mount.classList.remove('is-floating');
        mount.style.removeProperty('left');
        mount.style.removeProperty('top');
        mount.style.removeProperty('right');
      }

      updateAutoSendToggles();
    }

    function positionFloatingAutoSendMount(mount, composer) {
      if (!mount || !composer) return;

      const rect = composer.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      const width = mount.offsetWidth || 96;
      const height = mount.offsetHeight || 32;
      const gap = 8;

      const hasRightSpace = rect.right + width + gap <= window.innerWidth - gap;
      const left = hasRightSpace
        ? rect.right + gap
        : Math.max(gap, Math.min(window.innerWidth - width - gap, rect.right - width));

      const hasVerticalRoomAbove = rect.top - height - gap >= gap;
      const top = hasRightSpace
        ? rect.top + (rect.height - height) / 2
        : hasVerticalRoomAbove
          ? rect.top - height - gap
          : rect.top + gap;

      mount.style.left = `${Math.round(left)}px`;
      mount.style.top = `${Math.round(Math.max(gap, Math.min(window.innerHeight - height - gap, top)))}px`;
      mount.style.removeProperty('right');
    }

    function createSaveButton(container, copyButton = null) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'local-chat-save-btn';
      button.textContent = 'Save local';
      button.title = 'Save this whole message to your local chat app using the original copy button when possible';
      button.setAttribute(EXT_MARKER, 'true');
      button.__localChatContainer = container || null;
      button.__localChatCopyButton = copyButton || null;

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const storedContainer = button.__localChatContainer;
        const storedCopyButton = button.__localChatCopyButton;
        const liveContainer =
          storedContainer && document.documentElement.contains(storedContainer)
            ? storedContainer
            : findMessageContainer(storedCopyButton || button);

        if (!liveContainer) {
          showToast('Could not find this message container.', true);
          return;
        }

        autosaveController()?.saveContainer?.(
          liveContainer,
          button,
          storedCopyButton && document.documentElement.contains(storedCopyButton) ? storedCopyButton : null
        );
      });

      return button;
    }

    function saveButtonForCopyButton(copyButton) {
      const next = copyButton?.nextElementSibling;
      const prev = copyButton?.previousElementSibling;
      if (next?.hasAttribute?.(EXT_MARKER)) return next;
      if (prev?.hasAttribute?.(EXT_MARKER)) return prev;
      return null;
    }

    function scoreMessageCopyButton(button, container) {
      if (!button || !container) return -1;
      const rect = button.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return -1;

      let score = rect.top;
      const parentText = normalizeText(button.parentElement?.innerText || button.parentElement?.textContent || '');
      const label = buttonLabel(button);

      if (parentText.length && parentText.length < 240) score += 600;
      if (!button.closest?.('.markdown, .prose, [data-testid="message-content"]')) score += 900;
      if (button.closest?.('[data-testid*="action" i], [class*="action" i], [class*="footer" i], [class*="toolbar" i]'))
        score += 250;
      if (/\bcopy\b/i.test(label) && !/\b(copy\s+(code|table|csv|cell|row|column|snippet|block))\b/i.test(label))
        score += 120;

      return score;
    }

    function chooseMessageCopyButton(container, copyButtons) {
      const candidates = copyButtons
        .filter((button) => document.documentElement.contains(button))
        .filter((button) => !isNestedContentCopyButton(button, container));

      const pool = candidates.length ? candidates : copyButtons;
      return pool.reduce((best, button) => {
        if (!best) return button;
        return scoreMessageCopyButton(button, container) > scoreMessageCopyButton(best, container) ? button : best;
      }, null);
    }

    function collectMessageSaveTargets() {
      const grouped = new Map();
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));

      for (const copyButton of buttons) {
        if (!isCopyButton(copyButton)) continue;

        const container = findMessageContainer(copyButton);
        if (!container) continue;
        if (inferSender(container) === 'bot' && !autosaveController()?.isAssistantMessageReadyForButton?.(container))
          continue;

        if (!grouped.has(container)) grouped.set(container, []);
        grouped.get(container).push(copyButton);
      }

      return Array.from(grouped.entries())
        .map(([container, copyButtons]) => ({
          container,
          copyButton: chooseMessageCopyButton(container, copyButtons)
        }))
        .filter((target) => target.copyButton);
    }

    function removeInvalidSaveButtons(validCopyButtons = new Set()) {
      document.querySelectorAll(`[${EXT_MARKER}]`).forEach((saveButton) => {
        const copyButton =
          saveButton.__localChatCopyButton || saveButton.previousElementSibling || saveButton.nextElementSibling;
        if (!copyButton || !validCopyButtons.has(copyButton) || !isCopyButton(copyButton)) saveButton.remove();
      });
    }

    function injectButtons() {
      if (!shouldExposeLocalChatUi()) {
        removeLocalChatUnavailableUi();
        return;
      }

      injectAutoSendToggle();
      sidebarController()?.scheduleLocalSidebarRefresh?.();
      removeNewSessionButtons();
      injectLoadPastButton();
      autosaveController()?.scheduleOutgoingDomSaveIfNeeded?.();

      const targets = collectMessageSaveTargets();
      const validCopyButtons = new Set(targets.map((target) => target.copyButton));
      removeInvalidSaveButtons(validCopyButtons);

      for (const { container, copyButton } of targets) {
        let saveButton = saveButtonForCopyButton(copyButton);

        if (!saveButton) {
          saveButton = createSaveButton(container, copyButton);
          copyButton.insertAdjacentElement('afterend', saveButton);
        } else {
          saveButton.__localChatContainer = container;
          saveButton.__localChatCopyButton = copyButton;
        }

        autosaveController()?.scheduleAssistantAutoSave?.(container, saveButton, copyButton);
      }
    }

    function scheduleInject() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrameImpl(() => {
        scheduled = false;
        injectButtons();
      });
    }

    function installStorageListener() {
      try {
        chromeApi.storage.onChanged.addListener((changes, areaName) => {
          if (areaName !== 'local') return;

          if (changes.localAppUrl) {
            localChatAppAvailable = false;
            localChatAppAvailabilityLoaded = false;
            localChatAppLastHealthCheckAt = 0;
            removeLocalChatUnavailableUi();
            checkLocalChatAppAvailabilityNow();
          }

          if (!changes[config.autoSendStorageKey]) return;
          localChatAutoSendEnabled = changes[config.autoSendStorageKey].newValue !== false;
          autoSendPreferenceLoaded = true;
          if (!localChatAutoSendEnabled) {
            autosaveController()?.clearTransientState?.({ clearAssistantTarget: true });
          }
          updateAutoSendToggles();
          if (shouldExposeLocalChatUi() && !ensureTemporaryChatUrlForLocalMode({ force: true })) {
            sidebarController()?.scheduleLocalSidebarRefresh?.(true);
            consumePendingLocalSidebarLoad();
          }
        });
      } catch {}
    }

    function installVisibilityListener() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          checkLocalChatAppAvailabilityNow();
          return;
        }

        scheduleNextLocalChatAppHealthCheck();
      });
    }

    function startContentScriptRuntime() {
      if (started) return;
      started = true;

      const observer = new MutationObserver(scheduleInject);
      observer.observe(document.documentElement, { childList: true, subtree: true });

      autosaveController()?.installOutgoingPromptAutoSave?.();
      loadAutoSendPreference()
        .then(() => checkLocalChatAppAvailability(true))
        .finally(() => {
          scheduleInject();
          scheduleNextLocalChatAppHealthCheck();
        });

      installStorageListener();
      installVisibilityListener();

      scheduleInject();
      periodicInjectTimer = setInterval(injectButtons, config.periodicInjectMs);
    }

    function setStateForTest(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, 'localChatAppAvailable')) {
        localChatAppAvailable = Boolean(options.localChatAppAvailable);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'localChatAppAvailabilityLoaded')) {
        localChatAppAvailabilityLoaded = Boolean(options.localChatAppAvailabilityLoaded);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'localChatAutoSendEnabled')) {
        localChatAutoSendEnabled = options.localChatAutoSendEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(options, 'autoSendPreferenceLoaded')) {
        autoSendPreferenceLoaded = Boolean(options.autoSendPreferenceLoaded);
      }
    }

    function getStateForTest() {
      return {
        localChatAutoSendEnabled,
        autoSendPreferenceLoaded,
        temporaryChatNavigationPending,
        localChatAppAvailable,
        localChatAppAvailabilityLoaded,
        localChatAppLastHealthCheckAt,
        localChatAppLastHealthError,
        scheduled,
        started
      };
    }

    function resetForTest() {
      localChatAutoSendEnabled = true;
      autoSendPreferenceLoaded = false;
      temporaryChatNavigationPending = false;
      localChatAppAvailable = false;
      localChatAppAvailabilityLoaded = false;
      localChatAppHealthCheckPromise = null;
      localChatAppLastHealthCheckAt = 0;
      localChatAppLastHealthError = '';
      clearLocalChatAppHealthCheckTimer();
      if (periodicInjectTimer) clearInterval(periodicInjectTimer);
      periodicInjectTimer = null;
      scheduled = false;
      started = false;
    }

    return {
      isTopLevelChatGptPage,
      isTemporaryChatUrl,
      shouldUseTemporaryChatForLocalMode,
      ensureTemporaryChatUrlForLocalMode,
      consumePendingLocalSidebarLoad,
      currentLocalChatTarget,
      sendLocalChatMessage,
      isLocalChatAppConnectionError,
      shouldExposeLocalChatUi,
      removeAutoSendToggleUi,
      removeSaveLocalButtons,
      removeNewSessionButtons,
      removeEmptyChatOnlyButtons,
      removeLocalChatUnavailableUi,
      setLocalChatAppAvailability,
      localChatAppHealthCheckIntervalMs,
      clearLocalChatAppHealthCheckTimer,
      scheduleNextLocalChatAppHealthCheck,
      runScheduledLocalChatAppHealthCheck,
      checkLocalChatAppAvailabilityNow,
      checkLocalChatAppAvailability,
      isAutoSendEnabled,
      updateAutoSendToggles,
      loadAutoSendPreference,
      setAutoSendPreference,
      createAutoSendToggle,
      injectAutoSendToggle,
      positionFloatingAutoSendMount,
      createSaveButton,
      saveButtonForCopyButton,
      scoreMessageCopyButton,
      chooseMessageCopyButton,
      collectMessageSaveTargets,
      removeInvalidSaveButtons,
      injectButtons,
      scheduleInject,
      startContentScriptRuntime,
      setStateForTest,
      getStateForTest,
      resetForTest
    };
  }

  return {
    DEFAULTS,
    createRuntimeController
  };
});
