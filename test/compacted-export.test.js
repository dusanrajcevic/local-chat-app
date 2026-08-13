const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-compacted-export-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const {
  addMessage,
  createSession,
  getSessionExport,
  upsertCompactedSession
} = require('../src/server/services/session-service');

async function createCompactedConversation(title = 'Continuation export') {
  const parent = await createSession({ title, aiName: 'ChatGPT' });
  await addMessage(parent.id, { sender: 'me', text: 'Original source question that should stay archival.' });
  await addMessage(parent.id, { sender: 'bot', text: 'Original source answer that should stay archival.' });

  const compacted = await upsertCompactedSession(parent.id, {
    requestId: `compact:req:export-${Date.now()}`,
    compactedMessage: 'Condensed context containing the decisions needed for continuation.',
    providerKey: 'chatgpt'
  });

  return { parent, child: compacted.session };
}

test.before(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  await ensureBaseFiles();
});

test.after(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('compacted-session export uses compacted context followed by continuation messages', async () => {
  const { child } = await createCompactedConversation();
  await addMessage(child.id, { sender: 'me', text: 'Continue with the export implementation.' });
  await addMessage(child.id, { sender: 'bot', text: 'The compacted continuation is ready.' });

  const exported = await getSessionExport(child.id);

  assert.equal(exported.format, 'copy-entire-chat');
  assert.equal(exported.session.kind, 'compacted');
  assert.match(exported.text, /Below is the context from a previous conversation/);
  assert.match(exported.text, /Compacted context \(2 source messages\):/);
  assert.match(exported.text, /Condensed context containing the decisions needed for continuation\./);
  assert.match(exported.text, /Messages after compaction:/);
  assert.match(exported.text, /Continue with the export implementation\./);
  assert.match(exported.text, /The compacted continuation is ready\./);
  assert.doesNotMatch(exported.text, /Original source question that should stay archival\./);
  assert.doesNotMatch(exported.text, /Original source answer that should stay archival\./);
});

test('normal parent export remains the full archival transcript', async () => {
  const { parent, child } = await createCompactedConversation('Archival parent export');
  await addMessage(child.id, { sender: 'me', text: 'Mirrored continuation stored in both sessions.' });

  const exported = await getSessionExport(parent.id);

  assert.equal(exported.session.kind, 'normal');
  assert.match(exported.text, /Messages:/);
  assert.match(exported.text, /Original source question that should stay archival\./);
  assert.match(exported.text, /Original source answer that should stay archival\./);
  assert.match(exported.text, /Mirrored continuation stored in both sessions\./);
  assert.doesNotMatch(exported.text, /Compacted context \(/);
  assert.doesNotMatch(exported.text, /Condensed context containing the decisions needed for continuation\./);
});

test('compacted export with no continuation clearly represents an empty post-compaction tail', async () => {
  const { child } = await createCompactedConversation('Fresh compacted export');

  const exported = await getSessionExport(child.id);

  assert.match(exported.text, /Compacted context \(2 source messages\):/);
  assert.match(exported.text, /Condensed context containing the decisions needed for continuation\./);
  assert.match(exported.text, /\[No messages after compaction\]/);
  assert.doesNotMatch(exported.text, /\[No messages yet\]/);
});
