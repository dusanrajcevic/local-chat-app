const fs = require('fs/promises');
const path = require('path');
const nodeCrypto = require('node:crypto');
const {
  DATA_DIR,
  SESSION_INDEX_FILE,
  SESSION_ID_PATTERN,
  DATE_DIR_PATTERN,
  FOLDER_ID_PATTERN,
  CURRENT_SCHEMA_VERSION
} = require('../config');
const { summarizeSession } = require('../services/session-format');
const { normalizeSearchText } = require('../services/search-text');
const { listDateDirs, readJson, writeJson, withLock, inspectDataFile } = require('./file-store');
const { readSessionRecord, storedDataError } = require('./record-validation');
const { subscribeStorageChanges } = require('./storage-events');

const INDEX_VERSION = 1;
const SEARCH_BLOOM_BYTES = 2048;
const SEARCH_BLOOM_BITS = SEARCH_BLOOM_BYTES * 8;
const FULL_RECONCILE_INTERVAL_MS = 30_000;
const dirtySessionPaths = new Set();
let loadedIndex = null;
let fullReconcileRequired = true;
let lastFullReconcileAt = 0;
const INDEX_ETAG_EPOCH = nodeCrypto.randomBytes(8).toString('hex');
let indexRevision = 0;
let metrics = createMetrics();

function createMetrics() {
  return {
    fileChecks: 0,
    sessionReads: 0,
    indexWrites: 0,
    fullReconciliations: 0,
    dirtyReconciliations: 0,
    searchCandidates: 0,
    searchFiltered: 0
  };
}

function activeSessionLocation(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(DATA_DIR, resolved);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !DATE_DIR_PATTERN.test(parts[0]) || !parts[1].endsWith('.json')) return null;
  const id = parts[1].slice(0, -5);
  if (!SESSION_ID_PATTERN.test(id)) return null;
  return { id, dateFolder: parts[0], filePath: resolved };
}

subscribeStorageChanges(({ filePath }) => {
  const location = activeSessionLocation(filePath);
  if (!location) return;
  dirtySessionPaths.add(location.filePath);
  indexRevision += 1;
});

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validSummary(summary, id, dateFolder) {
  return (
    summary &&
    typeof summary === 'object' &&
    !Array.isArray(summary) &&
    summary.id === id &&
    typeof summary.title === 'string' &&
    typeof summary.aiName === 'string' &&
    validTimestamp(summary.createdAt) &&
    validTimestamp(summary.updatedAt) &&
    summary.dateFolder === dateFolder &&
    (summary.pinnedFolderId === null ||
      (typeof summary.pinnedFolderId === 'string' && FOLDER_ID_PATTERN.test(summary.pinnedFolderId))) &&
    Number.isInteger(summary.messageCount) &&
    summary.messageCount >= 0 &&
    summary.trashed === false
  );
}

function validSignature(signature) {
  return (
    signature &&
    typeof signature === 'object' &&
    typeof signature.size === 'string' &&
    typeof signature.mtimeNs === 'string' &&
    typeof signature.ctimeNs === 'string'
  );
}

function validSearchBloom(value) {
  if (typeof value !== 'string') return false;
  try {
    return Buffer.from(value, 'base64').length === SEARCH_BLOOM_BYTES;
  } catch {
    return false;
  }
}

function validateIndexDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.indexVersion !== INDEX_VERSION || document.schemaVersion !== CURRENT_SCHEMA_VERSION) return null;
  if (!Array.isArray(document.entries)) return null;

  const entries = new Map();
  for (const entry of document.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.id !== 'string' || !SESSION_ID_PATTERN.test(entry.id)) return null;
    if (typeof entry.dateFolder !== 'string' || !DATE_DIR_PATTERN.test(entry.dateFolder)) return null;
    if (!validSignature(entry.signature) || !validSummary(entry.summary, entry.id, entry.dateFolder)) return null;
    if (!validSearchBloom(entry.searchBloom)) return null;
    if (entries.has(entry.id)) return null;
    entries.set(entry.id, entry);
  }
  return entries;
}

