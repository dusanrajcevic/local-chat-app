const fs = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  TRASH_DIR,
  FOLDERS_FILE,
  MUTATION_JOURNAL_FILE,
  SESSION_ID_PATTERN,
  FOLDER_ID_PATTERN,
  DATE_DIR_PATTERN,
  CURRENT_SCHEMA_VERSION
} = require('../config');
const { appError } = require('../errors');
const { dateFolderName } = require('../ids');
const {
  withLock,
  writeJson,
  readJson,
  unlinkDataFile,
  listDateDirs,
  findSessionFile,
  ensureBaseFiles
} = require('./file-store');
const { readFoldersDocument, readSessionRecord, storedDataError } = require('./record-validation');
const { clearActiveSessionIf } = require('./state-store');

const GLOBAL_MUTATION_LOCK = Symbol('local-chat-global-mutation-lock');
const JOURNAL_VERSION = 1;
const MUTATION_TYPES = new Set(['trash-session', 'restore-session', 'delete-folder', 'permanent-delete-trash']);

let failureInjectorForTests = null;

function cloneForJournal(value) {
  return JSON.parse(JSON.stringify(value));
}

async function checkpoint(name, mutation) {
  if (!failureInjectorForTests) return;
  await failureInjectorForTests(name, cloneForJournal(mutation));
}

function assertJournalId(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw storedDataError('mutation journal', `${label} has an invalid format`);
  }
}

function validateMutationJournal(mutation) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw storedDataError('mutation journal', 'document must be an object');
  }
  if (mutation.journalVersion !== JOURNAL_VERSION) {
    throw storedDataError('mutation journal', `unsupported journalVersion ${String(mutation.journalVersion)}`);
  }
  if (mutation.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw storedDataError('mutation journal', `unsupported schemaVersion ${String(mutation.schemaVersion)}`);
  }
  if (!MUTATION_TYPES.has(mutation.type)) {
    throw storedDataError('mutation journal', 'type is not supported');
  }
  if (typeof mutation.startedAt !== 'string' || Number.isNaN(Date.parse(mutation.startedAt))) {
    throw storedDataError('mutation journal', 'startedAt must be a valid timestamp');
  }
  if (!mutation.payload || typeof mutation.payload !== 'object' || Array.isArray(mutation.payload)) {
    throw storedDataError('mutation journal', 'payload must be an object');
  }

  if (mutation.type === 'trash-session') {
    assertJournalId(mutation.payload.sessionId, SESSION_ID_PATTERN, 'payload.sessionId');
    assertJournalId(mutation.payload.sourceDateDir, DATE_DIR_PATTERN, 'payload.sourceDateDir');
  } else if (mutation.type === 'restore-session') {
    assertJournalId(mutation.payload.sessionId, SESSION_ID_PATTERN, 'payload.sessionId');
    assertJournalId(mutation.payload.restoreDate, DATE_DIR_PATTERN, 'payload.restoreDate');
  } else if (mutation.type === 'delete-folder') {
    assertJournalId(mutation.payload.folderId, FOLDER_ID_PATTERN, 'payload.folderId');
  } else if (mutation.type === 'permanent-delete-trash') {
    assertJournalId(mutation.payload.sessionId, SESSION_ID_PATTERN, 'payload.sessionId');
  }

  return mutation;
}

async function readPendingMutation() {
  try {
    return validateMutationJournal(await readJson(MUTATION_JOURNAL_FILE));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw storedDataError('mutation journal', `${path.basename(MUTATION_JOURNAL_FILE)} contains malformed JSON`);
    }
    throw error;
  }
}

