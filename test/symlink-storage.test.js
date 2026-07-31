const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const symlinkOnly = { skip: process.platform === 'win32' };
const tempRoot = path.join(os.tmpdir(), `local-chat-app-symlinks-${process.pid}-${Date.now()}`);
const dataDir = path.join(tempRoot, 'data');
const externalDir = path.join(tempRoot, 'external');

process.env.LOCAL_CHAT_DATA_DIR = dataDir;

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const { readFolders } = require('../src/server/storage/folder-store');
const { getAppState } = require('../src/server/storage/state-store');
const { createSession, readSession, moveSessionToTrash, listTrash } = require('../src/server/services/session-service');

async function createSymlink(linkPath, targetPath, type = 'file') {
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.symlink(targetPath, linkPath, type);
}

async function expectSymlinkRejection(task) {
  await assert.rejects(task, (error) => {
    assert.equal(error.status, 500);
    assert.match(error.message, /symbolic links/i);
    return true;
  });
}

async function restoreJsonFile(filePath, document) {
  await fs.rm(filePath, { force: true });
  await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

test.before(async () => {
  await fs.mkdir(externalDir, { recursive: true });
  await ensureBaseFiles();
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('normal metadata and session files remain readable', symlinkOnly, async () => {
  assert.deepEqual(await readFolders(), []);
  assert.equal((await getAppState()).activeSessionId, null);

  const created = await createSession({ title: 'Normal session', aiName: 'AI Bot' });
  const session = await readSession(created.id);
  assert.equal(session.id, created.id);
  assert.equal(session.title, 'Normal session');
});

test('symlinked folders metadata is rejected instead of followed', symlinkOnly, async () => {
  const foldersPath = path.join(dataDir, 'folders.json');
  const externalPath = path.join(externalDir, 'folders.json');
  const original = JSON.parse(await fs.readFile(foldersPath, 'utf8'));

  await fs.writeFile(externalPath, JSON.stringify(original));
  await createSymlink(foldersPath, externalPath);

  await expectSymlinkRejection(() => readFolders());
  await restoreJsonFile(foldersPath, original);
});

test('symlinked application state is rejected instead of followed', symlinkOnly, async () => {
  const statePath = path.join(dataDir, 'app-state.json');
  const externalPath = path.join(externalDir, 'app-state.json');
  const original = JSON.parse(await fs.readFile(statePath, 'utf8'));

  await fs.writeFile(externalPath, JSON.stringify(original));
  await createSymlink(statePath, externalPath);

  await expectSymlinkRejection(() => getAppState());
  await restoreJsonFile(statePath, original);
});

test('symlinked active session files are rejected instead of followed', symlinkOnly, async () => {
  const created = await createSession({ title: 'Linked active session', aiName: 'AI Bot' });
  const dateDirs = (await fs.readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name);
  const sessionPath = path.join(dataDir, dateDirs[0], `${created.id}.json`);
  const externalPath = path.join(externalDir, `${created.id}.json`);
  const original = JSON.parse(await fs.readFile(sessionPath, 'utf8'));

  await fs.writeFile(externalPath, JSON.stringify(original));
  await createSymlink(sessionPath, externalPath);

  await expectSymlinkRejection(() => readSession(created.id));
  await restoreJsonFile(sessionPath, original);
});

test('symlinked trash session files are rejected instead of followed', symlinkOnly, async () => {
  const created = await createSession({ title: 'Linked trash session', aiName: 'AI Bot' });
  await moveSessionToTrash(created.id);

  const trashPath = path.join(dataDir, 'trash', `${created.id}.json`);
  const externalPath = path.join(externalDir, `trash-${created.id}.json`);
  const original = JSON.parse(await fs.readFile(trashPath, 'utf8'));

  await fs.writeFile(externalPath, JSON.stringify(original));
  await createSymlink(trashPath, externalPath);

  await expectSymlinkRejection(() => listTrash());
  await restoreJsonFile(trashPath, original);
});

test('a symlinked data directory is rejected at startup', symlinkOnly, async () => {
  const linkedRoot = path.join(tempRoot, 'linked-root');
  const linkedDataDir = path.join(linkedRoot, 'data');
  const externalDataDir = path.join(tempRoot, 'external-data');
  await fs.mkdir(linkedRoot, { recursive: true });
  await fs.mkdir(externalDataDir, { recursive: true });
  await fs.symlink(externalDataDir, linkedDataDir, 'dir');

  const script = `
    process.env.LOCAL_CHAT_DATA_DIR = ${JSON.stringify(linkedDataDir)};
    const { ensureBaseFiles } = require('./src/server/storage/file-store');
    ensureBaseFiles()
      .then(() => { process.stderr.write('unexpected success\\n'); process.exit(2); })
      .catch((error) => {
        if (error.status === 500 && /symbolic links/i.test(error.message)) process.exit(0);
        process.stderr.write(String(error.stack || error) + '\\n');
        process.exit(3);
      });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
