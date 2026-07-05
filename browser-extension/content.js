const LocalChatContentDom = (() => {
  if (typeof require === 'function') return require('./content-dom');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentDom) return globalThis.LocalChatContentDom;
  throw new Error('LocalChatContentDom must be loaded before content.js');
})();

const LocalChatContentAutosave = (() => {
  if (typeof require === 'function') return require('./content-autosave');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentAutosave)
    return globalThis.LocalChatContentAutosave;
  throw new Error('LocalChatContentAutosave must be loaded before content.js');
})();

const LocalChatContentSidebar = (() => {
  if (typeof require === 'function') return require('./content-sidebar');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentSidebar)
    return globalThis.LocalChatContentSidebar;
  throw new Error('LocalChatContentSidebar must be loaded before content.js');
})();

const LocalChatContentComposer = (() => {
  if (typeof require === 'function') return require('./content-composer');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentComposer)
    return globalThis.LocalChatContentComposer;
  throw new Error('LocalChatContentComposer must be loaded before content.js');
})();

const LocalChatContentRuntime = (() => {
  if (typeof require === 'function') return require('./content-runtime');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentRuntime)
    return globalThis.LocalChatContentRuntime;
  throw new Error('LocalChatContentRuntime must be loaded before content.js');
})();

const LocalChatContentMessageSave = (() => {
  if (typeof require === 'function') return require('./content-message-save');
  if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentMessageSave)
    return globalThis.LocalChatContentMessageSave;
  throw new Error('LocalChatContentMessageSave must be loaded before content.js');
})();

