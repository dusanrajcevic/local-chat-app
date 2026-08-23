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

function exportHeaderLines(session) {
  return [
    `Chat title: ${session.title || 'Untitled chat'}`,
    `AI name: ${botNameForSession(session)}`,
    `Created: ${session.createdAt ? new Date(session.createdAt).toLocaleString() : 'Unknown time'}`,
    `Last updated: ${session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'Unknown time'}`,
    ''
  ];
}

function appendMessages(lines, session, messages, emptyLabel = '[No messages yet]') {
  if (!messages.length) {
    lines.push(emptyLabel);
    return;
  }

  messages.forEach((message, index) => {
    const sender = message.sender === 'me' ? 'Me' : botNameForSession(session);
    const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'Unknown time';
    const edited = message.updatedAt ? ' · edited' : '';

    lines.push(`[${index + 1}] ${sender} — ${createdAt}${edited}`);
    lines.push(String(message.text || ''));
    lines.push('');
  });
}

function buildCompactedChatExportText(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const compaction = session.compaction || {};
  const sourceCount = Number.isInteger(compaction.sourceMessageCount) ? compaction.sourceMessageCount : null;
  const contextHeading = sourceCount
    ? `Compacted context (${sourceCount} source message${sourceCount === 1 ? '' : 's'}):`
    : 'Compacted context:';
  const lines = [
    ...exportHeaderLines(session),
    contextHeading,
    String(compaction.text || ''),
    '',
    'Messages after compaction:',
    ''
  ];

  appendMessages(lines, session, messages, '[No messages after compaction]');
  return wrapChatExportForContinuation(lines.join('\n').trim());
}

function buildChatExportText(session) {
  if (!session) return '';
  if (session.kind === 'compacted' && session.compaction?.text) {
    return buildCompactedChatExportText(session);
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const lines = [...exportHeaderLines(session), 'Messages:', ''];
  appendMessages(lines, session, messages);
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
  buildCompactedChatExportText,
  buildChatExportText,
  buildSessionExportResponse
};
