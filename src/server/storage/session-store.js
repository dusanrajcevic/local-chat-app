const { indexedSessionSummaries, indexedSearchableSessions } = require('./session-index');

async function collectSessionSummaries() {
  return indexedSessionSummaries();
}

async function collectSearchableSessions(normalizedQuery = '') {
  return indexedSearchableSessions(normalizedQuery);
}

module.exports = { collectSessionSummaries, collectSearchableSessions };
