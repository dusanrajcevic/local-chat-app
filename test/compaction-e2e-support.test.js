const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const supportUrl = pathToFileURL(path.join(__dirname, '..', 'e2e', 'compaction-workflow-support.mjs')).href;

let support;

test.before(async () => {
  support = await import(supportUrl);
});

test('compaction E2E protocol-text check detects request and response markers only in stored messages', () => {
  const markers = ['<<<REQUEST>>>', '<<<RESPONSE>>>'];

  assert.equal(
    support.responseHasProtocolText(
      { messages: [{ text: 'ordinary message' }, { text: 'prefix <<<REQUEST>>> suffix' }] },
      markers
    ),
    true
  );
  assert.equal(support.responseHasProtocolText({ messages: [{ text: 'ordinary message' }] }, markers), false);
  assert.equal(support.responseHasProtocolText({ messages: [] }, markers), false);
});

test('compaction E2E fixture exposes the provider sidebar, composer, and controllable response modes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'chatgpt-compaction.html'), 'utf8');

  assert.match(html, /aria-label="Chat history"/);
  assert.match(html, /id="prompt-textarea"/);
  assert.match(html, /data-testid="send-button"/);
  assert.match(html, /setMode\(value\)/);
  assert.match(html, /mode === 'malformed'/);
  assert.match(html, /mode === 'hold'/);
});

test('release verification requires the compaction E2E command', () => {
  const pkg = require('../package.json');

  assert.equal(pkg.scripts['test:compaction-e2e'], 'node e2e/compaction-workflow.mjs');
  assert.match(pkg.scripts.verify, /npm run test:compaction-e2e/);
});
