const { appError } = require('../errors');

function isJsonMediaType(contentType) {
  if (typeof contentType !== 'string') return false;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireJsonObjectBody(req, _res, next) {
  try {
    if (!isJsonMediaType(req.get('Content-Type'))) {
      throw appError(415, 'Content-Type must be application/json.');
    }
    if (!isPlainObject(req.body)) {
      throw appError(400, 'Request body must be a JSON object.');
    }
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { isJsonMediaType, isPlainObject, requireJsonObjectBody };
