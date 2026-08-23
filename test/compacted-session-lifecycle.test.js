const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-compacted-lifecycle-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { MUTATION_JOURNAL_FILE } = require('../src/server/config');
const { ensureBaseFiles } = require('../src/server/storage/file-store');
const { createFolder } = require('../src/server/storage/folder-store');
const {
  recoverPendingMutation,
  setMutationFailureInjectorForTests
} = require('../src/server/storage/mutation-coordinator');
const { getAppState, setActiveSessionId } = require('../src/server/storage/state-store');
const {
  addMessage,
  createSession,
  listTrash,
  moveSessionToTrash,
  permanentlyDeleteTrashedSession,
  pinSession,
  readSession,
  restoreSessionFromTrash,
  updateBotName,
  updateSessionMetadata,
  upsertCompactedSession
} = require('../src/server/services/session-service');

async function createCompactedPair(title = 'Lifecycle conversation') {
  const parent = await createSession({ title, aiName: 'ChatGPT' });
  await addMessage(parent.id, { sender: 'me', text: 'Question before compaction' });
  await addMessage(parent.id, { sender: 'bot', text: 'Answer before compaction' });
  const compacted = await upsertCompactedSession(parent.id, {
    requestId: `compact:req:lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    compactedMessage: 'Compacted lifecycle context',
    providerKey: 'chatgpt'
  });
  return { parent, child: compacted.session };
}

async function assertMissingSession(sessionId) {
  await assert.rejects(
    () => readSession(sessionId),
    (error) => error?.status === 404
  );
}

test.before(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  await ensureBaseFiles();
});

test.afterEach(() => {
  setMutationFailureInjectorForTests(null);
});

test.after(async () => {
  setMutationFailureInjectorForTests(null);
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('title, AI name, and folder metadata stay synchronized across a compacted pair', async () => {
  const { parent, child } = await createCompactedPair('Original lifecycle title');
  const folder = await createFolder('Lifecycle folder');

  await updateSessionMetadata(parent.id, { title: 'Renamed lifecycle title' });
  assert.equal((await readSession(parent.id)).title, 'Renamed lifecycle title');
  assert.equal((await readSession(child.id)).title, 'Renamed lifecycle title (compacted)');

  await updateBotName(child.id, { aiName: 'Claude' });
  assert.equal((await readSession(parent.id)).aiName, 'Claude');
  assert.equal((await readSession(child.id)).aiName, 'Claude');

  await pinSession(child.id, { pinnedFolderId: folder.id });
  assert.equal((await readSession(parent.id)).pinnedFolderId, folder.id);
  assert.equal((await readSession(child.id)).pinnedFolderId, folder.id);

  await assert.rejects(
    () => updateSessionMetadata(child.id, { title: 'Independent compacted title' }),
    (error) => error?.status === 409 && /derived from their parent/i.test(error.message)
  );
});

test('trashing and restoring the parent keeps the compacted pair together', async () => {
  const { parent, child } = await createCompactedPair('Paired trash lifecycle');
  await setActiveSessionId(child.id);

  await moveSessionToTrash(parent.id);
  assert.equal((await readSession(parent.id)).trashed, true);
  assert.equal((await readSession(child.id)).trashed, true);
  assert.equal((await getAppState()).activeSessionId, null);
  assert.deepEqual(new Set((await listTrash()).map((session) => session.id)), new Set([parent.id, child.id]));

  const restored = await restoreSessionFromTrash(parent.id);
  assert.equal(restored.id, parent.id);
  const restoredParent = await readSession(parent.id);
  const restoredChild = await readSession(child.id);
  assert.equal(restoredParent.trashed, false);
  assert.equal(restoredChild.trashed, false);
  assert.equal(restoredParent.compactedSessionId, child.id);
  assert.equal(restoredChild.parentSessionId, parent.id);
});

test('trashing a compacted child detaches it and restoring it reattaches the same child', async () => {
  const { parent, child } = await createCompactedPair('Detached child lifecycle');

  await moveSessionToTrash(child.id);
  assert.equal((await readSession(child.id)).trashed, true);
  assert.equal((await readSession(parent.id)).compactedSessionId, null);

  const restored = await restoreSessionFromTrash(child.id);
  assert.equal(restored.id, child.id);
  assert.equal((await readSession(child.id)).trashed, false);
  assert.equal((await readSession(parent.id)).compactedSessionId, child.id);
});

test('a detached child can be replaced and a stale trashed child cannot overwrite the new relationship', async () => {
  const { parent, child } = await createCompactedPair('Replacement lifecycle');
  await moveSessionToTrash(child.id);

  const replacement = await upsertCompactedSession(parent.id, {
    requestId: 'compact:req:lifecycle-replacement-001',
    compactedMessage: 'Replacement compacted context',
    providerKey: 'chatgpt'
  });
  assert.notEqual(replacement.session.id, child.id);
  assert.equal((await readSession(parent.id)).compactedSessionId, replacement.session.id);

  await assert.rejects(
    () => restoreSessionFromTrash(child.id),
    (error) => error?.status === 409 && /different compacted session/i.test(error.message)
  );

  await permanentlyDeleteTrashedSession(child.id);
  assert.equal((await readSession(parent.id)).compactedSessionId, replacement.session.id);
  await assertMissingSession(child.id);
});

test('permanently deleting a trashed parent deletes its compacted child too', async () => {
  const { parent, child } = await createCompactedPair('Permanent pair deletion');
  await moveSessionToTrash(parent.id);

  await permanentlyDeleteTrashedSession(parent.id);
  await assertMissingSession(parent.id);
  await assertMissingSession(child.id);
  assert.equal(
    (await listTrash()).some((session) => session.id === parent.id || session.id === child.id),
    false
  );
});

test('an interrupted pair trash operation recovers the compacted child move', async () => {
  const { parent, child } = await createCompactedPair('Recover pair trash');
  setMutationFailureInjectorForTests((checkpoint) => {
    if (checkpoint === 'compacted-lifecycle:after-parent-trash') {
      throw new Error('Injected pair trash failure');
    }
  });

  await assert.rejects(() => moveSessionToTrash(parent.id), /Injected pair trash failure/);
  await fs.access(MUTATION_JOURNAL_FILE);
  assert.equal((await readSession(parent.id)).trashed, true);
  assert.equal((await readSession(child.id)).trashed, false);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();
  assert.equal((await readSession(parent.id)).trashed, true);
  assert.equal((await readSession(child.id)).trashed, true);
});

test('an interrupted parent rename recovers the derived compacted title', async () => {
  const { parent, child } = await createCompactedPair('Recover metadata sync');
  setMutationFailureInjectorForTests((checkpoint) => {
    if (checkpoint === 'sync-session-metadata:after-parent-write') {
      throw new Error('Injected metadata sync failure');
    }
  });

  await assert.rejects(
    () => updateSessionMetadata(parent.id, { title: 'Recovered parent title' }),
    /Injected metadata sync failure/
  );
  await fs.access(MUTATION_JOURNAL_FILE);
  assert.equal((await readSession(parent.id)).title, 'Recovered parent title');
  assert.equal((await readSession(child.id)).title, 'Recover metadata sync (compacted)');

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();
  assert.equal((await readSession(child.id)).title, 'Recovered parent title (compacted)');
});
