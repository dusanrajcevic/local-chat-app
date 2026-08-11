const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let searchModule;

before(async () => {
  searchModule = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'controllers', 'search.mjs')).href
  );
});

test('search highlighting preserves text while marking case-insensitive matches', () => {
  const segments = searchModule.highlightSegments('Use atomic writes and ATOMIC recovery.', 'atomic');

  assert.deepEqual(segments, [
    { text: 'Use ', match: false },
    { text: 'atomic', match: true },
    { text: ' writes and ', match: false },
    { text: 'ATOMIC', match: true },
    { text: ' recovery.', match: false }
  ]);
});

test('search snippets preserve source punctuation while normalizing whitespace', () => {
  const segments = searchModule.highlightSegments('Discuss  **local-first** storage and `atomic` writes.', 'atomic');

  assert.equal(
    segments.map((segment) => segment.text).join(''),
    'Discuss **local-first** storage and `atomic` writes.'
  );
  assert.equal(segments.find((segment) => segment.match)?.text, 'atomic');
});

test('search dates use compact month and day labels', () => {
  const formatted = searchModule.formatSearchDate('2026-08-06T12:00:00.000Z', 'en-US');
  assert.match(formatted, /^Aug 6$/);
});