const {
  markers: {
    EXT_MARKER,
    NEW_SESSION_MARKER,
    LOAD_PAST_MARKER,
    TOP_PIN_SELECT_MARKER,
    AUTO_SEND_TOGGLE_MARKER,
    LOCAL_SIDEBAR_MARKER,
    LOAD_PAST_MODAL_ID
  },
  providerInfo,
  normalizeText,
  hashText,
  isCopyButton,
  isNestedContentCopyButton,
  findMessageContainer,
  markdownForElement,
  messageExtractionSource,
  extractMessageTextFallback,
  inferSender,
  assistantContentSignature,
  hasStreamingMarker,
  shouldSkipExtractedMessageText,
  isProviderTranscriptText,
  cleanExtractedMessageText
} = LocalChatContentDom;

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatLocalDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function showToast(message, isError = false) {
  let toast = document.querySelector('#local-chat-save-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'local-chat-save-toast';
    document.documentElement.appendChild(toast);
  }

  toast.textContent = message;
  toast.className = isError ? 'local-chat-save-toast error show' : 'local-chat-save-toast show';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

let runtimeController = null;
let messageSaveController = null;
let sidebarController = null;
let composerController = null;
let autosaveController = null;

function composerControllerOrNull() {
  return composerController || null;
}

function requireComposerController() {
  if (!composerController) throw new Error('LocalChatContentComposer has not been initialized.');
  return composerController;
}

function runtimeControllerOrNull() {
  return runtimeController || null;
}

function shouldExposeLocalChatUi() {
  return runtimeControllerOrNull()?.shouldExposeLocalChatUi?.() || false;
}

function sleep(ms) {
  return messageSaveController?.sleep?.(ms) || new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisibleElement(element) {
  if (messageSaveController) return messageSaveController.isVisibleElement(element);
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function extractMessageText(container, copyButton = null, senderHint = null) {
  if (!messageSaveController) throw new Error('LocalChatContentMessageSave has not been initialized.');
  return messageSaveController.extractMessageText(container, copyButton, senderHint);
}

function visibleMessageContainers() {
  return messageSaveController?.visibleMessageContainers?.() || [];
}

function isAutoSendEnabled() {
  return runtimeControllerOrNull()?.isAutoSendEnabled?.() || false;
}

function ensureTemporaryChatUrlForLocalMode(options = {}) {
  return runtimeControllerOrNull()?.ensureTemporaryChatUrlForLocalMode?.(options) || false;
}

function isLocalChatAppConnectionError(message) {
  return (
    runtimeControllerOrNull()?.isLocalChatAppConnectionError?.(message) ||
    /failed|network|connect/i.test(String(message || ''))
  );
}

function setLocalChatAppAvailability(available, error = '') {
  return runtimeControllerOrNull()?.setLocalChatAppAvailability?.(available, error);
}

function currentLocalChatTarget() {
  return runtimeControllerOrNull()?.currentLocalChatTarget?.() || null;
}

function sendLocalChatMessage(payload) {
  if (!runtimeController) throw new Error('LocalChatContentRuntime has not been initialized.');
  return runtimeController.sendLocalChatMessage(payload);
}

function injectButtons() {
  return runtimeControllerOrNull()?.injectButtons?.();
}

function collectMessageSaveTargets() {
  return runtimeControllerOrNull()?.collectMessageSaveTargets?.() || [];
}

function createSaveButton(container, copyButton = null) {
  if (!runtimeController) throw new Error('LocalChatContentRuntime has not been initialized.');
  return runtimeController.createSaveButton(container, copyButton);
}

function saveButtonForCopyButton(copyButton) {
  return runtimeControllerOrNull()?.saveButtonForCopyButton?.(copyButton) || null;
}

function removeEmptyChatOnlyButtons() {
  return runtimeControllerOrNull()?.removeEmptyChatOnlyButtons?.();
}

function replaceComposerWithText(text) {
  return requireComposerController().replaceComposerWithText(text);
}

function updateLoadPastControls(options = {}) {
  return composerControllerOrNull()?.updateLoadPastControls(options);
}

function removeLoadPastButtons() {
  if (composerController) composerController.removeLoadPastButtons();
  else document.querySelectorAll?.(`[${LOAD_PAST_MARKER}]`).forEach((button) => button.remove());
}

function injectLoadPastButton() {
  return composerControllerOrNull()?.injectLoadPastButton();
}

function isInsideComposer(element) {
  return composerControllerOrNull()?.isInsideComposer(element) || false;
}

function findComposerContainerNear(startNode) {
  return composerControllerOrNull()?.findComposerContainerNear(startNode) || null;
}

function findComposerContainer() {
  return composerControllerOrNull()?.findComposerContainer() || null;
}

function composerInputs(composer) {
  return composerControllerOrNull()?.composerInputs(composer) || [];
}

function findComposerInputFromTarget(target) {
  return composerControllerOrNull()?.findComposerInputFromTarget(target) || null;
}

function textFromComposer(composer, preferredInput = null) {
  return composerControllerOrNull()?.textFromComposer(composer, preferredInput) || '';
}

function buttonLabel(button) {
  return (
    composerControllerOrNull()?.buttonLabel(button) ||
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
      .toLowerCase()
  );
}

function isDisabledControl(element) {
  return composerControllerOrNull()?.isDisabledControl(element) ?? true;
}

function isSendButton(button) {
  return composerControllerOrNull()?.isSendButton(button) || false;
}

function findSendButtonNear(startNode) {
  return composerControllerOrNull()?.findSendButtonNear(startNode) || null;
}

messageSaveController = LocalChatContentMessageSave.createMessageSaveController({
  markers: LocalChatContentDom.markers,
  normalizeText,
  selectionInside: LocalChatContentDom.selectionInside,
  findMessageContainer,
  extractMessageTextFallback,
  isInsideComposer
});

sidebarController = LocalChatContentSidebar.createSidebarController({
  markers: {
    EXT_MARKER,
    NEW_SESSION_MARKER,
    LOAD_PAST_MARKER,
    TOP_PIN_SELECT_MARKER,
    AUTO_SEND_TOGGLE_MARKER,
    LOCAL_SIDEBAR_MARKER,
    LOAD_PAST_MODAL_ID,
    LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER: LocalChatContentDom.markers.LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER
  },
  providerInfo,
  normalizeText,
  isVisibleElement,
  escapeHtml,
  formatLocalDate,
  isAutoSendEnabled,
  shouldExposeLocalChatUi,
  ensureTemporaryChatUrlForLocalMode,
  isLocalChatAppConnectionError,
  setLocalChatAppAvailability,
  replaceComposerWithText,
  updateLoadPastControls,
  showToast,
  chromeApi: typeof chrome !== 'undefined' ? chrome : null
});

composerController = LocalChatContentComposer.createComposerController({
  markers: {
    EXT_MARKER,
    NEW_SESSION_MARKER,
    LOAD_PAST_MARKER,
    TOP_PIN_SELECT_MARKER,
    AUTO_SEND_TOGGLE_MARKER,
    LOCAL_SIDEBAR_MARKER,
    LOAD_PAST_MODAL_ID
  },
  normalizeText,
  isVisibleElement,
  escapeHtml,
  formatLocalDate,
  sleep,
  shouldExposeLocalChatUi,
  showToast,
  resetComposerSnapshot: () => autosaveController?.resetComposerSnapshot?.(),
  getSidebarData: () => sidebarController.getData(),
  getActiveLocalSidebarSession: () => sidebarController.getActiveLocalSidebarSession(),
  setActiveSessionFromExport: (...args) => sidebarController.setActiveSessionFromExport(...args),
  requestLocalSidebarData: (force = false) => sidebarController.requestLocalSidebarData(force),
  scheduleLocalSidebarRefresh: (force = false) => sidebarController.scheduleLocalSidebarRefresh(force),
  isLocalPinSelectElement: (element) => sidebarController.isLocalPinSelectElement(element),
  markLocalPinSelectInteraction: () => sidebarController.markLocalPinSelectInteraction(),
  isLocalPinSelectInteracting: (container = document) => sidebarController.isLocalPinSelectInteracting(container),
  handleLocalPinSelectInteractionEvent: (event) => sidebarController.handleLocalPinSelectInteractionEvent(event),
  handleLocalSidebarChange: (event) => sidebarController.handleLocalSidebarChange(event),
  chromeApi: typeof chrome !== 'undefined' ? chrome : null
});

autosaveController = LocalChatContentAutosave.createAutosaveController({
  markers: {
    EXT_MARKER,
    NEW_SESSION_MARKER,
    LOAD_PAST_MARKER,
    TOP_PIN_SELECT_MARKER,
    AUTO_SEND_TOGGLE_MARKER,
    LOCAL_SIDEBAR_MARKER
  },
  normalizeText,
  hashText,
  providerInfo,
  currentLocalChatTarget,
  isAutoSendEnabled,
  inferSender,
  findMessageContainer,
  isVisibleElement,
  isDisabledControl,
  findComposerContainerNear,
  findComposerContainer,
  findComposerInputFromTarget,
  findSendButtonNear,
  isSendButton,
  textFromComposer,
  visibleMessageContainers,
  extractMessageText,
  extractMessageTextFallback,
  cleanExtractedMessageText,
  shouldSkipExtractedMessageText,
  assistantContentSignature,
  hasStreamingMarker,
  sendLocalChatMessage,
  showToast,
  removeEmptyChatOnlyButtons,
  sleep
});

runtimeController = LocalChatContentRuntime.createRuntimeController({
  markers: LocalChatContentDom.markers,
  normalizeText,
  providerInfo,
  isVisibleElement,
  findMessageContainer,
  inferSender,
  isCopyButton,
  isNestedContentCopyButton,
  buttonLabel,
  findComposerContainer,
  composerInputs,
  showToast,
  removeLoadPastButtons,
  injectLoadPastButton,
  getSidebarController: () => sidebarController,
  getAutosaveController: () => autosaveController,
  chromeApi: typeof chrome !== 'undefined' ? chrome : null
});

function startContentScriptRuntime() {
  runtimeController.startContentScriptRuntime();
}

function setContentScriptStateForTest(options = {}) {
  runtimeController.setStateForTest(options);
}

function markAssistantContainerReadyForTest(container) {
  return autosaveController.markAssistantContainerReadyForTest(container);
}

function resetContentScriptStateForTest() {
  runtimeController.resetForTest();
  sidebarController.resetForTest();
  autosaveController.resetForTest();
  composerController?.resetForTest?.();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    markers: {
      EXT_MARKER,
      NEW_SESSION_MARKER,
      LOAD_PAST_MARKER,
      TOP_PIN_SELECT_MARKER,
      AUTO_SEND_TOGGLE_MARKER,
      LOCAL_SIDEBAR_MARKER
    },
    providerInfo,
    normalizeText,
    markdownForElement,
    messageExtractionSource,
    extractMessageTextFallback,
    extractMessageText,
    inferSender,
    findMessageContainer,
    isCopyButton,
    isNestedContentCopyButton,
    collectMessageSaveTargets,
    createSaveButton,
    saveButtonForCopyButton,
    injectButtons,
    shouldSkipExtractedMessageText,
    buildSaveIdempotencyKey: autosaveController.buildSaveIdempotencyKey,
    isProviderTranscriptText,
    setContentScriptStateForTest,
    markAssistantContainerReadyForTest,
    resetContentScriptStateForTest,
    sidebarController,
    composerController,
    runtimeController,
    messageSaveController
  };
} else {
  startContentScriptRuntime();
}
