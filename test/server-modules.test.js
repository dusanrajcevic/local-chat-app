const test = require('node:test');
const assert = require('node:assert/strict');

const { FOLDER_ID_PATTERN } = require('../src/server/config');
const {
  cleanName,
  cleanText,
  optionalFolderId,
  normalizeIdempotencyKey,
  optionalMessageSender,
  validateId
} = require('../src/server/validation');
const { compactSnippet, normalizeLimit, normalizeSearchText } = require('../src/server/services/search-service');
const { summarizeSession, botNameForSession } = require('../src/server/services/session-format');

test('server validation utilities normalize public API inputs consistently', () => {
  assert.equal(cleanName('  one\n two\tthree  '), 'one two three');
  assert.equal(optionalFolderId(''), null);
  assert.equal(optionalFolderId('   '), null);
  assert.equal(optionalFolderId('folder_1700000000000_deadbeef'), 'folder_1700000000000_deadbeef');
  assert.equal(normalizeIdempotencyKey(' auto:save.key-0001 '), 'auto:save.key-0001');
  assert.equal(normalizeIdempotencyKey('   '), '');
  assert.throws(() => validateId('../escape', FOLDER_ID_PATTERN, 'Folder ID'), /Folder ID is invalid/);
  assert.throws(() => normalizeIdempotencyKey('../escape'), /Idempotency key is invalid/);
  assert.throws(() => cleanName({ name: 'object' }, 80, 'Folder name'), /Folder name must be a string/);
  assert.throws(() => cleanText(['message'], 'Message text'), /Message text must be a string/);
  assert.throws(() => optionalFolderId(false), /Folder ID must be a string/);
  assert.throws(() => normalizeIdempotencyKey({ key: 'object' }), /Idempotency key must be a string/);
  assert.throws(() => optionalMessageSender(true), /Message sender must be/);
  assert.equal(optionalMessageSender(undefined), null);
  assert.equal(optionalMessageSender('me'), 'me');
});

test('server search utilities normalize limits and build compact snippets', () => {
  assert.equal(normalizeSearchText('  Atomic\nWrites  '), 'atomic writes');
  assert.equal(normalizeLimit('9999'), 500);
  assert.equal(normalizeLimit('-1'), 100);
  assert.match(
    compactSnippet('before '.repeat(50) + 'atomic writes are important' + ' after'.repeat(50), 'atomic writes'),
    /atomic writes/
  );
});

test('server session formatting hides missing/empty metadata behind stable defaults', () => {
  const session = {
    id: 'chat_1700000000000_deadbeef',
    title: '  ',
    aiName: '  ',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    messages: [{ id: 'msg_1700000000000_deadbeef', text: 'Hello' }]
  };

  assert.equal(botNameForSession(session), 'AI Bot');
  assert.deepEqual(summarizeSession(session, '2026-01-01'), {
    id: 'chat_1700000000000_deadbeef',
    title: 'Untitled chat',
    aiName: 'AI Bot',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    dateFolder: '2026-01-01',
    pinnedFolderId: null,
    messageCount: 1,
    trashed: false
  });
});
