const { appError } = require('./errors');
const { FOLDER_ID_PATTERN, IDEMPOTENCY_KEY_PATTERN } = require('./config');

function cleanName(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanText(value) {
  return String(value || '').trim();
}

function validateId(value, pattern, label) {
  const idValue = String(value || '').trim();
  if (!pattern.test(idValue)) throw appError(400, `${label} is invalid.`);
  return idValue;
}

function optionalFolderId(value) {
  const folderId = String(value || '').trim();
  if (!folderId) return null;
  return validateId(folderId, FOLDER_ID_PATTERN, 'Folder ID');
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw appError(400, 'Idempotency key is invalid.');
  return key;
}

module.exports = {
  cleanName,
  cleanText,
  validateId,
  optionalFolderId,
  normalizeIdempotencyKey
};