async function loadIndex() {
  if (loadedIndex) return loadedIndex;
  let document = null;
  try {
    document = await readJson(SESSION_INDEX_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  loadedIndex = validateIndexDocument(document) || new Map();
  return loadedIndex;
}

function signatureFromStat(stat) {
  return { size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() };
}

function sameSignature(a, b) {
  return a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
}

function hashPair(value) {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second = ((second << 5) + second) ^ code;
  }
  return [first >>> 0, second >>> 0 || 1];
}

function gramPositions(gram) {
  const [first, second] = hashPair(gram);
  return [first % SEARCH_BLOOM_BITS, (first + second) % SEARCH_BLOOM_BITS, (first + 2 * second) % SEARCH_BLOOM_BITS];
}

function setBloomBit(buffer, position) {
  buffer[position >> 3] |= 1 << (position & 7);
}

function hasBloomBit(buffer, position) {
  return (buffer[position >> 3] & (1 << (position & 7))) !== 0;
}

function searchProjection(session, dateFolder) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return normalizeSearchText(
    [session.title, session.aiName, dateFolder, ...messages.map((message) => message.text)].join(' ')
  );
}

function buildSearchBloom(session, dateFolder) {
  const buffer = Buffer.alloc(SEARCH_BLOOM_BYTES);
  const projection = searchProjection(session, dateFolder);
  if (projection.length < 3) return buffer.toString('base64');

  let previousGram = '';
  for (let index = 0; index <= projection.length - 3; index += 1) {
    const gram = projection.slice(index, index + 3);
    if (gram === previousGram) continue;
    previousGram = gram;
    for (const position of gramPositions(gram)) setBloomBit(buffer, position);
  }
  return buffer.toString('base64');
}

function bloomMayContain(searchBloom, normalizedQuery) {
  if (!normalizedQuery || normalizedQuery.length < 3) return true;
  const buffer = Buffer.from(searchBloom, 'base64');
  let previousGram = '';
  for (let index = 0; index <= normalizedQuery.length - 3; index += 1) {
    const gram = normalizedQuery.slice(index, index + 3);
    if (gram === previousGram) continue;
    previousGram = gram;
    if (gramPositions(gram).some((position) => !hasBloomBit(buffer, position))) return false;
  }
  return true;
}

async function inspectSessionFile(filePath, { allowMissing = false } = {}) {
  let candidate;
  try {
    candidate = await inspectDataFile(filePath, { allowMissing });
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!candidate.exists) return null;
  const stat = await fs.stat(candidate.resolved, { bigint: true });
  metrics.fileChecks += 1;
  return signatureFromStat(stat);
}

async function readStableSession(filePath, id) {
  return withLock(filePath, async () => {
    const signature = await inspectSessionFile(filePath);
    const session = await readSessionRecord(filePath, { expectedId: id });
    const confirmedSignature = await inspectSessionFile(filePath);
    if (!sameSignature(signature, confirmedSignature)) {
      const retrySession = await readSessionRecord(filePath, { expectedId: id });
      metrics.sessionReads += 2;
      return { session: retrySession, signature: await inspectSessionFile(filePath) };
    }
    metrics.sessionReads += 1;
    return { session, signature };
  });
}

function entryPath(entry) {
  return path.join(DATA_DIR, entry.dateFolder, `${entry.id}.json`);
}

async function persistIndex(entries) {
  await writeJson(SESSION_INDEX_FILE, {
    indexVersion: INDEX_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
  });
  metrics.indexWrites += 1;
}

async function updateEntry(entries, location, knownSignature = null) {
  const signature = knownSignature || (await inspectSessionFile(location.filePath, { allowMissing: true }));
  if (!signature) {
    return entries.delete(location.id);
  }

  const existing = entries.get(location.id);
  if (existing && existing.dateFolder === location.dateFolder && sameSignature(existing.signature, signature)) {
    return false;
  }

  const stable = await readStableSession(location.filePath, location.id);
  entries.set(location.id, {
    id: location.id,
    dateFolder: location.dateFolder,
    signature: stable.signature,
    summary: summarizeSession(stable.session, location.dateFolder),
    searchBloom: buildSearchBloom(stable.session, location.dateFolder)
  });
  return true;
}

