const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { performance: nodePerformance } = require('node:perf_hooks');

const sessionCount = Math.max(10, Number(process.argv[2]) || 1000);
const tempRoot = path.join(os.tmpdir(), `local-chat-index-benchmark-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = path.join(tempRoot, 'data');

const { DATA_DIR } = require('../src/server/config');
const { ensureBaseFiles, writeJson } = require('../src/server/storage/file-store');
const { collectSessionSummaries } = require('../src/server/storage/session-store');
const { searchSessions, searchSessionsPage } = require('../src/server/services/search-service');
const { resetSessionIndexForTests, sessionIndexMetricsForTests } = require('../src/server/storage/session-index');

function id(prefix, index) {
  return `${prefix}_${1700000000000 + index}_${index.toString(16).padStart(8, '0')}`;
}

async function timed(label, task) {
  const start = nodePerformance.now();
  const result = await task();
  return {
    label,
    durationMs: Number((nodePerformance.now() - start).toFixed(2)),
    result
  };
}

async function main() {
  try {
    await ensureBaseFiles();
    const dateDir = path.join(DATA_DIR, '2026-08-11');
    for (let index = 0; index < sessionCount; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 7, 11, 0, index % 60, 0)).toISOString();
      await writeJson(path.join(dateDir, `${id('chat', index)}.json`), {
        schemaVersion: 1,
        id: id('chat', index),
        title: `Benchmark session ${index}`,
        aiName: 'AI Bot',
        createdAt: timestamp,
        updatedAt: timestamp,
        pinnedFolderId: null,
        messages: [
          {
            id: id('msg', index),
            sender: 'me',
            text: `search-marker-${index} ` + 'large archive message body '.repeat(250),
            createdAt: timestamp
          }
        ]
      });
    }

    await resetSessionIndexForTests({ keepDiskIndex: false });
    const coldList = await timed('cold summary rebuild', collectSessionSummaries);
    const warmList = await timed('warm summary list', collectSessionSummaries);
    await resetSessionIndexForTests();
    const restartList = await timed('persisted-index list after reset', collectSessionSummaries);
    const selectiveSearch = await timed('indexed search (one marker)', () =>
      searchSessions(`search-marker-${Math.floor(sessionCount / 2)}`, 100)
    );
    const paginatedBroadSearch = await timed('paginated broad search (offset 100, limit 25)', () =>
      searchSessionsPage('large archive message', { offset: 100, limit: 25 })
    );
    const shortSearch = await timed('short-query fallback search', () => searchSessions('ai', 100));

    console.table(
      [coldList, warmList, restartList, selectiveSearch, paginatedBroadSearch, shortSearch].map(
        ({ label, durationMs, result }) => ({
          operation: label,
          durationMs,
          sessions: Array.isArray(result) ? result.length : result.results.length
        })
      )
    );
    console.log('Index metrics:', sessionIndexMetricsForTests());
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
