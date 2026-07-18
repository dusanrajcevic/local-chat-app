const fs = require('fs/promises');
const path = require('path');
const nodeCrypto = require('crypto');
const {
  DATA_DIR,
  TRASH_DIR,
  FOLDERS_FILE,
  STATE_FILE,
  DATE_DIR_PATTERN,
  SESSION_ID_PATTERN,
  CURRENT_SCHEMA_VERSION
} = require('../config');
const { appError } = require('../errors');
const { validateId } = require('../validation');

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SUPPORTS_POSIX_PERMISSIONS = process.platform !== 'win32';

let permissionMigration = null;

function isInside(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertInsideDataDir(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved !== DATA_DIR && !isInside(DATA_DIR, resolved)) {
    throw appError(400, 'Refusing to access a path outside the local data directory.');
  }
  return resolved;
}

function createLockRegistry() {
  const locks = new Map();

  async function withLock(lockKey, task) {
    const previous = locks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => current,
      () => current
    );
    locks.set(lockKey, queued);

    try {
      await previous.catch(() => {});
      return await task();
    } finally {
      release();
      if (locks.get(lockKey) === queued) locks.delete(lockKey);
    }
  }

  return {
    withLock,
    get size() {
      return locks.size;
    }
  };
}

const fileLockRegistry = createLockRegistry();
const { withLock } = fileLockRegistry;

async function ensurePrivateDirectory(dirPath) {
  const resolved = assertInsideDataDir(dirPath);
  await fs.mkdir(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (SUPPORTS_POSIX_PERMISSIONS) await fs.chmod(resolved, PRIVATE_DIRECTORY_MODE);
  return resolved;
}

async function hardenDirectoryTree(dirPath) {
  if (!SUPPORTS_POSIX_PERMISSIONS) return;

  const resolved = assertInsideDataDir(dirPath);
  await fs.chmod(resolved, PRIVATE_DIRECTORY_MODE);
  const entries = await fs.readdir(resolved, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = assertInsideDataDir(path.join(resolved, entry.name));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await hardenDirectoryTree(entryPath);
    } else if (entry.isFile()) {
      await fs.chmod(entryPath, PRIVATE_FILE_MODE);
    }
  }
}

async function migrateExistingPermissionsOnce() {
  if (!SUPPORTS_POSIX_PERMISSIONS) return;
  if (!permissionMigration) {
    permissionMigration = hardenDirectoryTree(DATA_DIR).catch((error) => {
      permissionMigration = null;
      throw error;
    });
  }
  await permissionMigration;
}

async function atomicWriteFile(filePath, content) {
  const resolved = assertInsideDataDir(filePath);
  await ensurePrivateDirectory(path.dirname(resolved));
  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`
  );

  let handle = null;
  try {
    handle = await fs.open(tempPath, 'wx', PRIVATE_FILE_MODE);
    if (SUPPORTS_POSIX_PERMISSIONS) await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, resolved);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(assertInsideDataDir(filePath), 'utf8'));
  } catch (err) {
    if (fallback !== null && (err.code === 'ENOENT' || err instanceof SyntaxError)) return fallback;
    throw err;
  }
}

async function writeJson(filePath, data) {
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function ensureBaseFiles() {
  await ensurePrivateDirectory(DATA_DIR);
  await ensurePrivateDirectory(TRASH_DIR);

  try {
    await fs.access(FOLDERS_FILE);
  } catch {
    await writeJson(FOLDERS_FILE, { schemaVersion: CURRENT_SCHEMA_VERSION, folders: [] });
  }

  try {
    await fs.access(STATE_FILE);
  } catch {
    await writeJson(STATE_FILE, { schemaVersion: CURRENT_SCHEMA_VERSION, activeSessionId: null, updatedAt: null });
  }

  await migrateExistingPermissionsOnce();
}

async function listDateDirs() {
  await ensureBaseFiles();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

async function findSessionFile(sessionId, includeTrash = false) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const dateDirs = await listDateDirs();

  for (const dateDir of dateDirs) {
    const filePath = assertInsideDataDir(path.join(DATA_DIR, dateDir, `${safeSessionId}.json`));
    try {
      await fs.access(filePath);
      return { filePath, dateDir, trashed: false };
    } catch {}
  }

  if (includeTrash) {
    const trashFilePath = assertInsideDataDir(path.join(TRASH_DIR, `${safeSessionId}.json`));
    try {
      await fs.access(trashFilePath);
      return { filePath: trashFilePath, dateDir: null, trashed: true };
    } catch {}
  }

  return null;
}

module.exports = {
  isInside,
  assertInsideDataDir,
  createLockRegistry,
  withLock,
  atomicWriteFile,
  readJson,
  writeJson,
  ensureBaseFiles,
  listDateDirs,
  findSessionFile
};
