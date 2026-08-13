const fs = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  TRASH_DIR,
  FOLDERS_FILE,
  MUTATION_JOURNAL_FILE,
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN,
  DATE_DIR_PATTERN,
  COMPACTION_REQUEST_ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_FINGERPRINT_PATTERN,
  CURRENT_SCHEMA_VERSION,
  CURRENT_SESSION_SCHEMA_VERSION
} = require('../config');
const { appError } = require('../errors');
const { id, dateFolderName } = require('../ids');
const { compactedTitleFor } = require('../services/session-format');
const { bindExistingMessageToPayload } = require('../services/message-idempotency');
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
const MUTATION_TYPES = new Set([
  'trash-session',
  'restore-session',
  'delete-folder',
  'permanent-delete-trash',
  'upsert-compaction',
  'mirror-compacted-message',
  'sync-session-metadata',
  'compacted-session-lifecycle'
]);

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

function assertJournalString(value, label, maxLength, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw storedDataError(
      'mutation journal',
      `${label} must be a non-empty string no longer than ${maxLength} characters`
    );
  }
}

function assertJournalTimestamp(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw storedDataError('mutation journal', `${label} must be a valid timestamp`);
  }
}

function validateMirroredMessageMutationPayload(payload) {
  assertJournalId(payload.parentSessionId, SESSION_ID_PATTERN, 'payload.parentSessionId');
  assertJournalId(payload.childSessionId, SESSION_ID_PATTERN, 'payload.childSessionId');
  if (payload.parentSessionId === payload.childSessionId) {
    throw storedDataError('mutation journal', 'mirrored message parent and child IDs must be different');
  }
  assertJournalId(payload.parentDateDir, DATE_DIR_PATTERN, 'payload.parentDateDir');
  assertJournalId(payload.childDateDir, DATE_DIR_PATTERN, 'payload.childDateDir');
  if (typeof payload.mirrorToChild !== 'boolean') {
    throw storedDataError('mutation journal', 'payload.mirrorToChild must be a boolean');
  }
  if (typeof payload.created !== 'boolean') {
    throw storedDataError('mutation journal', 'payload.created must be a boolean');
  }

  const message = payload.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw storedDataError('mutation journal', 'payload.message must be an object');
  }
  assertJournalId(message.id, MESSAGE_ID_PATTERN, 'payload.message.id');
  if (message.sender !== 'me' && message.sender !== 'bot') {
    throw storedDataError('mutation journal', 'payload.message.sender must be "me" or "bot"');
  }
  assertJournalString(message.text, 'payload.message.text', 2_000_000);
  assertJournalTimestamp(message.createdAt, 'payload.message.createdAt');
  assertJournalTimestamp(message.updatedAt, 'payload.message.updatedAt', { optional: true });
  if (message.clientIdempotencyKey !== undefined) {
    assertJournalId(message.clientIdempotencyKey, IDEMPOTENCY_KEY_PATTERN, 'payload.message.clientIdempotencyKey');
  }
  if (message.clientIdempotencyFingerprint !== undefined) {
    assertJournalId(
      message.clientIdempotencyFingerprint,
      IDEMPOTENCY_FINGERPRINT_PATTERN,
      'payload.message.clientIdempotencyFingerprint'
    );
    if (!message.clientIdempotencyKey) {
      throw storedDataError(
        'mutation journal',
        'payload.message.clientIdempotencyFingerprint requires a clientIdempotencyKey'
      );
    }
  }
  assertJournalString(message.source, 'payload.message.source', 80, { optional: true });
  assertJournalString(message.providerKey, 'payload.message.providerKey', 80, { optional: true });
}

function validateCompactionMutationPayload(payload) {
  assertJournalId(payload.parentSessionId, SESSION_ID_PATTERN, 'payload.parentSessionId');
  assertJournalId(payload.childSessionId, SESSION_ID_PATTERN, 'payload.childSessionId');
  if (payload.parentSessionId === payload.childSessionId) {
    throw storedDataError('mutation journal', 'compaction parent and child IDs must be different');
  }
  assertJournalId(payload.parentDateDir, DATE_DIR_PATTERN, 'payload.parentDateDir');
  assertJournalId(payload.childDateDir, DATE_DIR_PATTERN, 'payload.childDateDir');

  if (!payload.compaction || typeof payload.compaction !== 'object' || Array.isArray(payload.compaction)) {
    throw storedDataError('mutation journal', 'payload.compaction must be an object');
  }
  assertJournalString(payload.compaction.text, 'payload.compaction.text', 2_000_000);
  assertJournalId(payload.compaction.requestId, COMPACTION_REQUEST_ID_PATTERN, 'payload.compaction.requestId');
  assertJournalString(payload.compaction.providerKey, 'payload.compaction.providerKey', 80, { optional: true });
  if (!Number.isInteger(payload.compaction.sourceMessageCount) || payload.compaction.sourceMessageCount < 1) {
    throw storedDataError('mutation journal', 'payload.compaction.sourceMessageCount must be a positive integer');
  }
  assertJournalId(payload.compaction.throughMessageId, MESSAGE_ID_PATTERN, 'payload.compaction.throughMessageId');
}


const COMPACTED_LIFECYCLE_ACTIONS = new Set([
  'trash-pair',
  'trash-child',
  'restore-pair',
  'restore-child',
  'delete-pair',
  'delete-child'
]);

function validateSessionLocation(payload, prefix, { required = true } = {}) {
  const location = payload[`${prefix}Location`];
  if (!required && location === undefined) return;
  if (location !== 'active' && location !== 'trash') {
    throw storedDataError('mutation journal', `payload.${prefix}Location must be "active" or "trash"`);
  }
  const dateDir = payload[`${prefix}DateDir`];
  if (location === 'active') {
    assertJournalId(dateDir, DATE_DIR_PATTERN, `payload.${prefix}DateDir`);
  } else if (dateDir !== null && dateDir !== undefined) {
    throw storedDataError('mutation journal', `payload.${prefix}DateDir must be null for trash storage`);
  }
}

