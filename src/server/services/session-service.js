const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR, TRASH_DIR, SESSION_ID_PATTERN, MESSAGE_ID_PATTERN } = require('../config');
const { appError } = require('../errors');
const { id, dateFolderName } = require('../ids');
const {
  cleanName,
  cleanText,
  normalizeIdempotencyKey,
  optionalFolderId,
  optionalMessageSender,
  validateId
} = require('../validation');
const { requireExistingFolderId } = require('../storage/folder-store');
const { collectSessionSummaries } = require('../storage/session-store');
const { findSessionFile, writeJson, withLock, ensureBaseFiles } = require('../storage/file-store');
const {
  withMutationConsistency,
  moveSessionToTrashRecoverably,
  restoreSessionRecoverably,
  permanentlyDeleteTrashRecoverably
} = require('../storage/mutation-coordinator');
const { CURRENT_SCHEMA_VERSION, readSessionRecord } = require('../storage/record-validation');
const { botNameForSession, summarizeSession } = require('./session-format');
const { buildSessionExportResponse } = require('./export-service');
const {
  createMessageRequestPayload,
  fingerprintMessageRequest,
  bindExistingMessageToPayload
} = require('./message-idempotency');

async function listSessions() {
  return collectSessionSummaries();
}

async function recentChats(limit) {
  return (await collectSessionSummaries()).slice(0, limit);
}

function readFoundSession(found, expectedId) {
  return readSessionRecord(found.filePath, { expectedId, trashed: found.trashed });
}

async function createSession(body) {
  const title = cleanName(body.title, 160, 'Session title');
  if (!title) throw appError(400, 'Session title is required.');

  return withMutationConsistency(async () => {
    const pinnedFolderId = await requireExistingFolderId(optionalFolderId(body.pinnedFolderId));
    const now = new Date().toISOString();
    const session = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: id('chat'),
      title,
      aiName: cleanName(body.aiName, 80, 'AI bot name') || 'AI Bot',
      createdAt: now,
      updatedAt: now,
      pinnedFolderId,
      messages: []
    };

    const dateDir = dateFolderName();
    await writeJson(path.join(DATA_DIR, dateDir, `${session.id}.json`), session);
    return summarizeSession(session, dateDir);
  });
}

async function updateSessionMetadata(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
  const hasAiName = Object.prototype.hasOwnProperty.call(body, 'aiName');

  if (!hasTitle && !hasAiName) throw appError(400, 'Nothing to update.');

  const title = hasTitle ? cleanName(body.title, 160, 'Session title') : null;
  const aiName = hasAiName ? cleanName(body.aiName, 80, 'AI bot name') : null;

  if (hasTitle && !title) throw appError(400, 'Session title is required.');
  if (hasAiName && !aiName) throw appError(400, 'AI bot name is required.');

  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readFoundSession(found, safeSessionId);
    if (hasTitle) session.title = title;
    if (hasAiName) session.aiName = aiName;
    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
    return { ...summarizeSession(session, found.dateDir, found.trashed), aiName: botNameForSession(session) };
  });
}

async function updateBotName(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const aiName = cleanName(body.aiName, 80, 'AI bot name');
  if (!aiName) throw appError(400, 'AI bot name is required.');

  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readFoundSession(found, safeSessionId);
    session.aiName = aiName;
    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
    return { ...summarizeSession(session, found.dateDir, found.trashed), aiName: session.aiName };
  });
}

async function getSessionExport(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');
  const session = await readFoundSession(found, safeSessionId);
  return buildSessionExportResponse(session, found.dateDir, found.trashed);
}

async function readSession(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');
  const session = await readFoundSession(found, safeSessionId);
  session.aiName = botNameForSession(session);
  return { ...session, trashed: found.trashed };
}

function nextMessageSender(messages) {
  const lastSender = messages.at(-1)?.sender;
  if (lastSender === 'me') return 'bot';
  if (lastSender === 'bot') return 'me';
  return 'me';
}

