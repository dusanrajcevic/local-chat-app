const { cleanName } = require('../validation');
const { summarizeSession } = require('./session-format');
const { collectSearchCandidates, readSearchCandidate, collectSessionSummaries } = require('../storage/session-store');
const { normalizeSearchText } = require('./search-text');
const { normalizeOffset, normalizePageLimit } = require('../http/collection-response');

function compactSnippet(value, query, maxLength = 220) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  const normalizedText = text.toLowerCase();
  const normalizedQuery = normalizeSearchText(query);
  const foundAt = normalizedQuery ? normalizedText.indexOf(normalizedQuery) : -1;
  const center = foundAt >= 0 ? foundAt : 0;
  const start = Math.max(0, center - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function buildSearchResult(session, dateDir, normalizedQuery) {
  const summary = summarizeSession(session, dateDir);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const compactionText = session.compaction?.text || '';
  const searchParts = [
    session.title,
    session.aiName,
    dateDir,
    compactionText,
    ...messages.map((message) => message.text)
  ];
  const haystack = normalizeSearchText(searchParts.join(' '));

  if (normalizedQuery && !haystack.includes(normalizedQuery)) return null;

  const matchedMessages = [];
  if (normalizedQuery) {
    for (const message of messages) {
      const messageText = String(message.text || '');
      if (!normalizeSearchText(messageText).includes(normalizedQuery)) continue;
      matchedMessages.push({
        id: message.id,
        sender: message.sender === 'me' ? 'me' : 'bot',
        createdAt: message.createdAt || null,
        snippet: compactSnippet(messageText, normalizedQuery)
      });
      if (matchedMessages.length >= 3) break;
    }
  }

  return {
    ...summary,
    match: {
      title: Boolean(normalizedQuery && normalizeSearchText(session.title).includes(normalizedQuery)),
      aiName: Boolean(normalizedQuery && normalizeSearchText(session.aiName).includes(normalizedQuery)),
      compaction: Boolean(normalizedQuery && normalizeSearchText(compactionText).includes(normalizedQuery)),
      messageCount: matchedMessages.length,
      snippets: matchedMessages,
      preview:
        matchedMessages[0]?.snippet ||
        (normalizedQuery && normalizeSearchText(compactionText).includes(normalizedQuery)
          ? compactSnippet(compactionText, normalizedQuery)
          : compactSnippet(messages[messages.length - 1]?.text || session.title || '', normalizedQuery))
    }
  };
}

async function searchSessionsPage(query, { offset = 0, limit = 100 } = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const candidates = await collectSearchCandidates(normalizedQuery);
  const results = [];
  let skipped = 0;
  let hasMore = false;

  for (const candidate of candidates) {
    const { session, dateDir } = await readSearchCandidate(candidate);
    const result = buildSearchResult(session, dateDir, normalizedQuery);
    if (!result) continue;

    if (skipped < offset) {
      skipped += 1;
      continue;
    }
    if (results.length < limit) {
      results.push(result);
      continue;
    }

    hasMore = true;
    break;
  }

  return {
    results,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + results.length : null
  };
}

async function searchSessions(query, limit = 100) {
  return (await searchSessionsPage(query, { limit })).results;
}

function normalizeLimit(rawValue, fallback = 100, max = 500) {
  return normalizePageLimit(rawValue, { fallback, max });
}

async function searchResponse(rawQuery, rawLimit, rawOffset = 0) {
  const query = cleanName(rawQuery || '');
  const limit = normalizeLimit(rawLimit);
  const offset = normalizeOffset(rawOffset);

  let page;
  if (query) {
    page = await searchSessionsPage(query, { offset, limit });
  } else {
    const summaries = await collectSessionSummaries();
    const results = summaries.slice(offset, offset + limit).map((session) => ({
      ...session,
      match: { title: false, aiName: false, compaction: false, messageCount: 0, snippets: [], preview: '' }
    }));
    const hasMore = offset + results.length < summaries.length;
    page = {
      results,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + results.length : null,
      total: summaries.length
    };
  }

  return {
    query,
    count: page.results.length,
    results: page.results,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    ...(page.total === undefined ? {} : { total: page.total })
  };
}

module.exports = {
  normalizeSearchText,
  compactSnippet,
  buildSearchResult,
  searchSessionsPage,
  searchSessions,
  normalizeLimit,
  searchResponse
};
