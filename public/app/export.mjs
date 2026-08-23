const CONTINUATION_CONTEXT_PROMPT = [
  'Below is the context from a previous conversation. Please use it as background and continue from where we left off.',
  'Do not summarize the conversation unless I ask; use the context to answer my next message naturally.',
  '',
  '----------------------',
  ''
].join('\n');

function wrapChatExportForContinuation(text) {
  const cleanText = String(text || '').trim();
  return `${CONTINUATION_CONTEXT_PROMPT}${cleanText}`.trim();
}

function exportHeaderLines(session, botName) {
  return [
    `Chat title: ${session.title}`,
    `AI name: ${botName(session)}`,
    `Created: ${new Date(session.createdAt).toLocaleString()}`,
    `Last updated: ${new Date(session.updatedAt).toLocaleString()}`,
    ''
  ];
}

function appendMessages(lines, session, messages, botName, emptyLabel = '[No messages yet]') {
  if (!messages.length) {
    lines.push(emptyLabel);
    return;
  }

  messages.forEach((message, index) => {
    const sender = message.sender === 'me' ? 'Me' : botName(session);
    const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'Unknown time';
    const edited = message.updatedAt ? ' · edited' : '';

    lines.push(`[${index + 1}] ${sender} — ${createdAt}${edited}`);
    lines.push(message.text);
    lines.push('');
  });
}

function buildCompactedChatExportText(session, botName) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const compaction = session.compaction || {};
  const sourceCount = Number.isInteger(compaction.sourceMessageCount) ? compaction.sourceMessageCount : null;
  const contextHeading = sourceCount
    ? `Compacted context (${sourceCount} source message${sourceCount === 1 ? '' : 's'}):`
    : 'Compacted context:';
  const lines = [
    ...exportHeaderLines(session, botName),
    contextHeading,
    String(compaction.text || ''),
    '',
    'Messages after compaction:',
    ''
  ];

  appendMessages(lines, session, messages, botName, '[No messages after compaction]');
  return wrapChatExportForContinuation(lines.join('\n').trim());
}

function buildChatExportText(session, { getBotName } = {}) {
  if (!session) return '';
  const botName = typeof getBotName === 'function' ? getBotName : (item) => item?.aiName || 'AI Bot';

  if (session.kind === 'compacted' && session.compaction?.text) {
    return buildCompactedChatExportText(session, botName);
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const lines = [...exportHeaderLines(session, botName), 'Messages:', ''];
  appendMessages(lines, session, messages, botName);
  return wrapChatExportForContinuation(lines.join('\n').trim());
}

export {
  CONTINUATION_CONTEXT_PROMPT,
  wrapChatExportForContinuation,
  buildCompactedChatExportText,
  buildChatExportText
};