async function addMessage(sessionId, body, rawIdempotencyKey) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const text = cleanText(body.text, 'Message text');
  if (!text) throw appError(400, 'Message text is required.');

  const requestedSender = optionalMessageSender(body.sender);
  const source = Object.prototype.hasOwnProperty.call(body, 'source')
    ? cleanName(body.source, 80, 'Message source')
    : '';
  const providerKey = Object.prototype.hasOwnProperty.call(body, 'providerKey')
    ? cleanName(body.providerKey, 80, 'Provider key')
    : '';
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey || body.idempotencyKey);
  const idempotencyPayload = createMessageRequestPayload({
    text,
    sender: requestedSender,
    source,
    providerKey
  });
  const idempotencyFingerprint = idempotencyKey ? fingerprintMessageRequest(idempotencyPayload) : '';

  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readFoundSession(found, safeSessionId);
    if (idempotencyKey) {
      const existing = session.messages.find((item) => item.clientIdempotencyKey === idempotencyKey);
      if (existing) {
        const fingerprintAdded = bindExistingMessageToPayload(existing, idempotencyPayload, idempotencyFingerprint);
        if (fingerprintAdded) await writeJson(found.filePath, session);
        return { message: existing, created: false };
      }
    }

    const sender = requestedSender || nextMessageSender(session.messages);
    const now = new Date().toISOString();
    const nextMessage = {
      id: id('msg'),
      sender,
      text,
      createdAt: now
    };

    if (idempotencyKey) {
      nextMessage.clientIdempotencyKey = idempotencyKey;
      nextMessage.clientIdempotencyFingerprint = idempotencyFingerprint;
    }
    if (source) nextMessage.source = source;
    if (providerKey) nextMessage.providerKey = providerKey;

    session.messages.push(nextMessage);
    session.updatedAt = now;
    await writeJson(found.filePath, session);
    return { message: nextMessage, created: true };
  });
}

async function updateMessage(sessionId, messageId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const safeMessageId = validateId(messageId, MESSAGE_ID_PATTERN, 'Message ID');
  const text = cleanText(body.text, 'Message text');
  const sender = optionalMessageSender(body.sender);
  if (!text) throw appError(400, 'Message text is required.');

  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readFoundSession(found, safeSessionId);
    const existing = (session.messages || []).find((msg) => msg.id === safeMessageId);
    if (!existing) throw appError(404, 'Message not found.');

    existing.text = text;
    if (sender) existing.sender = sender;
    existing.updatedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();

    await writeJson(found.filePath, session);
    return existing;
  });
}

async function deleteMessage(sessionId, messageId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const safeMessageId = validateId(messageId, MESSAGE_ID_PATTERN, 'Message ID');
  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  await withLock(found.filePath, async () => {
    const session = await readFoundSession(found, safeSessionId);
    const originalLength = Array.isArray(session.messages) ? session.messages.length : 0;
    session.messages = (session.messages || []).filter((msg) => msg.id !== safeMessageId);

    if (session.messages.length === originalLength) throw appError(404, 'Message not found.');

    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
  });
}

async function pinSession(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const requestedFolderId = optionalFolderId(body.pinnedFolderId);

  return withMutationConsistency(async () => {
    const pinnedFolderId = await requireExistingFolderId(requestedFolderId);
    const found = await findSessionFile(safeSessionId);
    if (!found) throw appError(404, 'Session not found.');

    return withLock(found.filePath, async () => {
      const session = await readFoundSession(found, safeSessionId);
      session.pinnedFolderId = pinnedFolderId;
      session.updatedAt = new Date().toISOString();
      await writeJson(found.filePath, session);
      return summarizeSession(session, found.dateDir);
    });
  });
}

async function moveSessionToTrash(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');
  await moveSessionToTrashRecoverably(safeSessionId, found.dateDir);
}

async function listTrash() {
  await ensureBaseFiles();
  const files = await fs.readdir(TRASH_DIR).catch(() => []);
  const sessions = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const session = await readSessionRecord(path.join(TRASH_DIR, file), { trashed: true });
    sessions.push(summarizeSession(session, null, true));
  }
  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return sessions;
}

async function restoreSessionFromTrash(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const restored = await restoreSessionRecoverably(safeSessionId);
  const restoreDate = dateFolderName(new Date(restored.createdAt));
  return summarizeSession(restored, restoreDate);
}

async function permanentlyDeleteTrashedSession(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  await permanentlyDeleteTrashRecoverably(safeSessionId);
}

module.exports = {
  listSessions,
  recentChats,
  createSession,
  updateSessionMetadata,
  updateBotName,
  getSessionExport,
  readSession,
  addMessage,
  updateMessage,
  deleteMessage,
  pinSession,
  moveSessionToTrash,
  listTrash,
  restoreSessionFromTrash,
  permanentlyDeleteTrashedSession
};
