const { botNameForSession, summarizeSession } = require('./session-format');

const CONTINUATION_CONTEXT_PROMPT = [
  'Below is the context from a previous conversation. Please use it as background and continue from where we left off.',
  'Do not summarize the conversation unless I ask; use the context to answer my next message naturally.',
  '',
  '----------------------',
  ''
].join('\n');

function wrapChatExportForContinuation(text) {
  const cleanExport = String(text || '').trim();
  return `${CONTINUATION_CONTEXT_PROMPT}${cleanExport}`.trim();
}

function buildChatExportText(session) {
  if (!session) return '';

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const lines = [
    `Chat title: ${session.title || 'Untitled chat'}`,
    `AI name: ${botNameForSession(session)}`,
    `Created: ${session.createdAt ? new Date(session.createdAt).toLocaleString() : 'Unknown time'}`,
    `Last updated: ${session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'Unknown time'}`,
    '',
    'Messages:',
    ''
  ];

  if (!messages.length) {
    lines.push('[No messages yet]');
    return wrapChatExportForContinuation(lines.join('\n'));
  }

  messages.forEach((message, index) => {
    const sender = message.sender === 'me' ? 'Me' : botNameForSession(session);
    const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'Unknown time';
    const edited = message.updatedAt ? ' · edited' : '';

    lines.push(`[${index + 1}] ${sender} — ${createdAt}${edited}`);
    lines.push(String(message.text || ''));
    lines.push('');
  });

  return wrapChatExportForContinuation(lines.join('\n').trim());
}

function buildSessionExportResponse(session, fileDate, trashed) {
  const normalizedSession = { ...session, aiName: botNameForSession(session) };
  return {
    session: summarizeSession(normalizedSession, fileDate, trashed),
    format: 'copy-entire-chat',
    text: buildChatExportText(normalizedSession)
  };
}

module.exports = {
  CONTINUATION_CONTEXT_PROMPT,
  wrapChatExportForContinuation,
  buildChatExportText,
  buildSessionExportResponse
};
