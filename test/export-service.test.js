const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const serverExport = require('../src/server/services/export-service');

let webExport;

test.before(async () => {
  webExport = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'export.mjs')).href);
});

function compactedFixture(messages = []) {
  return {
    id: 'chat_1700000000000_deadbeef',
    title: 'Architecture review (compacted)',
    aiName: 'ChatGPT',
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:10:00.000Z',
    kind: 'compacted',
    parentSessionId: 'chat_1700000000000_feedface',
    compaction: {
      text: 'Use the local JSON archive and keep continuation writes mirrored.',
      requestId: 'compact:req:export-contract-001',
      sourceMessageCount: 4,
      throughMessageId: 'msg_1700000000000_deadbeef',
      createdAt: '2026-08-15T12:05:00.000Z'
    },
    messages
  };
}

test('server and web exporters share compacted continuation semantics', () => {
  const session = compactedFixture([
    {
      id: 'msg_1700000000001_deadbeef',
      sender: 'me',
      text: 'Continue from the compacted state.',
      createdAt: '2026-08-15T12:06:00.000Z'
    },
    {
      id: 'msg_1700000000002_deadbeef',
      sender: 'bot',
      text: 'Continuation acknowledged.',
      createdAt: '2026-08-15T12:07:00.000Z'
    }
  ]);

  const serverText = serverExport.buildChatExportText(session);
  const webText = webExport.buildChatExportText(session, { getBotName: (item) => item.aiName });

  assert.equal(webText, serverText);
  assert.match(serverText, /Compacted context \(4 source messages\):/);
  assert.match(serverText, /Use the local JSON archive and keep continuation writes mirrored\./);
  assert.match(serverText, /Messages after compaction:/);
  assert.match(serverText, /Continue from the compacted state\./);
  assert.match(serverText, /Continuation acknowledged\./);
});

test('normal export format remains unchanged by compacted continuation support', () => {
  const session = {
    id: 'chat_1700000000003_deadbeef',
    title: 'Normal archive',
    aiName: 'ChatGPT',
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:01:00.000Z',
    kind: 'normal',
    messages: [
      {
        id: 'msg_1700000000003_deadbeef',
        sender: 'me',
        text: 'Keep the ordinary export format.',
        createdAt: '2026-08-15T12:01:00.000Z'
      }
    ]
  };

  const text = serverExport.buildChatExportText(session);

  assert.match(text, /Messages:/);
  assert.match(text, /Keep the ordinary export format\./);
  assert.doesNotMatch(text, /Compacted context/);
  assert.doesNotMatch(text, /Messages after compaction/);
});
