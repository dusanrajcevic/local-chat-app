function reportError(err) {
  if (typeof alert !== 'undefined') alert(err.message);
  else console.error(err);
}

function wireEvents({ state, el, view, modal, controllers, clipboard, doc = document }) {
  view.applySidebarState();
  el.sidebarToggleBtn.addEventListener('click', view.toggleSidebar);
  el.newChatBtn.addEventListener('click', () => controllers.createSession().catch(reportError));
  el.newFolderBtn.addEventListener('click', () => controllers.createFolder().catch(reportError));
  el.sendBtn.addEventListener('click', () => controllers.sendMessage().catch(reportError));
  el.renameBotBtn.addEventListener('click', () => controllers.renameBotName().catch(reportError));
  el.renameSessionBtn.addEventListener('click', () => controllers.renameSession().catch(reportError));
  el.copyChatBtn.addEventListener('click', () => clipboard.copyEntireChat().catch(reportError));
  el.cancelEditMessageBtn.addEventListener('click', modal.closeEditMessageModal);
  el.saveEditMessageBtn.addEventListener('click', () => controllers.saveEditedMessage().catch(reportError));
  el.editMessageModal.addEventListener('click', (event) => {
    if (event.target === el.editMessageModal) modal.closeEditMessageModal();
  });
  el.cancelAppPromptBtn.addEventListener('click', () => modal.closeTextPrompt(null));
  el.saveAppPromptBtn.addEventListener('click', modal.submitTextPrompt);
  el.appPromptModal.addEventListener('click', (event) => {
    if (event.target === el.appPromptModal) modal.closeTextPrompt(null);
  });
  el.isMeCheckbox.addEventListener('change', () => {
    if (!state.currentSession || state.currentSession.trashed) return;
    state.nextSenderOverride = {
      sessionId: state.currentSession.id,
      sender: el.isMeCheckbox.checked ? 'me' : 'bot'
    };
  });
  el.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      controllers.sendMessage().catch(reportError);
    }
  });

  doc.addEventListener('keydown', (event) => {
    if (!el.appPromptModal.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        modal.closeTextPrompt(null);
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        modal.submitTextPrompt();
      }

      return;
    }

    if (el.editMessageModal.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      modal.closeEditMessageModal();
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      controllers.saveEditedMessage().catch(reportError);
    }
  });

  el.pinSelect.addEventListener('change', () => controllers.pinCurrentSession(el.pinSelect.value).catch(reportError));
  el.toggleTrashBtn.addEventListener('click', controllers.toggleTrash);

  doc.addEventListener('click', async (event) => {
    const target = event.target.closest(
      '[data-open-session], [data-rename-session], [data-trash-session], [data-delete-trash], [data-restore-session], [data-folder], [data-rename-folder], [data-delete-folder], [data-copy-message], [data-edit-message], [data-delete-message]'
    );
    if (!target) return;

    try {
      if (target.dataset.openSession) return controllers.openSession(target.dataset.openSession);
      if (target.dataset.renameSession) return controllers.renameSession(target.dataset.renameSession);
      if (target.dataset.renameFolder) return controllers.renameFolder(target.dataset.renameFolder);
      if (target.dataset.copyMessage) return clipboard.copyMessageMarkdown(target.dataset.copyMessage, target);
      if (target.dataset.editMessage) return controllers.openMessageForEdit(target.dataset.editMessage);
      if (target.dataset.deleteMessage) return controllers.deleteMessage(target.dataset.deleteMessage);
      if (target.dataset.folder) return controllers.selectFolder(target.dataset.folder);
      if (target.dataset.trashSession) return controllers.trashSession(target.dataset.trashSession);
      if (target.dataset.restoreSession) return controllers.restoreSession(target.dataset.restoreSession);
      if (target.dataset.deleteTrash) return controllers.deleteTrashSession(target.dataset.deleteTrash);
      if (target.dataset.deleteFolder) return controllers.deleteFolder(target.dataset.deleteFolder);
    } catch (err) {
      reportError(err);
    }
  });

  doc.addEventListener('copy', clipboard.handleCopyEvent);
}

export { wireEvents, reportError };
