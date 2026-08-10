const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('message navigator keeps tightly packed collapsed markers and removes the marker column when expanded', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  assert.match(styles, /\.message-nav-list\s*\{[^}]*gap:\s*0;/s);
  assert.match(
    styles,
    /\.message-nav-item\s*\{[^}]*height:\s*6px;[^}]*min-height:\s*6px;[^}]*flex:\s*0 0 6px;[^}]*padding:\s*0;/s
  );
  assert.match(styles, /\.message-nav-preview\s*\{[^}]*display:\s*none;/s);
  assert.match(
    styles,
    /\.message-nav-line\s*\{[^}]*width:\s*17px;[^}]*height:\s*1\.5px;[^}]*flex:\s*0 0 17px;/s
  );
  assert.match(
    styles,
    /\.message-navigator:hover \.message-nav-line,[\s\S]*?\.message-navigator:focus-within \.message-nav-line\s*\{[^}]*display:\s*none;/
  );
  assert.match(
    styles,
    /\.message-navigator:hover \.message-nav-preview,[\s\S]*?\.message-navigator:focus-within \.message-nav-preview\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/
  );
});
