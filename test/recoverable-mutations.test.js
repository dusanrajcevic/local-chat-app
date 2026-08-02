const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-recovery-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { DATA_DIR, MUTATION_JOURNAL_FILE, STATE_FILE } = require('../src/server/config');
const { ensureBaseFiles, findSessionFile, withLock, writeJson } = require('../src/server/storage/file-store');
const { createFolder, deleteFolderAndUnpinSessions, readFolders } = require('../src/server/storage/folder-store');
const { getAppState, setActiveSessionId, clearActiveSessionIf } = require('../src/server/storage/state-store');
const {
  recoverPendingMutation,
  setMutationFailureInjectorForTests
} = require('../src/server/storage/mutation-coordinator');
const {
  createSession,
  listTrash,
  moveSessionToTrash,
  permanentlyDeleteTrashedSession,
  pinSession,
  readSession,
  restoreSessionFromTrash
} = require('../src/server/services/session-service');

function failAt(targetCheckpoint) {
  setMutationFailureInjectorForTests((checkpoint) => {
    if (checkpoint === targetCheckpoint) throw new Error(`Injected mutation failure at ${checkpoint}`);
  });
}

async function journalExists() {
  try {
    await fs.access(MUTATION_JOURNAL_FILE);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function createPinnedSession(title, folderId) {
  return createSession({ title, aiName: 'Recovery Bot', pinnedFolderId: folderId });
}

test.before(async () => {
  await ensureBaseFiles();
});

test.afterEach(() => {
  setMutationFailureInjectorForTests(null);
});

test.after(async () => {
  setMutationFailureInjectorForTests(null);
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('trash recovery completes an interrupted active-to-trash move and state clear', async () => {
  const session = await createSession({ title: 'Interrupted trash', aiName: 'Recovery Bot' });
  await setActiveSessionId(session.id);

  failAt('trash-session:after-trash-write');
  await assert.rejects(() => moveSessionToTrash(session.id), /Injected mutation failure/);

  assert.equal(await journalExists(), true);
  assert.ok(await findSessionFile(session.id));
  assert.ok((await listTrash()).some((item) => item.id === session.id));
  assert.equal((await getAppState()).activeSessionId, session.id);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  assert.equal(await journalExists(), false);
  assert.equal(await findSessionFile(session.id), null);
  assert.ok((await listTrash()).some((item) => item.id === session.id));
  assert.equal((await getAppState()).activeSessionId, null);
});

test('restore recovery removes the trash copy after an interrupted active write', async () => {
  const session = await createSession({ title: 'Interrupted restore', aiName: 'Recovery Bot' });
  await moveSessionToTrash(session.id);

  failAt('restore-session:after-active-write');
  await assert.rejects(() => restoreSessionFromTrash(session.id), /Injected mutation failure/);

  assert.equal(await journalExists(), true);
  assert.ok(await findSessionFile(session.id));
  assert.ok((await listTrash()).some((item) => item.id === session.id));

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  assert.equal(await journalExists(), false);
  assert.ok(await findSessionFile(session.id));
  assert.equal((await listTrash()).some((item) => item.id === session.id), false);
  assert.equal(Object.prototype.hasOwnProperty.call(await readSession(session.id), 'deletedAt'), false);
});

test('folder-delete recovery finishes active and trash reference cleanup', async () => {
  const folder = await createFolder('Interrupted folder cleanup');
  const activeSession = await createPinnedSession('Active pinned session', folder.id);
  const trashedSession = await createPinnedSession('Trashed pinned session', folder.id);
  await moveSessionToTrash(trashedSession.id);

  failAt('delete-folder:after-folder-delete');
  await assert.rejects(() => deleteFolderAndUnpinSessions(folder.id), /Injected mutation failure/);

  assert.equal(await journalExists(), true);
  assert.equal((await readFolders()).some((item) => item.id === folder.id), false);
  assert.equal((await readSession(activeSession.id)).pinnedFolderId, folder.id);
  assert.equal((await listTrash()).find((item) => item.id === trashedSession.id).pinnedFolderId, folder.id);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  assert.equal(await journalExists(), false);
  assert.equal((await readSession(activeSession.id)).pinnedFolderId, null);
  assert.equal((await listTrash()).find((item) => item.id === trashedSession.id).pinnedFolderId, null);
});

test('permanent-delete recovery finishes active-state cleanup after trash removal', async () => {
  const session = await createSession({ title: 'Interrupted permanent delete', aiName: 'Recovery Bot' });
  await moveSessionToTrash(session.id);
  await setActiveSessionId(session.id);

  failAt('permanent-delete-trash:after-trash-delete');
  await assert.rejects(() => permanentlyDeleteTrashedSession(session.id), /Injected mutation failure/);

  assert.equal(await journalExists(), true);
  assert.equal((await listTrash()).some((item) => item.id === session.id), false);
  assert.equal((await getAppState()).activeSessionId, session.id);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  assert.equal(await journalExists(), false);
  assert.equal((await getAppState()).activeSessionId, null);
});

test('pinning and folder deletion cannot commit a dangling folder reference', async () => {
  for (let index = 0; index < 10; index += 1) {
    const folder = await createFolder(`Pin race ${index}`);
    const session = await createSession({ title: `Pin race session ${index}`, aiName: 'Recovery Bot' });

    const results = await Promise.allSettled([
      pinSession(session.id, { pinnedFolderId: folder.id }),
      deleteFolderAndUnpinSessions(folder.id)
    ]);

    const pinResult = results[0];
    if (pinResult.status === 'rejected') assert.equal(pinResult.reason.status, 404);
    assert.equal((await readFolders()).some((item) => item.id === folder.id), false);
    assert.equal((await readSession(session.id)).pinnedFolderId, null);
  }
});

test('compare-and-clear state does not erase a newer active session', async () => {
  const oldSession = await createSession({ title: 'Old active', aiName: 'Recovery Bot' });
  const newSession = await createSession({ title: 'New active', aiName: 'Recovery Bot' });
  await setActiveSessionId(oldSession.id);

  let releaseBlocker;
  let markBlocked;
  const blocked = new Promise((resolve) => {
    markBlocked = resolve;
  });
  const blockerGate = new Promise((resolve) => {
    releaseBlocker = resolve;
  });

  const blocker = withLock(STATE_FILE, async () => {
    markBlocked();
    await blockerGate;
  });
  await blocked;

  const clearing = clearActiveSessionIf(oldSession.id);
  const setting = setActiveSessionId(newSession.id);
  releaseBlocker();
  await Promise.all([blocker, clearing, setting]);

  assert.equal((await getAppState()).activeSessionId, newSession.id);
});

test('corrupted mutation journals are rejected instead of discarded', async () => {
  await writeJson(MUTATION_JOURNAL_FILE, {
    journalVersion: 1,
    schemaVersion: 1,
    type: 'trash-session',
    startedAt: new Date().toISOString(),
    payload: { sessionId: '../folders', sourceDateDir: '2026-08-11' }
  });

  await assert.rejects(() => recoverPendingMutation(), /Stored mutation journal data is invalid/);
  assert.equal(await journalExists(), true);
  await fs.unlink(MUTATION_JOURNAL_FILE);
});

test('recovery journal remains inside the private data directory', async () => {
  const session = await createSession({ title: 'Journal location', aiName: 'Recovery Bot' });
  failAt('trash-session:after-journal-write');
  await assert.rejects(() => moveSessionToTrash(session.id), /Injected mutation failure/);

  const relative = path.relative(DATA_DIR, MUTATION_JOURNAL_FILE);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(await journalExists(), true);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();
  assert.equal(await journalExists(), false);
});
