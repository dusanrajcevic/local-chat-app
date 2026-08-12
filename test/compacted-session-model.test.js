const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), `local-chat-compacted-model-${process.pid}-${Date.now()}`);
const dataDir = path.join(tempRoot, 'data');
process.env.LOCAL_CHAT_DATA_DIR = dataDir;

const { CURRENT_SESSION_SCHEMA_VERSION } = require('../src/server/config');
const { ensureBaseFiles, findSessionFile } = require('../src/server/storage/file-store');
const { readSessionRecord } = require('../src/server/storage/record-validation');
const { createSession } = require('../src/server/services/session-service');

// This test intentionally covers only the model introduced by the first compaction commit.
// Creation/upsert of compacted children belongs to the following server feature commit.
test.before(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await ensureBaseFiles();
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('new sessions are persisted as schema-v2 normal sessions with no compacted child', async () => {
  const summary = await createSession({ title: 'Relationship model', aiName: 'ChatGPT' });
  assert.equal(summary.kind, 'normal');
  assert.equal(summary.compactedSessionId, null);
  assert.equal(summary.parentSessionId, null);

  const found = await findSessionFile(summary.id);
  assert.ok(found);
  const persisted = await readSessionRecord(found.filePath, { expectedId: summary.id });
  assert.equal(persisted.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(persisted.kind, 'normal');
  assert.equal(persisted.compactedSessionId, null);
  assert.equal(persisted.parentSessionId, undefined);
  assert.equal(persisted.compaction, undefined);
});