async function removeJournal() {
  try {
    await unlinkDataFile(MUTATION_JOURNAL_FILE, { missingOk: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readSessionIfExists(filePath, options) {
  try {
    return await readSessionRecord(filePath, options);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readDirectoryEntries(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function folderExistsUnlocked(folderId) {
  if (!folderId) return true;
  const document = await readFoldersDocument(FOLDERS_FILE);
  return document.folders.some((folder) => folder.id === folderId);
}

async function removeFolderRecord(folderId) {
  await withLock(FOLDERS_FILE, async () => {
    const document = await readFoldersDocument(FOLDERS_FILE);
    document.folders = document.folders.filter((folder) => folder.id !== folderId);
    await writeJson(FOLDERS_FILE, document);
  });
}

async function unpinFolderInDirectory(dirPath, folderId, { trashed = false } = {}) {
  const entries = await readDirectoryEntries(dirPath);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(dirPath, entry.name);
    await withLock(filePath, async () => {
      const session = await readSessionIfExists(filePath, { trashed });
      if (!session || session.pinnedFolderId !== folderId) return;
      session.pinnedFolderId = null;
      session.updatedAt = new Date().toISOString();
      await writeJson(filePath, session);
    });
  }
}

async function unpinFolderReferences(folderId) {
  const dateDirs = await listDateDirs();
  for (const dateDir of dateDirs) {
    await unpinFolderInDirectory(path.join(DATA_DIR, dateDir), folderId);
  }
  await unpinFolderInDirectory(TRASH_DIR, folderId, { trashed: true });
}

async function applyTrashSession(mutation) {
  const { sessionId, sourceDateDir } = mutation.payload;
  const sourceFile = path.join(DATA_DIR, sourceDateDir, `${sessionId}.json`);
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);

  return withLock(sourceFile, async () => {
    const trashSession = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
    let sourceSession = await readSessionIfExists(sourceFile, { expectedId: sessionId, trashed: false });

    if (!trashSession && !sourceSession) {
      throw storedDataError('mutation journal', `session ${sessionId} is missing from active and trash storage`);
    }

    if (!trashSession && sourceSession) {
      sourceSession = { ...sourceSession, deletedAt: mutation.startedAt };
      await writeJson(trashFile, sourceSession);
      await checkpoint('trash-session:after-trash-write', mutation);
    }

    if (await unlinkDataFile(sourceFile, { missingOk: true })) {
      await checkpoint('trash-session:after-source-delete', mutation);
    }
    await clearActiveSessionIf(sessionId);
    await checkpoint('trash-session:after-state-clear', mutation);
  });
}

async function normalizeRestoredFolderReference(session) {
  return withLock(FOLDERS_FILE, async () => {
    if (session.pinnedFolderId && !(await folderExistsUnlocked(session.pinnedFolderId))) {
      session.pinnedFolderId = null;
    }
    return session;
  });
}

async function applyRestoreSession(mutation) {
  const { sessionId, restoreDate } = mutation.payload;
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
  const destinationFile = path.join(DATA_DIR, restoreDate, `${sessionId}.json`);

  return withLock(trashFile, async () =>
    withLock(destinationFile, async () => {
      const activeSession = await readSessionIfExists(destinationFile, { expectedId: sessionId, trashed: false });
      const trashSession = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });

      if (!activeSession && !trashSession) {
        throw storedDataError('mutation journal', `session ${sessionId} is missing from active and trash storage`);
      }

      let restored = activeSession;
      if (!restored && trashSession) {
        restored = await normalizeRestoredFolderReference({ ...trashSession });
        delete restored.deletedAt;
        restored.updatedAt = mutation.startedAt;
        await writeJson(destinationFile, restored);
        await checkpoint('restore-session:after-active-write', mutation);
      }

      if (await unlinkDataFile(trashFile, { missingOk: true })) {
        await checkpoint('restore-session:after-trash-delete', mutation);
      }

      return restored;
    })
  );
}

async function applyDeleteFolder(mutation) {
  const { folderId } = mutation.payload;
  await removeFolderRecord(folderId);
  await checkpoint('delete-folder:after-folder-delete', mutation);
  await unpinFolderReferences(folderId);
  await checkpoint('delete-folder:after-session-cleanup', mutation);
}

async function applyPermanentDeleteTrash(mutation) {
  const { sessionId } = mutation.payload;
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
  await withLock(trashFile, async () => {
    if (await unlinkDataFile(trashFile, { missingOk: true })) {
      await checkpoint('permanent-delete-trash:after-trash-delete', mutation);
    }
    await clearActiveSessionIf(sessionId);
    await checkpoint('permanent-delete-trash:after-state-clear', mutation);
  });
}

async function applyMutation(mutation) {
  if (mutation.type === 'trash-session') return applyTrashSession(mutation);
  if (mutation.type === 'restore-session') return applyRestoreSession(mutation);
  if (mutation.type === 'delete-folder') return applyDeleteFolder(mutation);
  if (mutation.type === 'permanent-delete-trash') return applyPermanentDeleteTrash(mutation);
  throw storedDataError('mutation journal', `unsupported operation ${mutation.type}`);
}

async function recoverPendingMutationUnlocked() {
  const pending = await readPendingMutation();
  if (!pending) return null;
  const result = await applyMutation(pending);
  await removeJournal();
  return { mutation: pending, result };
}

async function recoverPendingMutation() {
  await ensureBaseFiles();
  return withLock(GLOBAL_MUTATION_LOCK, recoverPendingMutationUnlocked);
}

async function withMutationConsistency(task) {
  await ensureBaseFiles();
  return withLock(GLOBAL_MUTATION_LOCK, async () => {
    await recoverPendingMutationUnlocked();
    return task();
  });
}

async function runRecoverableMutation(type, payloadOrFactory, apply = applyMutation) {
  await ensureBaseFiles();
  return withLock(GLOBAL_MUTATION_LOCK, async () => {
    await recoverPendingMutationUnlocked();
    const payload = typeof payloadOrFactory === 'function' ? await payloadOrFactory() : payloadOrFactory;
    const mutation = validateMutationJournal({
      journalVersion: JOURNAL_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      type,
      startedAt: new Date().toISOString(),
      payload
    });
    await writeJson(MUTATION_JOURNAL_FILE, mutation);
    await checkpoint(`${type}:after-journal-write`, mutation);
    const result = await apply(mutation);
    await removeJournal();
    return result;
  });
}

async function moveSessionToTrashRecoverably(sessionId, sourceDateDir) {
  return runRecoverableMutation('trash-session', async () => {
    const sourceFile = path.join(DATA_DIR, sourceDateDir, `${sessionId}.json`);
    const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
    const sourceSession = await readSessionIfExists(sourceFile, { expectedId: sessionId, trashed: false });
    if (!sourceSession) throw appError(404, 'Session not found.');
    const trashSession = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
    if (trashSession) throw appError(409, 'Session already exists in trash.');
    return { sessionId, sourceDateDir };
  });
}

async function restoreSessionRecoverably(sessionId) {
  return runRecoverableMutation('restore-session', async () => ({
    sessionId,
    restoreDate: await prepareRestoreDate(sessionId)
  }));
}

async function deleteFolderRecoverably(folderId) {
  return runRecoverableMutation('delete-folder', { folderId });
}

async function permanentlyDeleteTrashRecoverably(sessionId) {
  return runRecoverableMutation('permanent-delete-trash', async () => {
    const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
    const session = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
    if (!session) throw appError(404, 'Trashed session not found.');
    return { sessionId };
  });
}

async function prepareRestoreDate(sessionId) {
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
  const session = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
  if (!session) throw appError(404, 'Trashed session not found.');
  const active = await findSessionFile(sessionId);
  if (active) throw appError(409, 'Session already exists outside trash.');
  return dateFolderName(new Date(session.createdAt));
}

function setMutationFailureInjectorForTests(injector) {
  failureInjectorForTests = typeof injector === 'function' ? injector : null;
}

module.exports = {
  recoverPendingMutation,
  withMutationConsistency,
  moveSessionToTrashRecoverably,
  restoreSessionRecoverably,
  deleteFolderRecoverably,
  permanentlyDeleteTrashRecoverably,
  setMutationFailureInjectorForTests
};
