const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR, FOLDERS_FILE } = require('../config');
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
  const cleanFolderName = cleanName(name, 80);
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
  const cleanFolderName = cleanName(name, 80);
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

async function deleteFolderAndUnpinSessions(folderId) {
  await withLock(FOLDERS_FILE, async () => {
    const data = await readFoldersDocument(FOLDERS_FILE);
    data.folders = (data.folders || []).filter((folder) => folder.id !== folderId);
    await writeJson(FOLDERS_FILE, data);
  });

  const dateDirs = await listDateDirs();
  for (const dateDir of dateDirs) {
    const dir = path.join(DATA_DIR, dateDir);
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const filePath = path.join(dir, file);
      await withLock(filePath, async () => {
        const session = await readSessionRecord(filePath);
        if (session.pinnedFolderId === folderId) {
          session.pinnedFolderId = null;
          session.updatedAt = new Date().toISOString();
          await writeJson(filePath, session);
        }
      });
    }
  }
}

module.exports = {
  readFolders,
  folderExists,
  requireExistingFolderId,
  createFolder,
  renameFolder,
  deleteFolderAndUnpinSessions
};
