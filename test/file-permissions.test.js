const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const posixOnly = { skip: process.platform === 'win32' };
const tempRoot = path.join(os.tmpdir(), `local-chat-app-permissions-${process.pid}-${Date.now()}`);
const dataDir = path.join(tempRoot, 'data');
const dateDir = path.join(dataDir, '2026-08-04');
const sessionPath = path.join(dateDir, 'chat_1700000000000_deadbeef.json');
const externalDir = path.join(tempRoot, 'external');
const externalFile = path.join(externalDir, 'outside.json');
const linkPath = path.join(dataDir, 'linked-external');

process.env.LOCAL_CHAT_DATA_DIR = dataDir;

const { ensureBaseFiles, writeJson } = require('../src/server/storage/file-store');

function permissionBits(stat) {
  return stat.mode & 0o777;
}

async function assertMode(targetPath, expectedMode) {
  const stat = await fs.stat(targetPath);
  assert.equal(
    permissionBits(stat),
    expectedMode,
    `${targetPath} should use mode ${expectedMode.toString(8)}`
  );
}

test.before(async (t) => {
  await fs.mkdir(dateDir, { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(dataDir, 'trash'), { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(dataDir, 'folders.json'), '{"folders":[]}\n', { mode: 0o644 });
  await fs.writeFile(path.join(dataDir, 'app-state.json'), '{"activeSessionId":null}\n', { mode: 0o644 });
  await fs.writeFile(sessionPath, '{}\n', { mode: 0o644 });
  await fs.mkdir(externalDir, { mode: 0o755 });
  await fs.writeFile(externalFile, '{}\n', { mode: 0o644 });
  if (process.platform !== 'win32') {
    await fs.symlink(externalDir, linkPath, 'dir').catch((error) => {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.diagnostic(`Symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    });
    await fs.chmod(dataDir, 0o755);
    await fs.chmod(path.join(dataDir, 'trash'), 0o755);
    await fs.chmod(dateDir, 0o755);
    await fs.chmod(path.join(dataDir, 'folders.json'), 0o644);
    await fs.chmod(path.join(dataDir, 'app-state.json'), 0o644);
    await fs.chmod(sessionPath, 0o644);
    await fs.chmod(externalDir, 0o755);
    await fs.chmod(externalFile, 0o644);
  }
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('startup tightens existing storage permissions', posixOnly, async () => {
  await ensureBaseFiles();

  await assertMode(dataDir, PRIVATE_DIRECTORY_MODE);
  await assertMode(path.join(dataDir, 'trash'), PRIVATE_DIRECTORY_MODE);
  await assertMode(dateDir, PRIVATE_DIRECTORY_MODE);
  await assertMode(path.join(dataDir, 'folders.json'), PRIVATE_FILE_MODE);
  await assertMode(path.join(dataDir, 'app-state.json'), PRIVATE_FILE_MODE);
  await assertMode(sessionPath, PRIVATE_FILE_MODE);
});

test('new directories and atomic JSON writes remain private', posixOnly, async () => {
  const newDateDir = path.join(dataDir, '2026-08-05');
  const newSessionPath = path.join(newDateDir, 'chat_1700000000001_cafebabe.json');

  await writeJson(newSessionPath, {
    schemaVersion: 1,
    id: 'chat_1700000000001_cafebabe',
    title: 'Private write',
    aiName: 'ChatGPT',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    pinnedFolderId: null,
    messages: []
  });

  await assertMode(newDateDir, PRIVATE_DIRECTORY_MODE);
  await assertMode(newSessionPath, PRIVATE_FILE_MODE);

  await fs.chmod(newSessionPath, 0o644);
  await writeJson(newSessionPath, { rewritten: true });
  await assertMode(newSessionPath, PRIVATE_FILE_MODE);

  const entries = await fs.readdir(newDateDir);
  assert.deepEqual(entries, [path.basename(newSessionPath)]);
});

test('permission migration does not follow symlinks', posixOnly, async (t) => {
  try {
    await fs.lstat(linkPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('Symlink fixture is unavailable on this filesystem.');
      return;
    }
    throw error;
  }

  await assertMode(externalDir, 0o755);
  await assertMode(externalFile, 0o644);
});
