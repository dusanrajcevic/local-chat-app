import { createActiveSessionController } from './controllers/active-session.mjs';
import { createFolderController } from './controllers/folders.mjs';
import { createMessageController } from './controllers/messages.mjs';
import { createSessionController } from './controllers/sessions.mjs';

function createControllers({ state, el, api, view, modal, stateUtils, storage, win = window, doc = document }) {
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
    confirmUser
  });

  const folderController = createFolderController({
    state,
    api,
    view,
    modal,
    refreshAll,
    alertUser,
    confirmUser
  });

  const messageController = createMessageController({
    state,
    el,
    api,
    modal,
    openSession: sessionController.openSession,
    refreshAll,
    alertUser,
    confirmUser
  });

  async function boot() {
    await refreshAll();
    await activeController.restoreOpenSession();
    activeController.startExternalActiveSessionSync();
  }

  return {
    refreshAll,
    ...activeController,
    ...sessionController,
    ...folderController,
    ...messageController,
    boot
  };
}

export { createControllers };
