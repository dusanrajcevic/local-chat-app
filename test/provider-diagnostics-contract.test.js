const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const diagnostics = require('../browser-extension/content-diagnostics');

const repoRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('provider diagnostic status distinguishes healthy, degraded, failed, and unsupported adapters', () => {
  assert.equal(
    diagnostics.diagnosticStatus({
      supported: true,
      messageContainers: 2,
      extractableMessages: 2,
      userMessages: 1,
      assistantMessages: 1
    }),
    'pass'
  );
  assert.equal(
    diagnostics.diagnosticStatus({
      supported: true,
      messageContainers: 2,
      extractableMessages: 1,
      userMessages: 1,
      assistantMessages: 1
    }),
    'warning'
  );
  assert.equal(
    diagnostics.diagnosticStatus({
      supported: true,
      messageContainers: 0,
      extractableMessages: 0,
      userMessages: 0,
      assistantMessages: 0
    }),
    'fail'
  );
  assert.equal(
    diagnostics.diagnosticStatus({
      supported: false,
      messageContainers: 0,
      extractableMessages: 0,
      userMessages: 0,
      assistantMessages: 0
    }),
    'unsupported'
  );
});

test('extension manifest loads provider diagnostics after shared DOM extraction', () => {
  const manifest = JSON.parse(read('browser-extension/manifest.json'));
  const scripts = manifest.content_scripts[0].js;
  const domIndex = scripts.indexOf('content-dom.js');
  const diagnosticsIndex = scripts.indexOf('content-diagnostics.js');
  const bootstrapIndex = scripts.indexOf('content.js');

  assert.ok(domIndex >= 0);
  assert.ok(diagnosticsIndex > domIndex);
  assert.ok(bootstrapIndex > diagnosticsIndex);
});

test('popup exposes an explicit provider diagnostics control without requesting extra tab permissions', () => {
  const manifest = JSON.parse(read('browser-extension/manifest.json'));
  const popup = read('browser-extension/popup.html');
  const popupScript = read('browser-extension/popup.js');

  assert.match(popup, /id="diagnose"[^>]*>Diagnose page</i);
  assert.match(popup, /id="diagnostics"[^>]*aria-labelledby="diagnosticsTitle"/i);
  assert.match(popupScript, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
  assert.match(popupScript, /GET_PROVIDER_DIAGNOSTICS/);
  assert.equal(manifest.permissions.includes('tabs'), false);
});
