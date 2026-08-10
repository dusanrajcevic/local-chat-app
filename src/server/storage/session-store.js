const {
  indexedSessionSummaries,
  indexedSearchCandidates,
  readIndexedSearchCandidate,
  indexedSearchableSessions,
  sessionIndexRevision
} = require('./session-index');

async function collectSessionSummaries() {
  return indexedSessionSummaries();
}

async function collectSearchableSessions(normalizedQuery = '') {
  return indexedSearchableSessions(normalizedQuery);
}

async function collectSearchCandidates(normalizedQuery = '') {
  return indexedSearchCandidates(normalizedQuery);
}

async function readSearchCandidate(candidate) {
  return readIndexedSearchCandidate(candidate);
}

async function collectionRevision() {
  return sessionIndexRevision();
}

module.exports = {
  collectSessionSummaries,
  collectSearchableSessions,
  collectSearchCandidates,
  readSearchCandidate,
  collectionRevision
};
