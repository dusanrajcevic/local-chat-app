import { createActiveSessionController } from './controllers/active-session.mjs';
import { createFolderController } from './controllers/folders.mjs';
import { createMessageController } from './controllers/messages.mjs';
import { createSessionController } from './controllers/sessions.mjs';
import { createSearchController } from './controllers/search.mjs';

function createControllers({
  state,
  el,
  api,
  view,
  modal,
  stateUtils,
  storage,
  win = window,
  doc = document,
  announceStatus = () => {}
}) {
  const alertUser = win.alert?.bind(win) || (typeof alert !== 'undefined' ? alert : () => {});
  const confirmUser = win.confirm?.bind(win) || (typeof confirm !== 'undefined' ? confirm : () => true);

  async function refreshAll() {
    const [folders, sessions, trash] = await Promise.all([
      api('/api/folders'),
      api('/api/sessions'),
      api('/api/trash')
    ]);
    state.folders = folders;
    state.sessions = sessions;
    state.trash = trash;
    view.renderFolders();
    view.renderPinSelect();
    view.renderSessions();
    view.renderTrash();
  }

  let sessionController;
  const activeController = createActiveSessionController({
    state,
    api,
    view,
    modal,
    storage,
    win,
    doc,
    refreshAll,
    openSession: (...args) => sessionController.openSession(...args)
  });

  sessionController = createSessionController({
    state,
    api,
    view,
    modal,
    stateUtils,
    active: activeController,
    refreshAll,
    alertUser,
    confirmUser,
    announceStatus
  });

  const searchController = createSearchController({
    api,
    el,
    modal,
    openSession: sessionController.openSession,
    doc,
    win
  });

  const folderController = createFolderController({
    state,
    api,
    view,
    modal,
    refreshAll,
    alertUser,
    confirmUser,
    announceStatus
  });

  const messageController = createMessageController({
    state,
    el,
    api,
    modal,
    openSession: sessionController.openSession,
    refreshAll,
    alertUser,
    confirmUser,
    announceStatus
  });

  function closeExtensionPairing() {
    modal.closeExtensionPairingModal();
  }

  async function createExtensionPairingCode() {
    const pairing = await api('/api/extension/pairing-code', {
      method: 'POST',
      body: '{}'
    });
    el.extensionPairingCode.textContent = pairing.code;
    el.extensionPairingExpires.textContent = `Expires ${new Date(pairing.expiresAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })}`;
    modal.openExtensionPairingModal();
    announceStatus('Browser extension pairing code generated.');
    return pairing;
  }

  async function copyExtensionPairingCode() {
    const code = String(el.extensionPairingCode.textContent || '').trim();
    if (!code) return false;
    if (!win.navigator?.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
    await win.navigator.clipboard.writeText(code);
    announceStatus('Pairing code copied to clipboard.');
    return true;
  }

  async function boot() {
    await refreshAll();
    await activeController.restoreOpenSession();
    activeController.startExternalActiveSessionSync();
  }

  return {
    refreshAll,
    createExtensionPairingCode,
    copyExtensionPairingCode,
    closeExtensionPairing,
    ...activeController,
    ...sessionController,
    ...searchController,
    ...folderController,
    ...messageController,
    boot
  };
}

export { createControllers };
