function createFolderController({ state, api, view, modal, refreshAll, alertUser, confirmUser }) {
  async function createFolder() {
    const name = await modal.openTextPrompt({
      eyebrow: 'New folder',
      title: 'Name the new folder',
      label: 'Folder name',
      submitText: 'Create folder'
    });
    if (!name || !name.trim()) return;
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await refreshAll();
  }

  async function renameFolder(folderId) {
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) return;

    const name = await modal.openTextPrompt({
      eyebrow: 'Rename folder',
      title: 'Rename local folder',
      label: 'Folder name',
      defaultValue: folder.name,
      submitText: 'Rename'
    });
    if (name === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) return alertUser('Folder name cannot be empty.');

    await api(`/api/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: trimmedName })
    });

    await refreshAll();
  }

  function toggleTrash() {
    state.trashOpen = !state.trashOpen;
    view.renderTrash();
  }

  function selectFolder(folderValue) {
    state.selectedFolderId = folderValue === 'all' ? null : folderValue;
    view.renderFolders();
    view.renderSessions();
  }

  async function deleteFolder(folderId) {
    if (!confirmUser('Delete this folder? Conversations will become unfiled.')) return;
    await api(`/api/folders/${folderId}`, { method: 'DELETE' });
    if (state.selectedFolderId === folderId) state.selectedFolderId = null;
    await refreshAll();
  }

  return {
    createFolder,
    renameFolder,
    toggleTrash,
    selectFolder,
    deleteFolder
  };
}

export { createFolderController };
