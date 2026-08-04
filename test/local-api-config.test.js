const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LOCAL_APP_URL,
  isLoopbackHostname,
  normalizeBaseUrl,
  normalizeApiUrl
} = require('../browser-extension/local-api');

test('local API URL normalization accepts only loopback HTTP origins', () => {
  assert.equal(normalizeBaseUrl(''), DEFAULT_LOCAL_APP_URL);
  assert.equal(normalizeBaseUrl(' http://localhost:4321/ '), 'http://localhost:4321');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(isLoopbackHostname('127.255.10.2'), false);

  for (const unsafe of [
    'https://localhost:3000',
    'http://example.com:3000',
    'http://user:pass@localhost:3000',
    'http://localhost:3000/app',
    'http://localhost:3000/?debug=1',
    'http://localhost:3000/#fragment',
    'file:///tmp/local-chat'
  ]) {
    assert.throws(() => normalizeBaseUrl(unsafe), /local app url/i, unsafe);
  }
});

test('local API requests cannot escape the configured origin or API prefix', () => {
  assert.equal(
    normalizeApiUrl('http://localhost:3000/api/health', 'http://localhost:3000'),
    'http://localhost:3000/api/health'
  );
  assert.throws(
    () => normalizeApiUrl('http://127.0.0.1:3000/api/health', 'http://localhost:3000'),
    /refusing/i
  );
  assert.throws(
    () => normalizeApiUrl('http://localhost:3000/index.html', 'http://localhost:3000'),
    /refusing/i
  );
  assert.throws(
    () => normalizeApiUrl('https://attacker.example/api/health', 'http://localhost:3000'),
    /refusing/i
  );
});
