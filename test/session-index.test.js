const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), `local-chat-index-${process.pid}-${Date.now()}`);
const dataDir = path.join(tempRoot, 'data');
const dateFolder = '2026-08-11';
const archiveSize = 120;

process.env.LOCAL_CHAT_DATA_DIR = dataDir;

const { SESSION_INDEX_FILE } = require('../src/server/config');
const { writeJson, ensureBaseFiles } = require('../src/server/storage/file-store');
const { collectSessionSummaries } = require('../src/server/storage/session-store');
const { searchSessions } = require('../src/server/services/search-service');
const {
  resetSessionIndexForTests,
  sessionIndexMetricsForTests,
  refreshSessionIndex
} = require('../src/server/storage/session-index');

function sessionId(index) {
  return `chat_${1700000000000 + index}_${index.toString(16).padStart(8, '0')}`;
}

function messageId(index) {
  return `msg_${1700000000000 + index}_${(index + 5000).toString(16).padStart(8, '0')}`;
}

function buildSession(index, suffix = '') {
  const createdAt = new Date(Date.UTC(2026, 7, 11, 0, index % 60, 0)).toISOString();
  const updatedAt = new Date(Date.UTC(2026, 7, 11, 1, index % 60, 0)).toISOString();
  return {
    schemaVersion: 1,
    id: sessionId(index),
    title: `Indexed session ${index}${suffix}`,
    aiName: 'Local AI',
    createdAt,
    updatedAt,
    pinnedFolderId: null,
    messages: [
      {
        id: messageId(index),
        sender: index % 2 === 0 ? 'me' : 'bot',
        text: `archive marker ${index} ` + 'payload '.repeat(300),
        createdAt
      }
    ]
  };
}

async function writeSession(index, suffix = '') {
  const session = buildSession(index, suffix);
  await writeJson(path.join(dataDir, dateFolder, `${session.id}.json`), session);
  return session;
}

test.before(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await ensureBaseFiles();
  for (let index = 0; index < archiveSize; index += 1) await writeSession(index);
  await resetSessionIndexForTests({ keepDiskIndex: false });
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('session summaries rebuild once, then avoid rereading unchanged transcripts', async () => {
  const first = await collectSessionSummaries();
  const afterFirst = sessionIndexMetricsForTests();

  assert.equal(first.length, archiveSize);
  assert.equal(afterFirst.sessionReads, archiveSize);
  assert.equal(afterFirst.fullReconciliations, 1);
  assert.equal(afterFirst.indexWrites, 1);

  const second = await collectSessionSummaries();
  const afterSecond = sessionIndexMetricsForTests();

  assert.deepEqual(second, first);
  assert.equal(afterSecond.sessionReads, afterFirst.sessionReads);
  assert.equal(afterSecond.fileChecks, afterFirst.fileChecks);
  assert.equal(afterSecond.fullReconciliations, 1);
  assert.equal(afterSecond.indexWrites, 1);
});

test('an internal session write refreshes only the changed index entry', async () => {
  const before = sessionIndexMetricsForTests();
  await writeSession(17, ' updated');
  const summaries = await collectSessionSummaries();
  const after = sessionIndexMetricsForTests();

  assert.equal(summaries.find((session) => session.id === sessionId(17)).title, 'Indexed session 17 updated');
  assert.equal(after.sessionReads - before.sessionReads, 1);
  assert.equal(after.dirtyReconciliations - before.dirtyReconciliations, 1);
  assert.equal(after.fullReconciliations, before.fullReconciliations);
  assert.equal(after.indexWrites - before.indexWrites, 1);
});

test('persisted summary index survives an in-memory reset without reparsing transcripts', async () => {
  await resetSessionIndexForTests();
  const summaries = await collectSessionSummaries();
  const metrics = sessionIndexMetricsForTests();

  assert.equal(summaries.length, archiveSize);
  assert.equal(metrics.fullReconciliations, 1);
  assert.equal(metrics.sessionReads, 0);
  assert.equal(metrics.indexWrites, 0);
});

test('search bloom filters large archives before exact transcript reads', async () => {
  await resetSessionIndexForTests();
  await collectSessionSummaries();
  const before = sessionIndexMetricsForTests();
  const results = await searchSessions('archive marker 17', 100);
  const after = sessionIndexMetricsForTests();

  assert.equal(results.length, 1);
  assert.equal(results[0].id, sessionId(17));
  assert.ok(after.searchFiltered - before.searchFiltered >= archiveSize - 5);
  assert.ok(after.sessionReads - before.sessionReads <= 5);
  assert.ok(after.searchCandidates - before.searchCandidates <= 5);
});

test('short substring searches preserve exact semantics by falling back to canonical files', async () => {
  await resetSessionIndexForTests();
  await collectSessionSummaries();
  const before = sessionIndexMetricsForTests();
  const results = await searchSessions('17', 100);
  const after = sessionIndexMetricsForTests();

  assert.ok(results.some((session) => session.id === sessionId(17)));
  assert.equal(after.searchCandidates - before.searchCandidates, archiveSize);
  assert.equal(after.sessionReads - before.sessionReads, archiveSize);
});

test('a malformed derived index is rebuilt from canonical session files', async () => {
  await fs.writeFile(SESSION_INDEX_FILE, '{not-json', 'utf8');
  await resetSessionIndexForTests();
  const summaries = await collectSessionSummaries();
  const metrics = sessionIndexMetricsForTests();

  assert.equal(summaries.length, archiveSize);
  assert.equal(metrics.sessionReads, archiveSize);
  assert.equal(metrics.indexWrites, 1);
  const persisted = JSON.parse(await fs.readFile(SESSION_INDEX_FILE, 'utf8'));
  assert.equal(persisted.entries.length, archiveSize);
});

test('forced reconciliation picks up out-of-band edits without trusting the derived index', async () => {
  const targetPath = path.join(dataDir, dateFolder, `${sessionId(23)}.json`);
  const manuallyEdited = buildSession(23, ' manual edit');
  await fs.writeFile(targetPath, `${JSON.stringify(manuallyEdited, null, 2)}\n`, 'utf8');

  await refreshSessionIndex({ forceFull: true });
  const summaries = await collectSessionSummaries();
  assert.equal(summaries.find((session) => session.id === sessionId(23)).title, 'Indexed session 23 manual edit');
});

test(
  'derived index uses private permissions and rejects symlink substitution',
  { skip: process.platform === 'win32' },
  async (t) => {
    const mode = (await fs.stat(SESSION_INDEX_FILE)).mode & 0o777;
    assert.equal(mode, 0o600);

    const externalIndex = path.join(tempRoot, 'outside-index.json');
    const savedIndex = await fs.readFile(SESSION_INDEX_FILE, 'utf8');
    await fs.writeFile(externalIndex, savedIndex, 'utf8');
    await fs.rm(SESSION_INDEX_FILE, { force: true });
    try {
      await fs.symlink(externalIndex, SESSION_INDEX_FILE);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await resetSessionIndexForTests();
    await assert.rejects(() => collectSessionSummaries(), /symbolic links/i);
    await fs.rm(SESSION_INDEX_FILE, { force: true });
    await fs.writeFile(SESSION_INDEX_FILE, savedIndex, { mode: 0o600 });
    await resetSessionIndexForTests();
  }
);