function validateSessionMetadataMutationPayload(payload) {
  assertJournalId(payload.targetSessionId, SESSION_ID_PATTERN, 'payload.targetSessionId');
  assertJournalId(payload.parentSessionId, SESSION_ID_PATTERN, 'payload.parentSessionId');
  validateSessionLocation(payload, 'parent');

  if (payload.childSessionId !== null && payload.childSessionId !== undefined) {
    assertJournalId(payload.childSessionId, SESSION_ID_PATTERN, 'payload.childSessionId');
    if (payload.childSessionId === payload.parentSessionId) {
      throw storedDataError('mutation journal', 'metadata parent and child IDs must be different');
    }
    validateSessionLocation(payload, 'child');
  } else {
    if (payload.childLocation !== undefined || payload.childDateDir !== undefined) {
      throw storedDataError('mutation journal', 'child location requires payload.childSessionId');
    }
  }

  const updates = payload.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw storedDataError('mutation journal', 'payload.updates must be an object');
  }
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.some((key) => !['title', 'aiName', 'pinnedFolderId'].includes(key))) {
    throw storedDataError('mutation journal', 'payload.updates contains unsupported metadata fields');
  }
  assertJournalString(updates.title, 'payload.updates.title', 160, { optional: true });
  assertJournalString(updates.aiName, 'payload.updates.aiName', 80, { optional: true });
  if (updates.pinnedFolderId !== undefined && updates.pinnedFolderId !== null) {
    assertJournalId(updates.pinnedFolderId, FOLDER_ID_PATTERN, 'payload.updates.pinnedFolderId');
  }
}

