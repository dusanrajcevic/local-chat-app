const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let navigatorModule;

before(async () => {
  navigatorModule = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'message-navigator.mjs')).href
  );
});

test('message navigator previews normalize markdown and truncate after eight words', () => {
  assert.equal(
    navigatorModule.createMessagePreview('  **Hello**   [local app](https://example.test)  '),
    'Hello local app'
  );
  assert.equal(
    navigatorModule.createMessagePreview('One two three four five six seven eight nine ten'),
    'One two three four five six seven eight...'
  );
});

test('message navigator creates one entry per user-authored message only', () => {
  const entries = navigatorModule.getNavigableMessages({
    messages: [
      { id: 'm1', sender: 'me', text: 'First question' },
      { id: 'm2', sender: 'bot', text: 'Assistant reply' },
      { id: 'm3', sender: 'me', text: 'Second question with a few more words' },
      { id: 'm4', sender: 'bot', text: 'Second reply' }
    ]
  });

  assert.deepEqual(entries, [
    { id: 'm1', number: 1, preview: 'First question' },
    { id: 'm3', number: 2, preview: 'Second question with a few more words' }
  ]);
});

test('message navigator handles missing and empty sessions without entries', () => {
  assert.deepEqual(navigatorModule.getNavigableMessages(null), []);
  assert.deepEqual(navigatorModule.getNavigableMessages({ messages: [] }), []);
  assert.equal(navigatorModule.createMessagePreview('   '), 'Empty message');
});
