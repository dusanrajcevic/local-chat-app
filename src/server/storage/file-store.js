const fs = require('fs/promises');
const { constants: nodeFsConstants } = require('fs');
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

function unsafeSymlinkError() {
  return appError(500, 'Refusing to access symbolic links in the local data directory.');
}

function invalidStorageTypeError(expectedType) {
  return appError(500, `Refusing to access a path that is not a ${expectedType} in the local data directory.`);
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeDirectoryPath(dirPath) {
  const resolved = assertInsideDataDir(dirPath);
  const relative = path.relative(DATA_DIR, resolved);
  const segments = relative ? relative.split(path.sep) : [];
  let current = DATA_DIR;

  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw unsafeSymlinkError();
    if (!stat.isDirectory()) throw invalidStorageTypeError('directory');
  }

  return resolved;
}

async function inspectDataFile(filePath, { allowMissing = false } = {}) {
  const resolved = assertInsideDataDir(filePath);
  await assertSafeDirectoryPath(path.dirname(resolved));
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { resolved, exists: false };
    throw error;
  }

  if (stat.isSymbolicLink()) throw unsafeSymlinkError();
  if (!stat.isFile()) throw invalidStorageTypeError('regular file');
  return { resolved, exists: true };
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
  let created = false;

  if (resolved === DATA_DIR) {
    const existing = await lstatIfExists(resolved);
    if (existing?.isSymbolicLink()) throw unsafeSymlinkError();
    if (existing && !existing.isDirectory()) throw invalidStorageTypeError('directory');
    if (!existing) {
      await fs.mkdir(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    }
  } else {
    await ensurePrivateDirectory(path.dirname(resolved));
    const existing = await lstatIfExists(resolved);
    if (existing?.isSymbolicLink()) throw unsafeSymlinkError();
    if (existing && !existing.isDirectory()) throw invalidStorageTypeError('directory');
    if (!existing) {
      await fs.mkdir(resolved, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    }
  }

  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw unsafeSymlinkError();
  if (!stat.isDirectory()) throw invalidStorageTypeError('directory');
  if (SUPPORTS_POSIX_PERMISSIONS) await fs.chmod(resolved, PRIVATE_DIRECTORY_MODE);
  if (created && resolved !== DATA_DIR) await syncDirectoryMetadata(path.dirname(resolved));
  return resolved;
}

async function hardenDirectoryTree(dirPath) {
  if (!SUPPORTS_POSIX_PERMISSIONS) return;

  const resolved = await assertSafeDirectoryPath(dirPath);
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

async function syncDirectoryMetadata(dirPath) {
  if (process.platform === 'win32') return;
  const resolved = await assertSafeDirectoryPath(dirPath);
  let handle = null;
  try {
    handle = await fs.open(resolved, nodeFsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function unlinkDataFile(filePath, { missingOk = false } = {}) {
  const candidate = await inspectDataFile(filePath, { allowMissing: missingOk });
  if (!candidate.exists) return false;
  try {
    await fs.unlink(candidate.resolved);
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return false;
    throw error;
  }
  await syncDirectoryMetadata(path.dirname(candidate.resolved));
  return true;
}

async function atomicWriteFile(filePath, content) {
  const resolved = assertInsideDataDir(filePath);
  await ensurePrivateDirectory(path.dirname(resolved));
  await inspectDataFile(resolved, { allowMissing: true });
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
    await syncDirectoryMetadata(path.dirname(resolved));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, fallback = null) {
  let handle = null;
  try {
    const { resolved } = await inspectDataFile(filePath);
    const noFollowFlag = nodeFsConstants.O_NOFOLLOW || 0;
    handle = await fs.open(resolved, nodeFsConstants.O_RDONLY | noFollowFlag);
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalidStorageTypeError('regular file');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (err) {
    if (err.code === 'ELOOP') throw unsafeSymlinkError();
    if (fallback !== null && (err.code === 'ENOENT' || err instanceof SyntaxError)) return fallback;
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeJson(filePath, data) {
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function ensureBaseFiles() {
  await ensurePrivateDirectory(DATA_DIR);
  await ensurePrivateDirectory(TRASH_DIR);

  const foldersFile = await inspectDataFile(FOLDERS_FILE, { allowMissing: true });
  if (!foldersFile.exists) {
    await writeJson(FOLDERS_FILE, { schemaVersion: CURRENT_SCHEMA_VERSION, folders: [] });
  }

  const stateFile = await inspectDataFile(STATE_FILE, { allowMissing: true });
  if (!stateFile.exists) {
    await writeJson(STATE_FILE, { schemaVersion: CURRENT_SCHEMA_VERSION, activeSessionId: null, updatedAt: null });
  }

  await migrateExistingPermissionsOnce();
}

async function listDateDirs() {
  await ensureBaseFiles();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const dateDirs = [];

  for (const entry of entries) {
    if (!DATE_DIR_PATTERN.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw unsafeSymlinkError();
    if (entry.isDirectory()) dateDirs.push(entry.name);
  }

  return dateDirs.sort((a, b) => b.localeCompare(a));
}

async function findSessionFile(sessionId, includeTrash = false) {
  const safeSessionId = validateId(sessionId, SESSION_ID_PATTERN, 'Session ID');
  const dateDirs = await listDateDirs();

  for (const dateDir of dateDirs) {
    const filePath = assertInsideDataDir(path.join(DATA_DIR, dateDir, `${safeSessionId}.json`));
    const candidate = await inspectDataFile(filePath, { allowMissing: true });
    if (candidate.exists) return { filePath, dateDir, trashed: false };
  }

  if (includeTrash) {
    const trashFilePath = assertInsideDataDir(path.join(TRASH_DIR, `${safeSessionId}.json`));
    const candidate = await inspectDataFile(trashFilePath, { allowMissing: true });
    if (candidate.exists) return { filePath: trashFilePath, dateDir: null, trashed: true };
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
  unlinkDataFile,
  ensureBaseFiles,
  listDateDirs,
  findSessionFile
};
