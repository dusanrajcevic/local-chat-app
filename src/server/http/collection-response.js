const nodeCrypto = require('node:crypto');

function normalizeOffset(rawValue, fallback = 0, max = 1_000_000) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function normalizePageLimit(rawValue, { fallback = 100, max = 500, unlimitedWhenOmitted = false } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return unlimitedWhenOmitted ? null : fallback;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function paginationFromQuery(query = {}, options = {}) {
  const hasOffset = query.offset !== undefined && query.offset !== null && query.offset !== '';
  const hasLimit = query.limit !== undefined && query.limit !== null && query.limit !== '';
  const unlimitedWhenOmitted = options.unlimitedWhenOmitted === true && !hasOffset && !hasLimit;
  return {
    offset: normalizeOffset(query.offset),
    limit: normalizePageLimit(query.limit, { ...options, unlimitedWhenOmitted })
  };
}

function paginateItems(items, pagination) {
  const offset = pagination.offset || 0;
  const limit = pagination.limit;
  const page = limit === null ? items.slice(offset) : items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    items: page,
    total: items.length,
    offset,
    limit: limit === null ? page.length : limit,
    hasMore,
    nextOffset: hasMore ? offset + page.length : null
  };
}

function buildPageUrl(originalUrl, offset, limit) {
  const parsed = new URL(originalUrl || '/', 'http://local.invalid');
  parsed.searchParams.set('offset', String(offset));
  parsed.searchParams.set('limit', String(limit));
  return `${parsed.pathname}${parsed.search}`;
}

function applyPaginationHeaders(res, originalUrl, page) {
  if (Number.isInteger(page.total) && page.total >= 0) res.set('X-Total-Count', String(page.total));
  res.set('X-Page-Offset', String(page.offset));
  res.set('X-Page-Limit', String(page.limit));
  res.set('X-Has-More', page.hasMore ? 'true' : 'false');

  if (!page.limit) return;
  const links = [];
  if (page.offset > 0) {
    links.push(`<${buildPageUrl(originalUrl, Math.max(0, page.offset - page.limit), page.limit)}>; rel="prev"`);
  }
  if (page.hasMore && page.nextOffset !== null) {
    links.push(`<${buildPageUrl(originalUrl, page.nextOffset, page.limit)}>; rel="next"`);
  }
  if (links.length > 0) res.set('Link', links.join(', '));
}

function collectionEtag(namespace, revision, params = {}) {
  const digest = nodeCrypto
    .createHash('sha256')
    .update(JSON.stringify([namespace, revision, params]), 'utf8')
    .digest('base64url')
    .slice(0, 27);
  return `W/"${digest}"`;
}

function normalizeOpaqueTag(value) {
  return String(value || '')
    .trim()
    .replace(/^W\//i, '');
}

function ifNoneMatchMatches(rawHeader, etag) {
  if (typeof rawHeader !== 'string' || !rawHeader.trim()) return false;
  const expected = normalizeOpaqueTag(etag);
  return rawHeader
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || normalizeOpaqueTag(value) === expected);
}

function applyConditionalHeaders(res, etag) {
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache, must-revalidate');
}

function sendNotModifiedIfFresh(req, res, etag) {
  applyConditionalHeaders(res, etag);
  if (!ifNoneMatchMatches(req.get('If-None-Match'), etag)) return false;
  res.status(304).end();
  return true;
}

module.exports = {
  normalizeOffset,
  normalizePageLimit,
  paginationFromQuery,
  paginateItems,
  applyPaginationHeaders,
  collectionEtag,
  ifNoneMatchMatches,
  applyConditionalHeaders,
  sendNotModifiedIfFresh
};