async function fullReconcile(entries) {
  metrics.fullReconciliations += 1;
  const seen = new Set();
  let changed = false;
  const dateDirs = await listDateDirs();

  for (const dateFolder of dateDirs) {
    const dirPath = path.join(DATA_DIR, dateFolder);
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const id = file.name.slice(0, -5);
      if (!SESSION_ID_PATTERN.test(id)) continue;
      if (seen.has(id)) throw storedDataError('session', `duplicate active session id ${id}`);
      seen.add(id);
      const location = { id, dateFolder, filePath: path.join(dirPath, file.name) };
      const signature = await inspectSessionFile(location.filePath);
      if (await updateEntry(entries, location, signature)) changed = true;
    }
  }

  for (const id of [...entries.keys()]) {
    if (seen.has(id)) continue;
    entries.delete(id);
    changed = true;
  }

  lastFullReconcileAt = Date.now();
  fullReconcileRequired = false;
  return changed;
}

async function reconcileDirty(entries) {
  if (dirtySessionPaths.size === 0) return false;
  metrics.dirtyReconciliations += 1;
  const paths = [...dirtySessionPaths];
  for (const filePath of paths) dirtySessionPaths.delete(filePath);

  let changed = false;
  for (const filePath of paths) {
    const location = activeSessionLocation(filePath);
    if (location && (await updateEntry(entries, location))) changed = true;
  }
  return changed;
}

async function refreshIndexUnlocked({ forceFull = false } = {}) {
  const entries = await loadIndex();
  let changed = false;
  const fullDue = forceFull || fullReconcileRequired || Date.now() - lastFullReconcileAt >= FULL_RECONCILE_INTERVAL_MS;

  if (fullDue) {
    const pendingDirty = [...dirtySessionPaths];
    dirtySessionPaths.clear();
    changed = await fullReconcile(entries);
    for (const filePath of pendingDirty) dirtySessionPaths.add(filePath);
    if (await reconcileDirty(entries)) changed = true;
  } else if (await reconcileDirty(entries)) {
    changed = true;
  }

  if (changed) {
    indexRevision += 1;
    await persistIndex(entries);
  }
  return entries;
}

async function refreshSessionIndex(options = {}) {
  return withLock(SESSION_INDEX_FILE, () => refreshIndexUnlocked(options));
}

function compareSummaries(a, b) {
  const updatedDifference = new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  return updatedDifference || a.id.localeCompare(b.id);
}

function sortedEntries(entries) {
  return [...entries.values()].sort((a, b) => compareSummaries(a.summary, b.summary));
}

function sortSummaries(entries) {
  return sortedEntries(entries).map((entry) => entry.summary);
}

async function indexedSessionSummaries() {
  return sortSummaries(await refreshSessionIndex());
}

async function sessionIndexRevision() {
  await refreshSessionIndex();
  return `${INDEX_ETAG_EPOCH}-${indexRevision}`;
}

async function indexedSearchCandidates(normalizedQuery = '') {
  const entries = await refreshSessionIndex();
  const candidates = [];

  for (const entry of sortedEntries(entries)) {
    if (!bloomMayContain(entry.searchBloom, normalizedQuery)) {
      metrics.searchFiltered += 1;
      continue;
    }
    metrics.searchCandidates += 1;
    candidates.push({
      id: entry.id,
      dateDir: entry.dateFolder,
      filePath: entryPath(entry),
      summary: entry.summary
    });
  }

  return candidates;
}

async function readIndexedSearchCandidate(candidate) {
  const stable = await readStableSession(candidate.filePath, candidate.id);
  return { session: stable.session, dateDir: candidate.dateDir };
}

async function indexedSearchableSessions(normalizedQuery = '') {
  const candidates = await indexedSearchCandidates(normalizedQuery);
  return Promise.all(candidates.map((candidate) => readIndexedSearchCandidate(candidate)));
}

async function resetSessionIndexForTests({ keepDiskIndex = true } = {}) {
  loadedIndex = null;
  dirtySessionPaths.clear();
  fullReconcileRequired = true;
  lastFullReconcileAt = 0;
  metrics = createMetrics();
  indexRevision += 1;
  if (!keepDiskIndex) await fs.rm(SESSION_INDEX_FILE, { force: true });
}

function sessionIndexMetricsForTests() {
  return {
    ...metrics,
    dirtyPaths: dirtySessionPaths.size,
    indexedSessions: loadedIndex?.size || 0
  };
}

module.exports = {
  indexedSessionSummaries,
  indexedSearchCandidates,
  readIndexedSearchCandidate,
  indexedSearchableSessions,
  sessionIndexRevision,
  refreshSessionIndex,
  resetSessionIndexForTests,
  sessionIndexMetricsForTests,
  buildSearchBloom,
  bloomMayContain
};
