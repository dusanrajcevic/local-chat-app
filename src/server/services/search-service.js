const { cleanName } = require('../validation');
const { summarizeSession } = require('./session-format');
const { collectSearchableSessions, collectSessionSummaries } = require('../storage/session-store');

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

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

async function searchSessions(query, limit = 100) {
  const normalizedQuery = normalizeSearchText(query);
  const allSessions = await collectSearchableSessions();
  const results = [];

  for (const { session, dateDir } of allSessions) {
    const summary = summarizeSession(session, dateDir);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const searchParts = [session.title, session.aiName, dateDir, ...messages.map((message) => message.text)];
    const haystack = normalizeSearchText(searchParts.join(' '));

    if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;

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

    results.push({
      ...summary,
      match: {
        title: Boolean(normalizedQuery && normalizeSearchText(session.title).includes(normalizedQuery)),
        aiName: Boolean(normalizedQuery && normalizeSearchText(session.aiName).includes(normalizedQuery)),
        messageCount: matchedMessages.length,
        snippets: matchedMessages,
        preview:
          matchedMessages[0]?.snippet ||
          compactSnippet(messages[messages.length - 1]?.text || session.title || '', normalizedQuery)
      }
    });
  }

  results.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return results.slice(0, limit);
}

function normalizeLimit(rawValue, fallback = 100, max = 500) {
  const rawLimit = Number(rawValue || fallback);
  return Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), max) : fallback;
}

async function searchResponse(rawQuery, rawLimit) {
  const query = cleanName(rawQuery || '');
  const limit = normalizeLimit(rawLimit);
  const results = query
    ? await searchSessions(query, limit)
    : (await collectSessionSummaries()).slice(0, limit).map((session) => ({
        ...session,
        match: { title: false, aiName: false, messageCount: 0, snippets: [], preview: '' }
      }));

  return { query, count: results.length, results };
}

module.exports = {
  normalizeSearchText,
  compactSnippet,
  searchSessions,
  normalizeLimit,
  searchResponse
};
