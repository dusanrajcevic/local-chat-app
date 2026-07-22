const { appError } = require('./errors');
const { FOLDER_ID_PATTERN, IDEMPOTENCY_KEY_PATTERN } = require('./config');

function optionalString(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw appError(400, `${label} must be a string.`);
  return value;
}

function cleanName(value, maxLength = 160, label = 'Value') {
  return optionalString(value, label).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanText(value, label = 'Value') {
  return optionalString(value, label).trim();
}

function validateId(value, pattern, label) {
  if (typeof value !== 'string') throw appError(400, `${label} is invalid.`);
  const idValue = value.trim();
  if (!pattern.test(idValue)) throw appError(400, `${label} is invalid.`);
  return idValue;
}

function optionalFolderId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw appError(400, 'Folder ID must be a string.');
  const folderId = value.trim();
  if (!folderId) return null;
  return validateId(folderId, FOLDER_ID_PATTERN, 'Folder ID');
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw appError(400, 'Idempotency key must be a string.');
  const key = value.trim();
  if (!key) return '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw appError(400, 'Idempotency key is invalid.');
  return key;
}

function optionalMessageSender(value) {
  if (value === undefined || value === null) return null;
  if (value !== 'me' && value !== 'bot') throw appError(400, 'Message sender must be "me" or "bot".');
  return value;
}

module.exports = {
  cleanName,
  cleanText,
  validateId,
  optionalFolderId,
  normalizeIdempotencyKey,
  optionalMessageSender
};
