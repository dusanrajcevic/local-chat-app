const { cleanName } = require('../validation');

function botNameForSession(session) {
  return cleanName(session?.aiName, 80) || 'AI Bot';
}

function sessionKind(session) {
  return session?.kind === 'compacted' ? 'compacted' : 'normal';
}

function compactedTitleFor(title) {
  const suffix = ' (compacted)';
  const base = cleanName(title, 160) || 'Untitled chat';
  return `${base.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
}

function summarizeSession(session, fileDate, trashed = false) {
  const kind = sessionKind(session);
  return {
    id: session.id,
    title: cleanName(session.title) || 'Untitled chat',
    aiName: botNameForSession(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    dateFolder: fileDate,
    pinnedFolderId: session.pinnedFolderId || null,
    kind,
    compactedSessionId: kind === 'normal' ? session.compactedSessionId || null : null,
    parentSessionId: kind === 'compacted' ? session.parentSessionId || null : null,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    trashed
  };
}

module.exports = { botNameForSession, sessionKind, compactedTitleFor, summarizeSession };
