const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR, TRASH_DIR, SESSION_ID_PATTERN, MESSAGE_ID_PATTERN } = require('../config');
const { appError } = require('../errors');
const { id, dateFolderName } = require('../ids');
const { cleanName, cleanText, normalizeIdempotencyKey, optionalFolderId, validateId } = require('../validation');
const { requireExistingFolderId } = require('../storage/folder-store');
const { clearActiveSessionIf } = require('../storage/state-store');
const { collectSessionSummaries } = require('../storage/session-store');
const { findSessionFile, readJson, writeJson, withLock, ensureBaseFiles } = require('../storage/file-store');
const { botNameForSession, summarizeSession } = require('./session-format');
const { buildSessionExportResponse } = require('./export-service');

async function listSessions() {
  return collectSessionSummaries();
}

async function recentChats(limit) {
  return (await collectSessionSummaries()).slice(0, limit);
}

async function createSession(body) {
  const title = cleanName(body.title);
  if (!title) throw appError(400, 'Session title is required.');

  const pinnedFolderId = await requireExistingFolderId(optionalFolderId(body.pinnedFolderId));
  const now = new Date().toISOString();
  const session = {
    id: id('chat'),
    title,
    aiName: cleanName(body.aiName, 80) || 'AI Bot',
    createdAt: now,
    updatedAt: now,
    pinnedFolderId,
    messages: []
  };

  const dateDir = dateFolderName();
  await writeJson(path.join(DATA_DIR, dateDir, `${session.id}.json`), session);
  return summarizeSession(session, dateDir);
}

async function updateSessionMetadata(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
  const hasAiName = Object.prototype.hasOwnProperty.call(body, 'aiName');

  if (!hasTitle && !hasAiName) throw appError(400, 'Nothing to update.');

  const title = hasTitle ? cleanName(body.title) : null;
  const aiName = hasAiName ? cleanName(body.aiName, 80) : null;

  if (hasTitle && !title) throw appError(400, 'Session title is required.');
  if (hasAiName && !aiName) throw appError(400, 'AI bot name is required.');

  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
    if (hasTitle) session.title = title;
    if (hasAiName) session.aiName = aiName;
    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
    return { ...summarizeSession(session, found.dateDir, found.trashed), aiName: botNameForSession(session) };
  });
}

async function updateBotName(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const aiName = cleanName(body.aiName, 80);
  if (!aiName) throw appError(400, 'AI bot name is required.');

  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
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
  const session = await readJson(found.filePath);
  return buildSessionExportResponse(session, found.dateDir, found.trashed);
}

async function readSession(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const found = await findSessionFile(safeSessionId, true);
  if (!found) throw appError(404, 'Session not found.');
  const session = await readJson(found.filePath);
  session.aiName = botNameForSession(session);
  return { ...session, trashed: found.trashed };
}

async function addMessage(sessionId, body, rawIdempotencyKey) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const text = cleanText(body.text);
  if (!text) throw appError(400, 'Message text is required.');

  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey || body.idempotencyKey);
  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
    if (!Array.isArray(session.messages)) session.messages = [];

    if (idempotencyKey) {
      const existing = session.messages.find((item) => item.clientIdempotencyKey === idempotencyKey);
      if (existing) return { message: existing, created: false };
    }

    const requestedSender = body.sender === 'me' ? 'me' : body.sender === 'bot' ? 'bot' : null;
    const sender = requestedSender || (session.messages.length % 2 === 0 ? 'me' : 'bot');
    const now = new Date().toISOString();
    const nextMessage = {
      id: id('msg'),
      sender,
      text,
      createdAt: now
    };

    if (idempotencyKey) nextMessage.clientIdempotencyKey = idempotencyKey;
    if (body.source) nextMessage.source = cleanName(body.source, 80);
    if (body.providerKey) nextMessage.providerKey = cleanName(body.providerKey, 80);

    session.messages.push(nextMessage);
    session.updatedAt = now;
    await writeJson(found.filePath, session);
    return { message: nextMessage, created: true };
  });
}

async function updateMessage(sessionId, messageId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const safeMessageId = validateId(messageId, MESSAGE_ID_PATTERN, 'Message ID');
  const text = cleanText(body.text);
  const sender = body.sender === 'me' ? 'me' : body.sender === 'bot' ? 'bot' : null;
  if (!text) throw appError(400, 'Message text is required.');

  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
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
    const session = await readJson(found.filePath);
    const originalLength = Array.isArray(session.messages) ? session.messages.length : 0;
    session.messages = (session.messages || []).filter((msg) => msg.id !== safeMessageId);

    if (session.messages.length === originalLength) throw appError(404, 'Message not found.');

    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
  });
}

async function pinSession(sessionId, body) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const pinnedFolderId = await requireExistingFolderId(optionalFolderId(body.pinnedFolderId));
  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  return withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
    session.pinnedFolderId = pinnedFolderId;
    session.updatedAt = new Date().toISOString();
    await writeJson(found.filePath, session);
    return summarizeSession(session, found.dateDir);
  });
}

async function moveSessionToTrash(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const found = await findSessionFile(safeSessionId);
  if (!found) throw appError(404, 'Session not found.');

  await withLock(found.filePath, async () => {
    const session = await readJson(found.filePath);
    session.deletedAt = new Date().toISOString();
    await writeJson(path.join(TRASH_DIR, `${session.id}.json`), session);
    await fs.unlink(found.filePath);
    await clearActiveSessionIf(session.id);
  });
}

async function listTrash() {
  await ensureBaseFiles();
  const files = await fs.readdir(TRASH_DIR).catch(() => []);
  const sessions = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const session = await readJson(path.join(TRASH_DIR, file), null);
    if (session?.id) sessions.push(summarizeSession(session, null, true));
  }
  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return sessions;
}

async function restoreSessionFromTrash(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const trashFile = path.join(TRASH_DIR, `${safeSessionId}.json`);

  return withLock(trashFile, async () => {
    const session = await readJson(trashFile, null);
    if (!session) throw appError(404, 'Trashed session not found.');

    const restoreDate = dateFolderName(new Date(session.createdAt || Date.now()));
    delete session.deletedAt;
    session.updatedAt = new Date().toISOString();
    await writeJson(path.join(DATA_DIR, restoreDate, `${session.id}.json`), session);
    await fs.unlink(trashFile);
    return summarizeSession(session, restoreDate);
  });
}

async function permanentlyDeleteTrashedSession(sessionId) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const trashFile = path.join(TRASH_DIR, `${safeSessionId}.json`);
  try {
    await fs.unlink(trashFile);
    await clearActiveSessionIf(safeSessionId);
  } catch (err) {
    if (err.code === 'ENOENT') throw appError(404, 'Trashed session not found.');
    throw err;
  }
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