function validateCompactedLifecycleMutationPayload(payload) {
  if (!COMPACTED_LIFECYCLE_ACTIONS.has(payload.action)) {
    throw storedDataError('mutation journal', 'payload.action is not a supported compacted lifecycle action');
  }
  assertJournalId(payload.parentSessionId, SESSION_ID_PATTERN, 'payload.parentSessionId');
  assertJournalId(payload.childSessionId, SESSION_ID_PATTERN, 'payload.childSessionId');
  if (payload.parentSessionId === payload.childSessionId) {
    throw storedDataError('mutation journal', 'lifecycle parent and child IDs must be different');
  }

  if (payload.action === 'restore-pair' || payload.action === 'restore-child') {
    assertJournalId(payload.requestedSessionId, SESSION_ID_PATTERN, 'payload.requestedSessionId');
    if (
      payload.requestedSessionId !== payload.parentSessionId &&
      payload.requestedSessionId !== payload.childSessionId
    ) {
      throw storedDataError('mutation journal', 'payload.requestedSessionId must reference the lifecycle pair');
    }
  }

  if (payload.action === 'trash-pair') {
    validateSessionLocation(payload, 'parent');
    validateSessionLocation(payload, 'child');
    if (payload.parentLocation !== 'active') {
      throw storedDataError('mutation journal', 'trash-pair parent must be active');
    }
  } else if (payload.action === 'trash-child') {
    validateSessionLocation(payload, 'parent');
    validateSessionLocation(payload, 'child');
    if (payload.childLocation !== 'active') {
      throw storedDataError('mutation journal', 'trash-child target must be active');
    }
  } else if (payload.action === 'restore-pair') {
    assertJournalId(payload.parentRestoreDate, DATE_DIR_PATTERN, 'payload.parentRestoreDate');
    assertJournalId(payload.childRestoreDate, DATE_DIR_PATTERN, 'payload.childRestoreDate');
  } else if (payload.action === 'restore-child') {
    validateSessionLocation(payload, 'parent');
    if (payload.parentLocation !== 'active') {
      throw storedDataError('mutation journal', 'restore-child parent must be active');
    }
    assertJournalId(payload.childRestoreDate, DATE_DIR_PATTERN, 'payload.childRestoreDate');
  } else if (payload.action === 'delete-child') {
    validateSessionLocation(payload, 'parent', { required: false });
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
  } else if (mutation.type === 'upsert-compaction') {
    validateCompactionMutationPayload(mutation.payload);
  } else if (mutation.type === 'mirror-compacted-message') {
    validateMirroredMessageMutationPayload(mutation.payload);
  } else if (mutation.type === 'sync-session-metadata') {
    validateSessionMetadataMutationPayload(mutation.payload);
  } else if (mutation.type === 'compacted-session-lifecycle') {
    validateCompactedLifecycleMutationPayload(mutation.payload);
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

function sameCompactionPayload(left, right) {
  return (
    left?.requestId === right?.requestId &&
    left?.text === right?.text &&
    (left?.providerKey || '') === (right?.providerKey || '') &&
    left?.sourceMessageCount === right?.sourceMessageCount &&
    left?.throughMessageId === right?.throughMessageId
  );
}

async function withOrderedLocks(filePaths, task) {
  const ordered = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].sort();
  const run = async (index) => {
    if (index >= ordered.length) return task();
    return withLock(ordered[index], () => run(index + 1));
  };
  return run(0);
}

function sessionLocation(found) {
  return found.trashed ? 'trash' : 'active';
}

function sessionFileForLocation(sessionId, location, dateDir) {
  return location === 'trash'
    ? path.join(TRASH_DIR, `${sessionId}.json`)
    : path.join(DATA_DIR, dateDir, `${sessionId}.json`);
}

async function readFoundSessionForLifecycle(found, sessionId) {
  return readSessionRecord(found.filePath, { expectedId: sessionId, trashed: found.trashed });
}

function addLocationPayload(payload, prefix, found) {
  payload[`${prefix}Location`] = sessionLocation(found);
  payload[`${prefix}DateDir`] = found.trashed ? null : found.dateDir;
}

async function prepareSessionMetadataPayload(sessionId, updates) {
  const targetFound = await findSessionFile(sessionId, true);
  if (!targetFound) throw appError(404, 'Session not found.');
  const target = await readFoundSessionForLifecycle(targetFound, sessionId);

  let parent = target;
  let parentFound = targetFound;
  let child = null;
  let childFound = null;

  if (target.kind === 'compacted') {
    if (updates.title !== undefined) {
      throw appError(409, 'Compacted session titles are derived from their parent session.');
    }
    parentFound = await findSessionFile(target.parentSessionId, true);
    if (!parentFound) throw storedDataError('session', 'compacted session parent is missing');
    parent = await readFoundSessionForLifecycle(parentFound, target.parentSessionId);
    if (parent.kind !== 'normal' || parent.compactedSessionId !== target.id) {
      throw storedDataError('session', 'compacted session relationship is inconsistent');
    }
    child = target;
    childFound = targetFound;
  } else if (target.compactedSessionId) {
    childFound = await findSessionFile(target.compactedSessionId, true);
    if (!childFound) throw storedDataError('session', 'compacted session child is missing');
    child = await readFoundSessionForLifecycle(childFound, target.compactedSessionId);
    if (child.kind !== 'compacted' || child.parentSessionId !== target.id) {
      throw storedDataError('session', 'compacted session relationship is inconsistent');
    }
  }

  if (updates.pinnedFolderId) {
    await withLock(FOLDERS_FILE, async () => {
      if (!(await folderExistsUnlocked(updates.pinnedFolderId))) throw appError(404, 'Folder not found.');
    });
  }

  const payload = {
    targetSessionId: target.id,
    parentSessionId: parent.id,
    childSessionId: child?.id || null,
    updates: { ...updates }
  };
  addLocationPayload(payload, 'parent', parentFound);
  if (childFound) addLocationPayload(payload, 'child', childFound);
  return payload;
}

async function applySyncSessionMetadata(mutation) {
  const {
    targetSessionId,
    parentSessionId,
    childSessionId,
    parentLocation,
    parentDateDir,
    childLocation,
    childDateDir,
    updates
  } = mutation.payload;
  const parentFile = sessionFileForLocation(parentSessionId, parentLocation, parentDateDir);
  const childFile = childSessionId ? sessionFileForLocation(childSessionId, childLocation, childDateDir) : null;

  return withOrderedLocks(childFile ? [parentFile, childFile] : [parentFile], async () => {
    const parent = await readSessionIfExists(parentFile, {
      expectedId: parentSessionId,
      trashed: parentLocation === 'trash'
    });
    if (!parent || parent.kind !== 'normal') {
      throw storedDataError('mutation journal', 'metadata parent session is missing or invalid');
    }

    let child = null;
    if (childSessionId) {
      child = await readSessionIfExists(childFile, {
        expectedId: childSessionId,
        trashed: childLocation === 'trash'
      });
      if (!child || child.kind !== 'compacted' || child.parentSessionId !== parent.id) {
        throw storedDataError('mutation journal', 'metadata compacted session relationship is inconsistent');
      }
      if (parent.compactedSessionId !== child.id) {
        throw storedDataError('mutation journal', 'metadata parent does not reference its compacted session');
      }
    }

    if (updates.title !== undefined) parent.title = updates.title;
    if (updates.aiName !== undefined) parent.aiName = updates.aiName;
    if (updates.pinnedFolderId !== undefined) parent.pinnedFolderId = updates.pinnedFolderId;
    parent.updatedAt = mutation.startedAt;
    await writeJson(parentFile, parent);
    await checkpoint('sync-session-metadata:after-parent-write', mutation);

    if (child) {
      child.title = compactedTitleFor(parent.title);
      child.aiName = parent.aiName;
      child.pinnedFolderId = parent.pinnedFolderId || null;
      child.updatedAt = mutation.startedAt;
      await writeJson(childFile, child);
      await checkpoint('sync-session-metadata:after-child-write', mutation);
    }

    return {
      session: targetSessionId === childSessionId ? child : parent,
      dateDir: targetSessionId === childSessionId ? childDateDir : parentDateDir,
      trashed: targetSessionId === childSessionId ? childLocation === 'trash' : parentLocation === 'trash'
    };
  });
}

async function prepareTrashMutationPlan(sessionId, sourceDateDir) {
  const sourceFile = path.join(DATA_DIR, sourceDateDir, `${sessionId}.json`);
  const target = await readSessionIfExists(sourceFile, { expectedId: sessionId, trashed: false });
  if (!target) throw appError(404, 'Session not found.');
  const existingTrash = await readSessionIfExists(path.join(TRASH_DIR, `${sessionId}.json`), {
    expectedId: sessionId,
    trashed: true
  });
  if (existingTrash) throw appError(409, 'Session already exists in trash.');

  if (target.kind === 'normal' && !target.compactedSessionId) {
    return { type: 'trash-session', payload: { sessionId, sourceDateDir } };
  }

  if (target.kind === 'normal') {
    const childFound = await findSessionFile(target.compactedSessionId, true);
    if (!childFound) throw storedDataError('session', 'compacted session child is missing');
    const child = await readFoundSessionForLifecycle(childFound, target.compactedSessionId);
    if (child.kind !== 'compacted' || child.parentSessionId !== target.id) {
      throw storedDataError('session', 'compacted session relationship is inconsistent');
    }
    if (!childFound.trashed) {
      const childTrash = await readSessionIfExists(path.join(TRASH_DIR, `${child.id}.json`), {
        expectedId: child.id,
        trashed: true
      });
      if (childTrash) throw appError(409, 'Compacted session already exists in trash.');
    }
    const payload = {
      action: 'trash-pair',
      parentSessionId: target.id,
      childSessionId: child.id
    };
    addLocationPayload(payload, 'parent', { trashed: false, dateDir: sourceDateDir });
    addLocationPayload(payload, 'child', childFound);
    return { type: 'compacted-session-lifecycle', payload };
  }

  const parentFound = await findSessionFile(target.parentSessionId, true);
  if (!parentFound) throw storedDataError('session', 'compacted session parent is missing');
  const parent = await readFoundSessionForLifecycle(parentFound, target.parentSessionId);
  if (parent.kind !== 'normal' || parent.compactedSessionId !== target.id) {
    throw storedDataError('session', 'compacted session relationship is inconsistent');
  }
  const payload = {
    action: 'trash-child',
    parentSessionId: parent.id,
    childSessionId: target.id
  };
  addLocationPayload(payload, 'parent', parentFound);
  addLocationPayload(payload, 'child', { trashed: false, dateDir: sourceDateDir });
  return { type: 'compacted-session-lifecycle', payload };
}

function restoreDateForSession(session) {
  return dateFolderName(new Date(session.createdAt));
}

async function prepareRestoreMutationPlan(sessionId) {
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
  const target = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
  if (!target) throw appError(404, 'Trashed session not found.');
  if (await findSessionFile(sessionId)) throw appError(409, 'Session already exists outside trash.');

  if (target.kind === 'normal' && !target.compactedSessionId) {
    return {
      type: 'restore-session',
      payload: { sessionId, restoreDate: restoreDateForSession(target) }
    };
  }

  if (target.kind === 'normal') {
    const childFound = await findSessionFile(target.compactedSessionId, true);
    if (!childFound) throw storedDataError('session', 'compacted session child is missing');
    const child = await readFoundSessionForLifecycle(childFound, target.compactedSessionId);
    if (child.kind !== 'compacted' || child.parentSessionId !== target.id) {
      throw storedDataError('session', 'compacted session relationship is inconsistent');
    }
    if (!childFound.trashed) {
      return {
        type: 'restore-session',
        payload: { sessionId, restoreDate: restoreDateForSession(target) }
      };
    }
    return {
      type: 'compacted-session-lifecycle',
      payload: {
        action: 'restore-pair',
        requestedSessionId: target.id,
        parentSessionId: target.id,
        childSessionId: child.id,
        parentRestoreDate: restoreDateForSession(target),
        childRestoreDate: restoreDateForSession(child)
      }
    };
  }

  const parentFound = await findSessionFile(target.parentSessionId, true);
  if (!parentFound) throw appError(409, 'Cannot restore compacted session because its parent is missing.');
  const parent = await readFoundSessionForLifecycle(parentFound, target.parentSessionId);
  if (parent.kind !== 'normal') throw storedDataError('session', 'compacted session parent is invalid');

  if (parentFound.trashed) {
    if (parent.compactedSessionId !== target.id) {
      throw appError(409, 'Cannot restore compacted session because its parent no longer references it.');
    }
    return {
      type: 'compacted-session-lifecycle',
      payload: {
        action: 'restore-pair',
        requestedSessionId: target.id,
        parentSessionId: parent.id,
        childSessionId: target.id,
        parentRestoreDate: restoreDateForSession(parent),
        childRestoreDate: restoreDateForSession(target)
      }
    };
  }

  if (parent.compactedSessionId && parent.compactedSessionId !== target.id) {
    throw appError(409, 'Parent session already has a different compacted session.');
  }
  const payload = {
    action: 'restore-child',
    requestedSessionId: target.id,
    parentSessionId: parent.id,
    childSessionId: target.id,
    childRestoreDate: restoreDateForSession(target)
  };
  addLocationPayload(payload, 'parent', parentFound);
  return { type: 'compacted-session-lifecycle', payload };
}

async function preparePermanentDeleteMutationPlan(sessionId) {
  const trashFile = path.join(TRASH_DIR, `${sessionId}.json`);
  const target = await readSessionIfExists(trashFile, { expectedId: sessionId, trashed: true });
  if (!target) throw appError(404, 'Trashed session not found.');

  if (target.kind === 'normal' && !target.compactedSessionId) {
    return { type: 'permanent-delete-trash', payload: { sessionId } };
  }

  if (target.kind === 'normal') {
    const childFound = await findSessionFile(target.compactedSessionId, true);
    if (!childFound) return { type: 'permanent-delete-trash', payload: { sessionId } };
    if (!childFound.trashed) {
      throw appError(409, 'Cannot permanently delete a parent while its compacted session is active.');
    }
    const child = await readFoundSessionForLifecycle(childFound, target.compactedSessionId);
    if (child.kind !== 'compacted' || child.parentSessionId !== target.id) {
      throw storedDataError('session', 'compacted session relationship is inconsistent');
    }
    return {
      type: 'compacted-session-lifecycle',
      payload: {
        action: 'delete-pair',
        parentSessionId: target.id,
        childSessionId: child.id
      }
    };
  }

  const parentFound = await findSessionFile(target.parentSessionId, true);
  const payload = {
    action: 'delete-child',
    parentSessionId: target.parentSessionId,
    childSessionId: target.id
  };
  if (parentFound) {
    const parent = await readFoundSessionForLifecycle(parentFound, target.parentSessionId);
    if (parent.kind !== 'normal') throw storedDataError('session', 'compacted session parent is invalid');
    if (parent.compactedSessionId === target.id) addLocationPayload(payload, 'parent', parentFound);
  }
  return { type: 'compacted-session-lifecycle', payload };
}

async function syncCompactedChildMetadata(parent, child, childFile, mutation) {
  child.title = compactedTitleFor(parent.title);
  child.aiName = parent.aiName;
  child.pinnedFolderId = parent.pinnedFolderId || null;
  child.updatedAt = mutation.startedAt;
  await writeJson(childFile, child);
}

async function applyCompactedSessionLifecycle(mutation) {
  const payload = mutation.payload;
  const { action, parentSessionId, childSessionId } = payload;

  if (action === 'trash-pair') {
    await applyTrashSession({
      ...mutation,
      payload: { sessionId: parentSessionId, sourceDateDir: payload.parentDateDir }
    });
    await checkpoint('compacted-lifecycle:after-parent-trash', mutation);
    if (payload.childLocation === 'active') {
      await applyTrashSession({
        ...mutation,
        payload: { sessionId: childSessionId, sourceDateDir: payload.childDateDir }
      });
    }
    await checkpoint('compacted-lifecycle:after-child-trash', mutation);
    return;
  }

  if (action === 'trash-child') {
    await applyTrashSession({
      ...mutation,
      payload: { sessionId: childSessionId, sourceDateDir: payload.childDateDir }
    });
    await checkpoint('compacted-lifecycle:after-child-trash', mutation);
    const parentFile = sessionFileForLocation(parentSessionId, payload.parentLocation, payload.parentDateDir);
    await withLock(parentFile, async () => {
      const parent = await readSessionIfExists(parentFile, {
        expectedId: parentSessionId,
        trashed: payload.parentLocation === 'trash'
      });
      if (!parent) throw storedDataError('mutation journal', 'compacted session parent is missing');
      if (parent.compactedSessionId === childSessionId) {
        parent.compactedSessionId = null;
        parent.updatedAt = mutation.startedAt;
        await writeJson(parentFile, parent);
      }
    });
    await checkpoint('compacted-lifecycle:after-parent-detach', mutation);
    return;
  }

  if (action === 'restore-pair') {
    const parent = await applyRestoreSession({
      ...mutation,
      payload: { sessionId: parentSessionId, restoreDate: payload.parentRestoreDate }
    });
    await checkpoint('compacted-lifecycle:after-parent-restore', mutation);
    const child = await applyRestoreSession({
      ...mutation,
      payload: { sessionId: childSessionId, restoreDate: payload.childRestoreDate }
    });
    await checkpoint('compacted-lifecycle:after-child-restore', mutation);

    const parentFile = path.join(DATA_DIR, payload.parentRestoreDate, `${parentSessionId}.json`);
    const childFile = path.join(DATA_DIR, payload.childRestoreDate, `${childSessionId}.json`);
    const restoredTarget = await withOrderedLocks([parentFile, childFile], async () => {
      const storedParent = await readSessionIfExists(parentFile, { expectedId: parentSessionId, trashed: false });
      const storedChild = await readSessionIfExists(childFile, { expectedId: childSessionId, trashed: false });
      if (!storedParent || !storedChild) {
        throw storedDataError('mutation journal', 'restored compacted pair is incomplete');
      }
      storedParent.compactedSessionId = childSessionId;
      storedParent.updatedAt = mutation.startedAt;
      await writeJson(parentFile, storedParent);
      await syncCompactedChildMetadata(storedParent, storedChild, childFile, mutation);
      return payload.requestedSessionId === childSessionId ? storedChild : storedParent;
    });
    await checkpoint('compacted-lifecycle:after-pair-sync', mutation);
    return restoredTarget;
  }

  if (action === 'restore-child') {
    await applyRestoreSession({
      ...mutation,
      payload: { sessionId: childSessionId, restoreDate: payload.childRestoreDate }
    });
    await checkpoint('compacted-lifecycle:after-child-restore', mutation);
    const parentFile = sessionFileForLocation(parentSessionId, payload.parentLocation, payload.parentDateDir);
    const childFile = path.join(DATA_DIR, payload.childRestoreDate, `${childSessionId}.json`);
    return withOrderedLocks([parentFile, childFile], async () => {
      const parent = await readSessionIfExists(parentFile, { expectedId: parentSessionId, trashed: false });
      const child = await readSessionIfExists(childFile, { expectedId: childSessionId, trashed: false });
      if (!parent || !child) throw storedDataError('mutation journal', 'restored compacted relationship is incomplete');
      if (parent.compactedSessionId && parent.compactedSessionId !== childSessionId) {
        throw storedDataError('mutation journal', 'parent references a different compacted session');
      }
      parent.compactedSessionId = childSessionId;
      parent.updatedAt = mutation.startedAt;
      await writeJson(parentFile, parent);
      await syncCompactedChildMetadata(parent, child, childFile, mutation);
      await checkpoint('compacted-lifecycle:after-parent-reattach', mutation);
      return child;
    });
  }

  if (action === 'delete-pair') {
    await applyPermanentDeleteTrash({ ...mutation, payload: { sessionId: childSessionId } });
    await checkpoint('compacted-lifecycle:after-child-delete', mutation);
    await applyPermanentDeleteTrash({ ...mutation, payload: { sessionId: parentSessionId } });
    await checkpoint('compacted-lifecycle:after-parent-delete', mutation);
    return;
  }

  if (action === 'delete-child') {
    await applyPermanentDeleteTrash({ ...mutation, payload: { sessionId: childSessionId } });
    await checkpoint('compacted-lifecycle:after-child-delete', mutation);
    if (payload.parentLocation) {
      const parentFile = sessionFileForLocation(parentSessionId, payload.parentLocation, payload.parentDateDir);
      await withLock(parentFile, async () => {
        const parent = await readSessionIfExists(parentFile, {
          expectedId: parentSessionId,
          trashed: payload.parentLocation === 'trash'
        });
        if (parent?.compactedSessionId === childSessionId) {
          parent.compactedSessionId = null;
          parent.updatedAt = mutation.startedAt;
          await writeJson(parentFile, parent);
        }
      });
    }
    await checkpoint('compacted-lifecycle:after-parent-detach', mutation);
    return;
  }

  throw storedDataError('mutation journal', `unsupported compacted lifecycle action ${action}`);
}

function nextMessageSender(messages) {
  const lastSender = messages.at(-1)?.sender;
  if (lastSender === 'me') return 'bot';
  if (lastSender === 'bot') return 'me';
  return 'me';
}

function cloneMessage(message) {
  return { ...message };
}

function ensureMirroredMessage(session, message) {
  const idempotencyKey = message.clientIdempotencyKey;
  const existing = idempotencyKey
    ? session.messages.find((item) => item.clientIdempotencyKey === idempotencyKey)
    : session.messages.find((item) => item.id === message.id);

  if (existing) {
    if (existing.id !== message.id) {
      throw storedDataError('mutation journal', `message ${message.id} conflicts with an existing mirrored message`);
    }
    if (message.clientIdempotencyFingerprint) {
      if (
        existing.clientIdempotencyFingerprint &&
        existing.clientIdempotencyFingerprint !== message.clientIdempotencyFingerprint
      ) {
        throw storedDataError('mutation journal', `message ${message.id} has a conflicting idempotency fingerprint`);
      }
      if (!existing.clientIdempotencyFingerprint) {
        existing.clientIdempotencyFingerprint = message.clientIdempotencyFingerprint;
        return { message: existing, changed: true };
      }
    } else if (
      existing.sender !== message.sender ||
      existing.text !== message.text ||
      existing.createdAt !== message.createdAt ||
      (existing.source || '') !== (message.source || '') ||
      (existing.providerKey || '') !== (message.providerKey || '')
    ) {
      throw storedDataError('mutation journal', `message ${message.id} conflicts with stored message data`);
    }
    return { message: existing, changed: false };
  }

  if (session.messages.some((item) => item.id === message.id)) {
    throw storedDataError('mutation journal', `message id ${message.id} is already used by another message`);
  }

  const appended = cloneMessage(message);
  session.messages.push(appended);
  return { message: appended, changed: true };
}

async function applyMirrorCompactedMessage(mutation) {
  const { parentSessionId, childSessionId, parentDateDir, childDateDir, message, mirrorToChild, created } =
    mutation.payload;
  const parentFile = path.join(DATA_DIR, parentDateDir, `${parentSessionId}.json`);
  const childFile = path.join(DATA_DIR, childDateDir, `${childSessionId}.json`);

  return withOrderedLocks([parentFile, childFile], async () => {
    const parent = await readSessionIfExists(parentFile, { expectedId: parentSessionId, trashed: false });
    const child = await readSessionIfExists(childFile, { expectedId: childSessionId, trashed: false });
    if (!parent || parent.kind !== 'normal' || parent.compactedSessionId !== childSessionId) {
      throw storedDataError('mutation journal', 'mirrored message parent relationship is inconsistent');
    }
    if (!child || child.kind !== 'compacted' || child.parentSessionId !== parentSessionId) {
      throw storedDataError('mutation journal', 'mirrored message child relationship is inconsistent');
    }

    const parentResult = ensureMirroredMessage(parent, message);
    if (parentResult.changed) {
      parent.updatedAt = mutation.startedAt;
      await writeJson(parentFile, parent);
      await checkpoint('mirror-compacted-message:after-parent-write', mutation);
    }

    let responseMessage = parentResult.message;
    if (mirrorToChild) {
      const childResult = ensureMirroredMessage(child, message);
      responseMessage = childResult.message;
      if (childResult.changed) {
        child.updatedAt = mutation.startedAt;
        await writeJson(childFile, child);
        await checkpoint('mirror-compacted-message:after-child-write', mutation);
      }
    }

    return { message: responseMessage, created };
  });
}

function findIdempotentMessage(session, idempotencyKey) {
  if (!idempotencyKey) return null;
  return session.messages.find((message) => message.clientIdempotencyKey === idempotencyKey) || null;
}

function isMessageAtOrBeforeCompactionBoundary(parent, child, messageId) {
  const boundaryIndex = parent.messages.findIndex((message) => message.id === child.compaction.throughMessageId);
  if (boundaryIndex < 0) {
    throw storedDataError('session', 'compacted session boundary message is missing from its parent');
  }
  const messageIndex = parent.messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return false;
  return messageIndex <= boundaryIndex;
}

async function prepareMirroredMessage(sessionId, request) {
  const childFound = await findSessionFile(sessionId);
  if (!childFound) throw appError(404, 'Session not found.');
  const child = await readSessionRecord(childFound.filePath, { expectedId: sessionId });
  if (child.kind !== 'compacted') {
    throw appError(409, 'Message mirroring requires a compacted session.');
  }

  const parentFound = await findSessionFile(child.parentSessionId);
  if (!parentFound) throw storedDataError('session', 'compacted session parent is missing');
  const parent = await readSessionRecord(parentFound.filePath, { expectedId: child.parentSessionId });
  if (parent.kind !== 'normal' || parent.compactedSessionId !== child.id) {
    throw storedDataError('session', 'compacted session relationship is inconsistent');
  }

  const childExisting = findIdempotentMessage(child, request.idempotencyKey);
  const parentExisting = findIdempotentMessage(parent, request.idempotencyKey);
  let childFingerprintAdded = false;
  let parentFingerprintAdded = false;

  if (request.idempotencyKey) {
    if (childExisting) {
      childFingerprintAdded = bindExistingMessageToPayload(
        childExisting,
        request.idempotencyPayload,
        request.idempotencyFingerprint
      );
    }
    if (parentExisting) {
      parentFingerprintAdded = bindExistingMessageToPayload(
        parentExisting,
        request.idempotencyPayload,
        request.idempotencyFingerprint
      );
    }
    if (childExisting && parentExisting && childExisting.id !== parentExisting.id) {
      throw storedDataError('session', 'mirrored idempotency key points to different parent and child messages');
    }
  }

  if (parentExisting && !childExisting && isMessageAtOrBeforeCompactionBoundary(parent, child, parentExisting.id)) {
    if (!parentFingerprintAdded) return { result: { message: parentExisting, created: false } };
    return {
      payload: {
        parentSessionId: parent.id,
        childSessionId: child.id,
        parentDateDir: parentFound.dateDir,
        childDateDir: childFound.dateDir,
        message: cloneMessage(parentExisting),
        mirrorToChild: false,
        created: false
      }
    };
  }

  if (childExisting || parentExisting) {
    const existing = childExisting || parentExisting;
    if (childExisting && parentExisting && !childFingerprintAdded && !parentFingerprintAdded) {
      return { result: { message: existing, created: false } };
    }
    return {
      payload: {
        parentSessionId: parent.id,
        childSessionId: child.id,
        parentDateDir: parentFound.dateDir,
        childDateDir: childFound.dateDir,
        message: cloneMessage(existing),
        mirrorToChild: true,
        created: false
      }
    };
  }

  const now = new Date().toISOString();
  const message = {
    id: id('msg'),
    sender: request.sender || nextMessageSender(child.messages),
    text: request.text,
    createdAt: now
  };
  if (request.idempotencyKey) {
    message.clientIdempotencyKey = request.idempotencyKey;
    message.clientIdempotencyFingerprint = request.idempotencyFingerprint;
  }
  if (request.source) message.source = request.source;
  if (request.providerKey) message.providerKey = request.providerKey;

  return {
    payload: {
      parentSessionId: parent.id,
      childSessionId: child.id,
      parentDateDir: parentFound.dateDir,
      childDateDir: childFound.dateDir,
      message,
      mirrorToChild: true,
      created: true
    }
  };
}

async function addCompactedSessionMessageRecoverably(sessionId, request) {
  await ensureBaseFiles();
  return withLock(GLOBAL_MUTATION_LOCK, async () => {
    await recoverPendingMutationUnlocked();
    const prepared = await prepareMirroredMessage(sessionId, request);
    if (prepared.result) return prepared.result;

    const mutation = validateMutationJournal({
      journalVersion: JOURNAL_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      type: 'mirror-compacted-message',
      startedAt: new Date().toISOString(),
      payload: prepared.payload
    });
    await writeJson(MUTATION_JOURNAL_FILE, mutation);
    await checkpoint('mirror-compacted-message:after-journal-write', mutation);
    const result = await applyMirrorCompactedMessage(mutation);
    await removeJournal();
    return result;
  });
}

async function applyUpsertCompaction(mutation) {
  const { parentSessionId, childSessionId, parentDateDir, childDateDir, compaction } = mutation.payload;
  const parentFile = path.join(DATA_DIR, parentDateDir, `${parentSessionId}.json`);
  const childFile = path.join(DATA_DIR, childDateDir, `${childSessionId}.json`);

  return withOrderedLocks([parentFile, childFile], async () => {
    const parent = await readSessionIfExists(parentFile, { expectedId: parentSessionId, trashed: false });
    if (!parent) throw storedDataError('mutation journal', `parent session ${parentSessionId} is missing`);
    if (parent.kind !== 'normal') {
      throw storedDataError('mutation journal', `parent session ${parentSessionId} is not a normal session`);
    }
    if (parent.compactedSessionId && parent.compactedSessionId !== childSessionId) {
      throw storedDataError(
        'mutation journal',
        `parent session ${parentSessionId} references a different compacted session`
      );
    }

    let child = await readSessionIfExists(childFile, { expectedId: childSessionId, trashed: false });
    const created = !child;
    let replaced = false;

    if (child) {
      if (child.kind !== 'compacted' || child.parentSessionId !== parentSessionId) {
        throw storedDataError(
          'mutation journal',
          `compacted session ${childSessionId} has an inconsistent parent relationship`
        );
      }

      if (child.compaction?.requestId === compaction.requestId) {
        if (!sameCompactionPayload(child.compaction, compaction)) {
          throw storedDataError(
            'mutation journal',
            `compaction request ${compaction.requestId} conflicts with stored data`
          );
        }
      } else {
        child = {
          ...child,
          title: compactedTitleFor(parent.title),
          aiName: parent.aiName,
          pinnedFolderId: parent.pinnedFolderId || null,
          updatedAt: mutation.startedAt,
          compaction: { ...compaction, createdAt: mutation.startedAt },
          messages: []
        };
        await writeJson(childFile, child);
        replaced = true;
        await checkpoint('upsert-compaction:after-child-write', mutation);
      }
    } else {
      child = {
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        id: childSessionId,
        title: compactedTitleFor(parent.title),
        aiName: parent.aiName,
        createdAt: mutation.startedAt,
        updatedAt: mutation.startedAt,
        pinnedFolderId: parent.pinnedFolderId || null,
        kind: 'compacted',
        parentSessionId,
        compaction: { ...compaction, createdAt: mutation.startedAt },
        messages: []
      };
      await writeJson(childFile, child);
      await checkpoint('upsert-compaction:after-child-write', mutation);
    }

    if (parent.compactedSessionId !== childSessionId) {
      parent.compactedSessionId = childSessionId;
      parent.updatedAt = mutation.startedAt;
      await writeJson(parentFile, parent);
      await checkpoint('upsert-compaction:after-parent-write', mutation);
    }

    return { session: child, dateDir: childDateDir, created, replaced };
  });
}

async function applyMutation(mutation) {
  if (mutation.type === 'trash-session') return applyTrashSession(mutation);
  if (mutation.type === 'restore-session') return applyRestoreSession(mutation);
  if (mutation.type === 'delete-folder') return applyDeleteFolder(mutation);
  if (mutation.type === 'permanent-delete-trash') return applyPermanentDeleteTrash(mutation);
  if (mutation.type === 'upsert-compaction') return applyUpsertCompaction(mutation);
  if (mutation.type === 'mirror-compacted-message') return applyMirrorCompactedMessage(mutation);
  if (mutation.type === 'sync-session-metadata') return applySyncSessionMetadata(mutation);
  if (mutation.type === 'compacted-session-lifecycle') return applyCompactedSessionLifecycle(mutation);
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

async function runRecoverableMutationPlan(planFactory, apply = applyMutation) {
  await ensureBaseFiles();
  return withLock(GLOBAL_MUTATION_LOCK, async () => {
    await recoverPendingMutationUnlocked();
    const plan = await planFactory();
    const mutation = validateMutationJournal({
      journalVersion: JOURNAL_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      type: plan.type,
      startedAt: new Date().toISOString(),
      payload: plan.payload
    });
    await writeJson(MUTATION_JOURNAL_FILE, mutation);
    await checkpoint(`${plan.type}:after-journal-write`, mutation);
    const result = await apply(mutation);
    await removeJournal();
    return result;
  });
}

async function runRecoverableMutation(type, payloadOrFactory, apply = applyMutation) {
  return runRecoverableMutationPlan(async () => ({
    type,
    payload: typeof payloadOrFactory === 'function' ? await payloadOrFactory() : payloadOrFactory
  }), apply);
}

async function syncSessionMetadataRecoverably(sessionId, updates) {
  return runRecoverableMutation('sync-session-metadata', () => prepareSessionMetadataPayload(sessionId, updates));
}

async function moveSessionToTrashRecoverably(sessionId, sourceDateDir) {
  return runRecoverableMutationPlan(() => prepareTrashMutationPlan(sessionId, sourceDateDir));
}

async function restoreSessionRecoverably(sessionId) {
  return runRecoverableMutationPlan(() => prepareRestoreMutationPlan(sessionId));
}

async function deleteFolderRecoverably(folderId) {
  return runRecoverableMutation('delete-folder', { folderId });
}

async function permanentlyDeleteTrashRecoverably(sessionId) {
  return runRecoverableMutationPlan(() => preparePermanentDeleteMutationPlan(sessionId));
}

async function resolveCompactionRelationship(sessionId) {
  const targetFound = await findSessionFile(sessionId);
  if (!targetFound) throw appError(404, 'Session not found.');
  const target = await readSessionRecord(targetFound.filePath, { expectedId: sessionId });

  if (target.kind === 'normal') {
    let childFound = null;
    let child = null;
    let childSessionId = target.compactedSessionId;

    if (childSessionId) {
      childFound = await findSessionFile(childSessionId, true);
      if (childFound?.trashed) throw appError(409, 'Compacted session is currently in trash.');
      if (childFound) {
        child = await readSessionRecord(childFound.filePath, { expectedId: childSessionId });
        if (child.kind !== 'compacted' || child.parentSessionId !== target.id) {
          throw storedDataError('session', 'compacted session relationship is inconsistent');
        }
      }
    } else {
      childSessionId = id('chat');
    }

    return {
      parent: target,
      parentFound: targetFound,
      child,
      childFound,
      childSessionId
    };
  }

  const parentFound = await findSessionFile(target.parentSessionId);
  if (!parentFound) throw storedDataError('session', 'compacted session parent is missing');
  const parent = await readSessionRecord(parentFound.filePath, { expectedId: target.parentSessionId });
  if (parent.kind !== 'normal' || parent.compactedSessionId !== target.id) {
    throw storedDataError('session', 'compacted session relationship is inconsistent');
  }

  return {
    parent,
    parentFound,
    child: target,
    childFound: targetFound,
    childSessionId: target.id
  };
}

async function upsertCompactedSessionRecoverably(sessionId, request) {
  return runRecoverableMutation('upsert-compaction', async () => {
    const relationship = await resolveCompactionRelationship(sessionId);
    const { parent, parentFound, child, childFound, childSessionId } = relationship;

    if (child?.compaction?.requestId === request.requestId) {
      const sameRequest =
        child.compaction.text === request.text && (child.compaction.providerKey || '') === (request.providerKey || '');
      if (!sameRequest) throw appError(409, 'Compaction request ID was already used with different content.');

      return {
        parentSessionId: parent.id,
        childSessionId,
        parentDateDir: parentFound.dateDir,
        childDateDir: childFound.dateDir,
        compaction: {
          text: child.compaction.text,
          requestId: child.compaction.requestId,
          ...(child.compaction.providerKey ? { providerKey: child.compaction.providerKey } : {}),
          sourceMessageCount: child.compaction.sourceMessageCount,
          throughMessageId: child.compaction.throughMessageId
        }
      };
    }

    if (!Array.isArray(parent.messages) || parent.messages.length === 0) {
      throw appError(409, 'Cannot compact a session with no messages.');
    }

    const throughMessage = parent.messages.at(-1);
    return {
      parentSessionId: parent.id,
      childSessionId,
      parentDateDir: parentFound.dateDir,
      childDateDir: childFound?.dateDir || parentFound.dateDir,
      compaction: {
        text: request.text,
        requestId: request.requestId,
        ...(request.providerKey ? { providerKey: request.providerKey } : {}),
        sourceMessageCount: parent.messages.length,
        throughMessageId: throughMessage.id
      }
    };
  });
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
  syncSessionMetadataRecoverably,
  upsertCompactedSessionRecoverably,
  addCompactedSessionMessageRecoverably,
  setMutationFailureInjectorForTests
};
