const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'browser-extension/content.css'), 'utf8');
const sidebar = fs.readFileSync(path.join(root, 'browser-extension/content-sidebar.js'), 'utf8');
const composer = fs.readFileSync(path.join(root, 'browser-extension/content-composer.js'), 'utf8');

test('extension-owned dialogs carry a provider marker for scoped style isolation', () => {
  assert.match(sidebar, /overlay\.dataset\.localChatProvider = providerInfo\(\)\.key \|\| 'unknown'/);
  assert.match(composer, /overlay\.dataset\.localChatProvider = providerInfo\(\)\.key \|\| 'unknown'/);
});

test('compact create and confirm dialogs use dedicated modal layout classes', () => {
  assert.match(sidebar, /local-chat-modal-card local-chat-modal-card--compact/);
  assert.match(sidebar, /class="local-chat-modal-form"/);
  assert.match(sidebar, /class="local-chat-modal-input"/);
  assert.match(sidebar, /class="local-chat-modal-actions"/);
  assert.match(sidebar, /class="local-chat-modal-button local-chat-modal-button--primary"/);
  assert.match(sidebar, /class="local-chat-modal-footer"/);
  assert.match(sidebar, /class="local-chat-modal-button local-chat-modal-button--danger"/);
});

test('ChatGPT modal isolation pins dialog geometry above provider page styles', () => {
  assert.match(
    css,
    /\.local-chat-modal-backdrop\[data-local-chat-provider='chatgpt'\]\s*\{[\s\S]*?z-index:\s*2147483647\s*!important;/
  );
  assert.match(
    css,
    /\.local-chat-modal-backdrop\[data-local-chat-provider='chatgpt'\] \.local-chat-modal-card--compact\s*\{[\s\S]*?width:\s*min\(460px, calc\(100vw - 44px\)\)\s*!important;/
  );
  assert.match(
    css,
    /\.local-chat-modal-backdrop\[data-local-chat-provider='chatgpt'\] \.local-chat-modal-header\s*\{[\s\S]*?justify-content:\s*space-between\s*!important;/
  );
  assert.match(
    css,
    /\.local-chat-modal-backdrop\[data-local-chat-provider='chatgpt'\] \.local-chat-modal-close\s*\{[\s\S]*?width:\s*34px\s*!important;[\s\S]*?height:\s*34px\s*!important;/
  );
  assert.match(
    css,
    /html:has\(\.local-chat-modal-backdrop\[data-local-chat-provider=['"]chatgpt['"]\]\)[\s\S]*?\.local-chat-auto-send-mount[\s\S]*?visibility:\s*hidden\s*!important;/
  );
  assert.doesNotMatch(css, /html:has\(\.local-chat-modal-backdrop\)\s+\.local-chat-auto-send-mount/);
});
