const path = require('path');
const {
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_FINGERPRINT_PATTERN,
  CURRENT_SCHEMA_VERSION
} = require('../config');
const { appError } = require('../errors');
const { readJson } = require('./file-store');

function storedDataError(kind, detail) {
  const suffix = detail ? `: ${detail}` : '';
  return appError(500, `Stored ${kind} data is invalid${suffix}.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, kind, label = kind) {
  if (!isPlainObject(value)) throw storedDataError(kind, `${label} must be an object`);
}

function assertSchemaVersion(value, kind) {
  if (value === undefined) return;
  if (value !== CURRENT_SCHEMA_VERSION) {
    throw storedDataError(kind, `unsupported schemaVersion ${String(value)}`);
  }
}

function assertTimestamp(value, kind, label, { nullable = false, optional = false } = {}) {
  if (optional && value === undefined) return;
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw storedDataError(kind, `${label} must be a valid timestamp`);
  }
}

function assertOptionalString(value, kind, label, maxLength) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw storedDataError(kind, `${label} must be a string no longer than ${maxLength} characters`);
  }
}

function assertRequiredString(value, kind, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw storedDataError(kind, `${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function assertPattern(value, pattern, kind, label, { nullable = false, optional = false } = {}) {
  if (optional && value === undefined) return;
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw storedDataError(kind, `${label} has an invalid format`);
  }
}

function validateMessageRecord(message, index, seenIds) {
  const kind = 'session';
  const label = `messages[${index}]`;
  assertPlainObject(message, kind, label);
  assertPattern(message.id, MESSAGE_ID_PATTERN, kind, `${label}.id`);
  if (seenIds.has(message.id)) throw storedDataError(kind, `${label}.id is duplicated`);
  seenIds.add(message.id);

  if (message.sender !== 'me' && message.sender !== 'bot') {
    throw storedDataError(kind, `${label}.sender must be "me" or "bot"`);
  }
  assertRequiredString(message.text, kind, `${label}.text`, 2_000_000);
  assertTimestamp(message.createdAt, kind, `${label}.createdAt`);
  assertTimestamp(message.updatedAt, kind, `${label}.updatedAt`, { optional: true });
  assertPattern(message.clientIdempotencyKey, IDEMPOTENCY_KEY_PATTERN, kind, `${label}.clientIdempotencyKey`, {
    optional: true
  });
  assertPattern(
    message.clientIdempotencyFingerprint,
    IDEMPOTENCY_FINGERPRINT_PATTERN,
    kind,
    `${label}.clientIdempotencyFingerprint`,
    { optional: true }
  );
  if (message.clientIdempotencyFingerprint && !message.clientIdempotencyKey) {
    throw storedDataError(kind, `${label}.clientIdempotencyFingerprint requires a clientIdempotencyKey`);
  }
  assertOptionalString(message.source, kind, `${label}.source`, 80);
  assertOptionalString(message.providerKey, kind, `${label}.providerKey`, 80);
}

function validateSessionRecord(session, expectedId, { trashed = false } = {}) {
  const kind = 'session';
  assertPlainObject(session, kind);
  assertSchemaVersion(session.schemaVersion, kind);
  session.schemaVersion = CURRENT_SCHEMA_VERSION;
  assertPattern(session.id, SESSION_ID_PATTERN, kind, 'id');

  if (expectedId && session.id !== expectedId) {
    throw storedDataError(kind, `record id ${session.id} does not match filename id ${expectedId}`);
  }

  assertRequiredString(session.title, kind, 'title', 160);
  assertRequiredString(session.aiName, kind, 'aiName', 80);
  assertTimestamp(session.createdAt, kind, 'createdAt');
  assertTimestamp(session.updatedAt, kind, 'updatedAt');
  assertPattern(session.pinnedFolderId, FOLDER_ID_PATTERN, kind, 'pinnedFolderId', {
    nullable: true,
    optional: true
  });

  if (!Array.isArray(session.messages)) throw storedDataError(kind, 'messages must be an array');
  const messageIds = new Set();
  session.messages.forEach((message, index) => validateMessageRecord(message, index, messageIds));

  assertTimestamp(session.deletedAt, kind, 'deletedAt', { optional: !trashed });
  if (!trashed && session.deletedAt !== undefined) {
    throw storedDataError(kind, 'active records must not contain deletedAt');
  }

  return session;
}

function validateFoldersDocument(document) {
  const kind = 'folder';
  assertPlainObject(document, kind, 'document');
  assertSchemaVersion(document.schemaVersion, kind);
  document.schemaVersion = CURRENT_SCHEMA_VERSION;
  if (!Array.isArray(document.folders)) throw storedDataError(kind, 'folders must be an array');

  const folderIds = new Set();
  document.folders.forEach((folder, index) => {
    const label = `folders[${index}]`;
    assertPlainObject(folder, kind, label);
    assertPattern(folder.id, FOLDER_ID_PATTERN, kind, `${label}.id`);
    if (folderIds.has(folder.id)) throw storedDataError(kind, `${label}.id is duplicated`);
    folderIds.add(folder.id);
    assertRequiredString(folder.name, kind, `${label}.name`, 80);
    assertTimestamp(folder.createdAt, kind, `${label}.createdAt`);
    assertTimestamp(folder.updatedAt, kind, `${label}.updatedAt`, { optional: true });
  });

  return document;
}

function validateStateDocument(document) {
  const kind = 'application state';
  assertPlainObject(document, kind, 'document');
  assertSchemaVersion(document.schemaVersion, kind);
  document.schemaVersion = CURRENT_SCHEMA_VERSION;
  assertPattern(document.activeSessionId, SESSION_ID_PATTERN, kind, 'activeSessionId', { nullable: true });
  assertTimestamp(document.updatedAt, kind, 'updatedAt', { nullable: true });
  return document;
}

async function readValidatedJson(filePath, validator, kind) {
  let document;
  try {
    document = await readJson(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) throw storedDataError(kind, `${path.basename(filePath)} contains malformed JSON`);
    throw error;
  }
  return validator(document);
}

function sessionIdFromFilePath(filePath) {
  const filename = path.basename(filePath);
  if (!filename.endsWith('.json')) throw storedDataError('session', 'filename must end in .json');
  const sessionId = filename.slice(0, -'.json'.length);
  assertPattern(sessionId, SESSION_ID_PATTERN, 'session', 'filename id');
  return sessionId;
}

async function readSessionRecord(filePath, options = {}) {
  const expectedId = options.expectedId || sessionIdFromFilePath(filePath);
  return readValidatedJson(
    filePath,
    (session) => validateSessionRecord(session, expectedId, { trashed: Boolean(options.trashed) }),
    'session'
  );
}

async function readFoldersDocument(filePath) {
  return readValidatedJson(filePath, validateFoldersDocument, 'folder');
}

async function readStateDocument(filePath) {
  return readValidatedJson(filePath, validateStateDocument, 'application state');
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  storedDataError,
  isPlainObject,
  validateSessionRecord,
  validateFoldersDocument,
  validateStateDocument,
  readSessionRecord,
  readFoldersDocument,
  readStateDocument
};
