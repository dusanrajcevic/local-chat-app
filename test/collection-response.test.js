const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOffset,
  normalizePageLimit,
  paginationFromQuery,
  paginateItems,
  applyPaginationHeaders,
  collectionEtag,
  ifNoneMatchMatches
} = require('../src/server/http/collection-response');

function createResponseRecorder() {
  const headers = new Map();
  return {
    headers,
    set(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    }
  };
}

test('pagination normalization preserves legacy unlimited session listings', () => {
  assert.equal(normalizeOffset('12'), 12);
  assert.equal(normalizeOffset('-1'), 0);
  assert.equal(normalizePageLimit('9999', { max: 500 }), 500);

  assert.deepEqual(
    paginationFromQuery({}, { fallback: 100, max: 1000, unlimitedWhenOmitted: true }),
    { offset: 0, limit: null }
  );
  assert.deepEqual(
    paginationFromQuery({ offset: '20' }, { fallback: 100, max: 1000, unlimitedWhenOmitted: true }),
    { offset: 20, limit: 100 }
  );
});

test('pagination slices collections and emits navigation headers without changing the body shape', () => {
  const page = paginateItems(['a', 'b', 'c', 'd', 'e'], { offset: 2, limit: 2 });
  assert.deepEqual(page.items, ['c', 'd']);
  assert.equal(page.total, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 4);

  const res = createResponseRecorder();
  applyPaginationHeaders(res, '/api/sessions?q=kept&offset=2&limit=2', page);
  assert.equal(res.headers.get('x-total-count'), '5');
  assert.equal(res.headers.get('x-page-offset'), '2');
  assert.equal(res.headers.get('x-page-limit'), '2');
  assert.equal(res.headers.get('x-has-more'), 'true');
  assert.match(res.headers.get('link'), /q=kept/);
  assert.match(res.headers.get('link'), /rel="prev"/);
  assert.match(res.headers.get('link'), /rel="next"/);
});

test('collection etags are stable for one revision and support weak If-None-Match comparison', () => {
  const first = collectionEtag('sessions', 'epoch-4', { offset: 0, limit: 50 });
  const same = collectionEtag('sessions', 'epoch-4', { offset: 0, limit: 50 });
  const changedPage = collectionEtag('sessions', 'epoch-4', { offset: 50, limit: 50 });
  const changedRevision = collectionEtag('sessions', 'epoch-5', { offset: 0, limit: 50 });

  assert.equal(first, same);
  assert.notEqual(first, changedPage);
  assert.notEqual(first, changedRevision);
  assert.equal(ifNoneMatchMatches(first, first), true);
  assert.equal(ifNoneMatchMatches(first.replace(/^W\//, ''), first), true);
  assert.equal(ifNoneMatchMatches(`"other", ${first}`, first), true);
  assert.equal(ifNoneMatchMatches('*', first), true);
  assert.equal(ifNoneMatchMatches('"other"', first), false);
});
