const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_SCHEMA_VERSION,
  CURRENT_SESSION_SCHEMA_VERSION,
  validateSessionRecord,
  validateFoldersDocument,
  validateStateDocument
} = require('../src/server/storage/record-validation');

const SESSION_ID = 'chat_1700000000000_deadbeef';
const COMPACTED_SESSION_ID = 'chat_1700000000003_feedface';
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

function validV2NormalSession(overrides = {}) {
  return validSession({
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    kind: 'normal',
    compactedSessionId: null,
    ...overrides
  });
}

function validCompactedSession(overrides = {}) {
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    id: COMPACTED_SESSION_ID,
    title: 'Validated session (compacted)',
    aiName: 'ChatGPT',
    createdAt: NOW,
    updatedAt: NOW,
    pinnedFolderId: FOLDER_ID,
    kind: 'compacted',
    parentSessionId: SESSION_ID,
    compaction: {
      text: 'Structured compacted context.',
      requestId: 'compact:request-0001',
      createdAt: NOW,
      providerKey: 'chatgpt',
      sourceMessageCount: 1,
      throughMessageId: MESSAGE_ID
    },
    messages: [],
    ...overrides
  };
}

test('session validation migrates versionless and v1 records to normal session schema v2', () => {
  for (const schemaVersion of [undefined, 1]) {
    const session = validSession(schemaVersion === undefined ? {} : { schemaVersion });
    assert.equal(validateSessionRecord(session, SESSION_ID), session);
    assert.equal(session.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
    assert.equal(session.kind, 'normal');
    assert.equal(session.compactedSessionId, null);
  }
});

test('session validation accepts normal and compacted v2 relationship records', () => {
  const normal = validV2NormalSession({ compactedSessionId: COMPACTED_SESSION_ID });
  assert.equal(validateSessionRecord(normal, SESSION_ID), normal);

  const compacted = validCompactedSession();
  assert.equal(validateSessionRecord(compacted, COMPACTED_SESSION_ID), compacted);
});

test('session validation rejects invalid relationship shapes', () => {
  assert.throws(() => validateSessionRecord(validV2NormalSession({ kind: 'branch' }), SESSION_ID), /kind must be/i);
  assert.throws(
    () => validateSessionRecord(validV2NormalSession({ compactedSessionId: SESSION_ID }), SESSION_ID),
    /different session/i
  );
  assert.throws(
    () => validateSessionRecord(validV2NormalSession({ parentSessionId: COMPACTED_SESSION_ID }), SESSION_ID),
    /normal sessions must not contain parentSessionId/i
  );
  assert.throws(
    () => validateSessionRecord(validCompactedSession({ parentSessionId: COMPACTED_SESSION_ID }), COMPACTED_SESSION_ID),
    /different session/i
  );
  assert.throws(
    () => validateSessionRecord({ ...validCompactedSession(), compaction: undefined }, COMPACTED_SESSION_ID),
    /compaction must be an object/i
  );
});

test('session validation rejects malformed compaction metadata', () => {
  const badCount = validCompactedSession();
  badCount.compaction.sourceMessageCount = 0;
  assert.throws(() => validateSessionRecord(badCount, COMPACTED_SESSION_ID), /positive integer/i);

  const badRequest = validCompactedSession();
  badRequest.compaction.requestId = 'bad id with spaces';
  assert.throws(() => validateSessionRecord(badRequest, COMPACTED_SESSION_ID), /requestId has an invalid format/i);

  const badThroughMessage = validCompactedSession();
  badThroughMessage.compaction.throughMessageId = '../message';
  assert.throws(
    () => validateSessionRecord(badThroughMessage, COMPACTED_SESSION_ID),
    /throughMessageId.*invalid format/i
  );
});

test('legacy session validation rejects relationship fields that did not exist in v1', () => {
  assert.throws(
    () => validateSessionRecord(validSession({ schemaVersion: 1, kind: 'normal' }), SESSION_ID),
    /legacy records must not contain kind/i
  );
});

test('session validation rejects unsupported session schema versions', () => {
  assert.throws(
    () => validateSessionRecord(validSession({ schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1 }), SESSION_ID),
    /unsupported schemaVersion/i
  );
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

test('folder and state validation remain on the shared schema version', () => {
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
