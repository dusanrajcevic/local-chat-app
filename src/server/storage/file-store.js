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

const fileLocks = new Map();

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

async function withLock(lockKey, task) {
  const previous = fileLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  fileLocks.set(
    lockKey,
    previous.then(
      () => current,
      () => current
    )
  );

  try {
    await previous.catch(() => {});
    return await task();
  } finally {
    release();
    if (fileLocks.get(lockKey) === current) fileLocks.delete(lockKey);
  }
}

async function atomicWriteFile(filePath, content) {
  const resolved = assertInsideDataDir(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`
  );

  let handle = null;
  try {
    handle = await fs.open(tempPath, 'w');
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TRASH_DIR, { recursive: true });

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
  withLock,
  atomicWriteFile,
  readJson,
  writeJson,
  ensureBaseFiles,
  listDateDirs,
  findSessionFile
};
