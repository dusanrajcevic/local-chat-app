const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('local app markup exposes labels, live status, and modal descriptions', () => {
  const html = read('public/index.html');

  assert.match(html, /<label class="sr-only" for="messageInput">Message<\/label>/);
  assert.match(html, /<label class="sr-only" for="pinSelect">Pin current session to folder<\/label>/);
  assert.match(html, /<label class="sr-only" for="editMessageTextarea">Edit message text<\/label>/);
  assert.match(html, /id="appStatus"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="toggleTrashBtn"[\s\S]+aria-expanded="false"[\s\S]+aria-controls="trashList"/);
  assert.match(html, /aria-describedby="extensionPairingDescription"/);
  assert.match(html, /id="searchChatsBtn"[^>]+aria-label="Search chats"/);
  assert.match(html, /<label class="sr-only" for="chatSearchInput">Search chats<\/label>/);
  assert.match(html, /id="closeChatSearchBtn"[^>]+aria-label="Close search"/);
});

test('extension popup exposes labelled inputs, focus styles, and an announced status region', () => {
  const html = read('browser-extension/popup.html');

  assert.match(html, /<label for="localAppUrl">Local app URL<\/label>/);
  assert.match(html, /<label for="pairingCode"[^>]*>Pairing code<\/label>/);
  assert.match(html, /id="pairingCode"[\s\S]+aria-describedby="pairingHint"/);
  assert.match(html, /id="status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /button:focus-visible,[\s\S]+input:focus-visible/);
});

test('required Playwright smoke flow runs the dynamic accessibility audit', () => {
  const smoke = read('e2e/playwright-smoke.mjs');

  assert.match(smoke, /collectAccessibilityIssues/);
  assert.match(smoke, /Initial UI accessibility audit failed/);
  assert.match(smoke, /Dynamic UI accessibility audit failed/);
  assert.match(smoke, /activeElement/);
});
