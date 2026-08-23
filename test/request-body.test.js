const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRequestError } = require('../src/server/errors');
const {
  isJsonMediaType,
  isPlainObject,
  recordJsonBodyPresence,
  requireJsonObjectBody
} = require('../src/server/middleware/request-body');

function runMiddleware({ contentType, body, rawBody }) {
  return new Promise((resolve) => {
    const req = {
      body,
      get(name) {
        return name.toLowerCase() === 'content-type' ? contentType : undefined;
      }
    };

    const serializedBody = rawBody ?? (body === undefined ? '' : JSON.stringify(body));

    recordJsonBodyPresence(req, {}, Buffer.from(serializedBody));
    requireJsonObjectBody(req, {}, (error) => resolve(error || null));
  });
}

test('JSON media type detection accepts standard and structured-suffix JSON', () => {
  assert.equal(isJsonMediaType('application/json'), true);
  assert.equal(isJsonMediaType('Application/JSON; Charset=UTF-8'), true);
  assert.equal(isJsonMediaType('application/vnd.local-chat+json'), true);
  assert.equal(isJsonMediaType('text/json'), false);
  assert.equal(isJsonMediaType('text/plain'), false);
  assert.equal(isJsonMediaType(undefined), false);
});

test('plain-object detection rejects arrays, null, and non-object values', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('value'), false);
  assert.equal(isPlainObject(new Date()), false);
});

test('request-body middleware accepts parsed JSON objects', async () => {
  assert.equal(await runMiddleware({ contentType: 'application/json; charset=utf-8', body: { title: 'Chat' } }), null);
  assert.equal(await runMiddleware({ contentType: 'application/vnd.local-chat+json', body: {} }), null);
});

test('request-body middleware rejects an empty JSON request', async () => {
  const error = await runMiddleware({
    contentType: 'application/json',
    body: {},
    rawBody: ''
  });

  assert.equal(error.status, 400);
  assert.match(error.message, /json object/i);
});

test('request-body middleware rejects missing or unsupported content types with 415', async () => {
  for (const contentType of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded']) {
    const error = await runMiddleware({ contentType, body: {} });
    assert.equal(error.status, 415);
    assert.match(error.message, /content-type/i);
  }
});

test('request-body middleware rejects non-object JSON bodies with 400', async () => {
  for (const body of [undefined, null, [], 'text', 1, true]) {
    const error = await runMiddleware({ contentType: 'application/json', body });
    assert.equal(error.status, 400);
    assert.match(error.message, /json object/i);
  }
});

test('body-parser errors are normalized to stable public responses', () => {
  const parseError = normalizeRequestError({ type: 'entity.parse.failed' });
  assert.equal(parseError.status, 400);
  assert.equal(parseError.message, 'Request body contains invalid JSON.');

  const sizeError = normalizeRequestError({ type: 'entity.too.large' });
  assert.equal(sizeError.status, 413);
  assert.equal(sizeError.message, 'Request body is too large.');

  for (const type of ['charset.unsupported', 'encoding.unsupported']) {
    const encodingError = normalizeRequestError({ type });
    assert.equal(encodingError.status, 415);
    assert.equal(encodingError.message, 'Request body encoding is not supported.');
  }
});

test('only routes that consume bodies install the JSON-object middleware', () => {
  const registrations = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (pathname, ...handlers) => registrations.push({ method: method.toUpperCase(), pathname, handlers });
  }

  require('../src/server/routes/active-session').registerActiveSessionRoutes(app);
  require('../src/server/routes/folders').registerFolderRoutes(app);
  require('../src/server/routes/sessions').registerSessionRoutes(app);

  const expectedBodyRoutes = new Set([
    'PUT /api/active-session',
    'POST /api/folders',
    'PATCH /api/folders/:folderId',
    'POST /api/sessions',
    'PUT /api/sessions/:sessionId/compaction',
    'PATCH /api/sessions/:sessionId',
    'PATCH /api/sessions/:sessionId/bot-name',
    'POST /api/sessions/:sessionId/messages',
    'PATCH /api/sessions/:sessionId/messages/:messageId',
    'PATCH /api/sessions/:sessionId/pin'
  ]);

  for (const route of registrations) {
    const key = `${route.method} ${route.pathname}`;
    const hasBodyMiddleware = route.handlers.includes(requireJsonObjectBody);
    assert.equal(hasBodyMiddleware, expectedBodyRoutes.has(key), key);
  }
});
