const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR, TRASH_DIR, FOLDERS_FILE } = require('../config');
const { appError } = require('../errors');
const { id } = require('../ids');
const { cleanName } = require('../validation');
const { ensureBaseFiles, writeJson, withLock, listDateDirs } = require('./file-store');
const { CURRENT_SCHEMA_VERSION, readFoldersDocument, readSessionRecord } = require('./record-validation');

async function readFolders() {
  await ensureBaseFiles();
  const data = await readFoldersDocument(FOLDERS_FILE);
  return Array.isArray(data.folders) ? data.folders : [];
}

async function folderExists(folderId) {
  if (!folderId) return true;
  const folders = await readFolders();
  return folders.some((folder) => folder.id === folderId);
}

async function requireExistingFolderId(folderId) {
  if (folderId && !(await folderExists(folderId))) throw appError(404, 'Folder not found.');
  return folderId;
}

async function createFolder(name) {
  const cleanFolderName = cleanName(name, 80, 'Folder name');
  if (!cleanFolderName) throw appError(400, 'Folder name is required.');

  return withLock(FOLDERS_FILE, async () => {
    const data = await readFoldersDocument(FOLDERS_FILE);
    const nextFolder = { id: id('folder'), name: cleanFolderName, createdAt: new Date().toISOString() };
    data.schemaVersion = CURRENT_SCHEMA_VERSION;
    data.folders = Array.isArray(data.folders) ? data.folders : [];
    data.folders.push(nextFolder);
    await writeJson(FOLDERS_FILE, data);
    return nextFolder;
  });
}

async function renameFolder(folderId, name) {
  const cleanFolderName = cleanName(name, 80, 'Folder name');
  if (!cleanFolderName) throw appError(400, 'Folder name is required.');

  return withLock(FOLDERS_FILE, async () => {
    const data = await readFoldersDocument(FOLDERS_FILE);
    const existing = (data.folders || []).find((item) => item.id === folderId);
    if (!existing) throw appError(404, 'Folder not found.');
    existing.name = cleanFolderName;
    existing.updatedAt = new Date().toISOString();
    await writeJson(FOLDERS_FILE, data);
    return existing;
  });
}

async function readDirectoryEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function unpinFolderInDirectory(dir, folderId, { trashed = false } = {}) {
  const entries = await readDirectoryEntries(dir);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(dir, entry.name);
    await withLock(filePath, async () => {
      let session;
      try {
        session = await readSessionRecord(filePath, { trashed });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }

      if (session.pinnedFolderId === folderId) {
        session.pinnedFolderId = null;
        session.updatedAt = new Date().toISOString();
        await writeJson(filePath, session);
      }
    });
  }
}

async function deleteFolderAndUnpinSessions(folderId) {
  await withLock(FOLDERS_FILE, async () => {
    const data = await readFoldersDocument(FOLDERS_FILE);
    data.folders = (data.folders || []).filter((folder) => folder.id !== folderId);
    await writeJson(FOLDERS_FILE, data);
  });

  const dateDirs = await listDateDirs();
  for (const dateDir of dateDirs) {
    await unpinFolderInDirectory(path.join(DATA_DIR, dateDir), folderId);
  }
  await unpinFolderInDirectory(TRASH_DIR, folderId, { trashed: true });
}

module.exports = {
  readFolders,
  folderExists,
  requireExistingFolderId,
  createFolder,
  renameFolder,
  deleteFolderAndUnpinSessions
};
