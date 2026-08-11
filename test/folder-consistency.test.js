const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-folder-consistency-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { FOLDERS_FILE } = require('../src/server/config');
const { ensureBaseFiles, writeJson } = require('../src/server/storage/file-store');
const { createFolder, deleteFolderAndUnpinSessions, readFolders } = require('../src/server/storage/folder-store');
const { readFoldersDocument } = require('../src/server/storage/record-validation');
const {
  createSession,
  listTrash,
  moveSessionToTrash,
  readSession,
  restoreSessionFromTrash
} = require('../src/server/services/session-service');

test.before(async () => {
  await ensureBaseFiles();
});

test.after(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

async function removeFolderRecordWithoutSessionCleanup(folderId) {
  const document = await readFoldersDocument(FOLDERS_FILE);
  document.folders = document.folders.filter((folder) => folder.id !== folderId);
  await writeJson(FOLDERS_FILE, document);
}

test('deleting a folder clears matching references from trashed sessions', async () => {
  const folder = await createFolder('Trash consistency');
  const session = await createSession({
    title: 'Pinned trash session',
    aiName: 'Test Bot',
    pinnedFolderId: folder.id
  });

  await moveSessionToTrash(session.id);
  await deleteFolderAndUnpinSessions(folder.id);

  assert.equal(
    (await readFolders()).some((item) => item.id === folder.id),
    false
  );
  const trashed = (await listTrash()).find((item) => item.id === session.id);
  assert.ok(trashed);
  assert.equal(trashed.pinnedFolderId, null);

  await restoreSessionFromTrash(session.id);
  assert.equal((await readSession(session.id)).pinnedFolderId, null);
});

test('restore clears a stale folder reference left by older or manually edited data', async () => {
  const folder = await createFolder('Stale restore folder');
  const session = await createSession({
    title: 'Legacy stale reference',
    aiName: 'Test Bot',
    pinnedFolderId: folder.id
  });

  await moveSessionToTrash(session.id);
  await removeFolderRecordWithoutSessionCleanup(folder.id);

  const stale = (await listTrash()).find((item) => item.id === session.id);
  assert.equal(stale.pinnedFolderId, folder.id);

  const restored = await restoreSessionFromTrash(session.id);
  assert.equal(restored.pinnedFolderId, null);
  assert.equal((await readSession(session.id)).pinnedFolderId, null);
});

test('concurrent folder deletion and restore cannot leave a dangling folder reference', async () => {
  for (let index = 0; index < 20; index += 1) {
    const folder = await createFolder(`Concurrent folder ${index}`);
    const session = await createSession({
      title: `Concurrent restore ${index}`,
      aiName: 'Test Bot',
      pinnedFolderId: folder.id
    });
    await moveSessionToTrash(session.id);

    await Promise.all([deleteFolderAndUnpinSessions(folder.id), restoreSessionFromTrash(session.id)]);

    assert.equal(
      (await readFolders()).some((item) => item.id === folder.id),
      false
    );
    assert.equal((await readSession(session.id)).pinnedFolderId, null);
  }
});
