import { escapeHtml, renderMarkdown } from './markdown.mjs';
import { createApiClient } from './api.mjs';
import { createInitialState, queryElements, formatDate, getBotName, nextMessageSender } from './state.mjs';
import * as exportService from './export.mjs';
import { createRenderer } from './render.mjs';
import { createModalController } from './modals.mjs';
import { createClipboardController } from './clipboard.mjs';
import { createControllers } from './controllers.mjs';
import { wireEvents } from './events.mjs';
import { createMessageNavigator } from './message-navigator.mjs';

const stateUtils = {
  createInitialState,
  queryElements,
  formatDate,
  getBotName,
  nextMessageSender
};

function defaultFetch(win) {
  const fetchImpl = win?.fetch || globalThis.fetch;
  if (!fetchImpl) return null;
  return fetchImpl.bind(win || globalThis);
}

export function createRuntime({
  doc = document,
  win = window,
  storage = localStorage,
  fetchImpl = defaultFetch(win)
} = {}) {
  const state = createInitialState({ storage });
  const el = queryElements(doc);
  const api = createApiClient({ fetchImpl });
  const messageNavigator = createMessageNavigator({
    messagesElement: el.messages,
    navigatorElement: el.messageNavigator,
    raf: win.requestAnimationFrame?.bind(win)
  });
  const view = createRenderer({
    state,
    el,
    storage,
    escapeHtml,
    renderMarkdown,
    formatDate,
    getBotName,
    nextMessageSender,
    messageNavigator
  });
  const modal = createModalController({ state, el, doc, raf: win.requestAnimationFrame?.bind(win) });
  const announceStatus = (message) => {
    if (el.appStatus) el.appStatus.textContent = String(message || '');
  };
  const clipboard = createClipboardController({
    state,
    el,
    doc,
    win,
    navigatorRef: win.navigator,
    exportService,
    getBotName,
    announceStatus
  });
  const controllers = createControllers({
    state,
    el,
    api,
    view,
    modal,
    stateUtils,
    storage,
    win,
    doc,
    announceStatus
  });

  wireEvents({ state, el, view, modal, controllers, clipboard, doc });
  return { state, el, api, view, modal, clipboard, controllers, messageNavigator };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const runtime = createRuntime();
  window.LocalChatAppRuntime = runtime;
  runtime.controllers.boot().catch((err) => window.alert(err.message));
}
