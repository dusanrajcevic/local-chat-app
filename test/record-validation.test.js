const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_SCHEMA_VERSION,
  validateSessionRecord,
  validateFoldersDocument,
  validateStateDocument
} = require('../src/server/storage/record-validation');

const SESSION_ID = 'chat_1700000000000_deadbeef';
const MESSAGE_ID = 'msg_1700000000001_cafebabe';
const FOLDER_ID = 'folder_1700000000002_1234abcd';
const NOW = '2026-08-04T09:00:00.000Z';

function validSession(overrides = {}) {
  return {
    id: SESSION_ID,
    title: 'Validated session',
    aiName: 'ChatGPT',
    createdAt: NOW,
    updatedAt: NOW,
    pinnedFolderId: FOLDER_ID,
    messages: [
      {
        id: MESSAGE_ID,
        sender: 'me',
        text: 'A persisted message.',
        createdAt: NOW,
        clientIdempotencyKey: 'validation-key-0001'
      }
    ],
    ...overrides
  };
}

test('session validation accepts legacy records and adds the current schema version', () => {
  const session = validSession();
  assert.equal(validateSessionRecord(session, SESSION_ID), session);
  assert.equal(session.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('session validation rejects filename and record ID mismatches', () => {
  assert.throws(
    () => validateSessionRecord(validSession(), 'chat_1700000000999_aaaaaaaa'),
    /does not match filename id/i
  );
});

test('session validation rejects malformed message collections and fields', () => {
  assert.throws(() => validateSessionRecord(validSession({ messages: {} }), SESSION_ID), /messages must be an array/i);

  const invalidSender = validSession();
  invalidSender.messages[0].sender = 'system';
  assert.throws(() => validateSessionRecord(invalidSender, SESSION_ID), /sender must be/i);

  const invalidFingerprint = validSession();
  invalidFingerprint.messages[0].clientIdempotencyFingerprint = 'sha256:not-a-digest';
  assert.throws(() => validateSessionRecord(invalidFingerprint, SESSION_ID), /fingerprint.*invalid format/i);

  const fingerprintWithoutKey = validSession();
  delete fingerprintWithoutKey.messages[0].clientIdempotencyKey;
  fingerprintWithoutKey.messages[0].clientIdempotencyFingerprint = `sha256:${'a'.repeat(64)}`;
  assert.throws(() => validateSessionRecord(fingerprintWithoutKey, SESSION_ID), /requires.*clientIdempotencyKey/i);

  const invalidTimestamp = validSession({ createdAt: 'not-a-date' });
  assert.throws(() => validateSessionRecord(invalidTimestamp, SESSION_ID), /createdAt must be a valid timestamp/i);
});

test('trashed session validation requires deletedAt and active validation rejects it', () => {
  assert.throws(() => validateSessionRecord(validSession(), SESSION_ID, { trashed: true }), /deletedAt/i);

  const deleted = validSession({ deletedAt: NOW });
  assert.equal(validateSessionRecord(deleted, SESSION_ID, { trashed: true }), deleted);
  assert.throws(
    () => validateSessionRecord(validSession({ deletedAt: NOW }), SESSION_ID),
    /must not contain deletedAt/i
  );
});

test('folder and state validation reject malformed persisted references', () => {
  const folders = {
    folders: [{ id: FOLDER_ID, name: 'Portfolio', createdAt: NOW }]
  };
  assert.equal(validateFoldersDocument(folders), folders);
  assert.equal(folders.schemaVersion, CURRENT_SCHEMA_VERSION);

  assert.throws(
    () => validateFoldersDocument({ folders: [{ id: '../folders', name: 'Bad', createdAt: NOW }] }),
    /invalid format/i
  );

  const state = { activeSessionId: SESSION_ID, updatedAt: NOW };
  assert.equal(validateStateDocument(state), state);
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.throws(() => validateStateDocument({ activeSessionId: '../folders', updatedAt: NOW }), /invalid format/i);
});
