const { cleanName } = require('../validation');

function botNameForSession(session) {
  return cleanName(session?.aiName, 80) || 'AI Bot';
}

function summarizeSession(session, fileDate, trashed = false) {
  return {
    id: session.id,
    title: cleanName(session.title) || 'Untitled chat',
    aiName: botNameForSession(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    dateFolder: fileDate,
    pinnedFolderId: session.pinnedFolderId || null,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    trashed
  };
}

module.exports = { botNameForSession, summarizeSession };
