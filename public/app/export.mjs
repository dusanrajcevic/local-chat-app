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

function buildChatExportText(session, { getBotName } = {}) {
  if (!session) return '';
  const botName = typeof getBotName === 'function' ? getBotName : (item) => item?.aiName || 'AI Bot';

  const lines = [
    `Chat title: ${session.title}`,
    `AI name: ${botName(session)}`,
    `Created: ${new Date(session.createdAt).toLocaleString()}`,
    `Last updated: ${new Date(session.updatedAt).toLocaleString()}`,
    '',
    'Messages:',
    ''
  ];

  if (!session.messages.length) {
    lines.push('[No messages yet]');
    return wrapChatExportForContinuation(lines.join('\n'));
  }

  session.messages.forEach((message, index) => {
    const sender = message.sender === 'me' ? 'Me' : botName(session);
    const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'Unknown time';
    const edited = message.updatedAt ? ' · edited' : '';

    lines.push(`[${index + 1}] ${sender} — ${createdAt}${edited}`);
    lines.push(message.text);
    lines.push('');
  });

  return wrapChatExportForContinuation(lines.join('\n').trim());
}

export { CONTINUATION_CONTEXT_PROMPT, wrapChatExportForContinuation, buildChatExportText };
