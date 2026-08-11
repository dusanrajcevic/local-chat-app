const nodeCrypto = require('node:crypto');
const {
  AUTH_TOKEN,
  EXTENSION_AUTH_FILE,
  ALLOWED_EXTENSION_IDS,
  EXTENSION_ID_PATTERN,
  CURRENT_SCHEMA_VERSION
} = require('../config');
const { appError } = require('../errors');
const { readJson, writeJson, withLock } = require('../storage/file-store');

const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PAIRING_CODE_PATTERN = /^[A-F0-9]{12}$/;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const AUTH_LOCK_KEY = 'extension-auth';

let pendingPairing = null;

function extensionIdFromOrigin(origin) {
  const match = String(origin || '').match(/^chrome-extension:\/\/([a-p]{32})$/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeExtensionId(value) {
  const extensionId = String(value || '')
    .trim()
    .toLowerCase();
  return EXTENSION_ID_PATTERN.test(extensionId) ? extensionId : null;
}

function isAllowedExtensionId(extensionId) {
  const normalized = normalizeExtensionId(extensionId);
  if (!normalized) return false;
  return ALLOWED_EXTENSION_IDS.size === 0 || ALLOWED_EXTENSION_IDS.has(normalized);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return nodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashExtensionToken(token) {
  const digest = nodeCrypto
    .createHash('sha256')
    .update(String(token || ''), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function validateStoredExtensionAuth(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw appError(500, 'Stored extension pairing data is invalid.');
  }

  if (record.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(record.pairings)) {
    throw appError(500, 'Stored extension pairing data is invalid.');
  }

  const seenIds = new Set();
  for (const pairing of record.pairings) {
    if (!pairing || typeof pairing !== 'object' || Array.isArray(pairing)) {
      throw appError(500, 'Stored extension pairing data is invalid.');
    }

    const extensionId = normalizeExtensionId(pairing.extensionId);
    if (!extensionId || extensionId !== pairing.extensionId || seenIds.has(extensionId)) {
      throw appError(500, 'Stored extension pairing data is invalid.');
    }
    seenIds.add(extensionId);

    if (!TOKEN_HASH_PATTERN.test(String(pairing.tokenHash || ''))) {
      throw appError(500, 'Stored extension pairing data is invalid.');
    }

    if (typeof pairing.pairedAt !== 'string' || Number.isNaN(Date.parse(pairing.pairedAt))) {
      throw appError(500, 'Stored extension pairing data is invalid.');
    }
  }

  return record;
}

async function readExtensionAuth() {
  try {
    const record = await readJson(EXTENSION_AUTH_FILE);
    return validateStoredExtensionAuth(record);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schemaVersion: CURRENT_SCHEMA_VERSION, pairings: [] };
    }
    throw error;
  }
}

function createPairingCode(now = Date.now()) {
  const code = nodeCrypto.randomBytes(6).toString('hex').toUpperCase();
  pendingPairing = {
    code,
    expiresAt: now + PAIRING_CODE_TTL_MS,
    attemptsRemaining: MAX_PAIRING_ATTEMPTS
  };

  return {
    code,
    expiresAt: new Date(pendingPairing.expiresAt).toISOString()
  };
}

function assertPairingCode(code, now = Date.now()) {
  const normalizedCode = String(code || '')
    .trim()
    .toUpperCase();
  if (!PAIRING_CODE_PATTERN.test(normalizedCode)) {
    throw appError(400, 'Pairing code is invalid.');
  }

  if (!pendingPairing || pendingPairing.expiresAt <= now) {
    pendingPairing = null;
    throw appError(410, 'Pairing code has expired. Generate a new code in the local app.');
  }

  if (!timingSafeStringEqual(normalizedCode, pendingPairing.code)) {
    pendingPairing.attemptsRemaining -= 1;
    if (pendingPairing.attemptsRemaining <= 0) pendingPairing = null;
    throw appError(401, 'Pairing code is incorrect.');
  }

  pendingPairing = null;
}

function assertExtensionIdentity(origin, extensionIdHeader) {
  const originExtensionId = extensionIdFromOrigin(origin);
  const headerExtensionId = normalizeExtensionId(extensionIdHeader);

  if (!originExtensionId || !headerExtensionId || originExtensionId !== headerExtensionId) {
    throw appError(403, 'Extension identity does not match the request origin.');
  }

  if (!isAllowedExtensionId(originExtensionId)) {
    throw appError(403, 'This browser extension is not allowed to access Local Chat App.');
  }

  return originExtensionId;
}

async function pairExtension({ origin, extensionIdHeader, code }) {
  const extensionId = assertExtensionIdentity(origin, extensionIdHeader);
  assertPairingCode(code);

  const token = nodeCrypto.randomBytes(32).toString('base64url');
  const tokenHash = hashExtensionToken(token);
  const pairedAt = new Date().toISOString();

  await withLock(AUTH_LOCK_KEY, async () => {
    const auth = await readExtensionAuth();
    const pairings = auth.pairings.filter((pairing) => pairing.extensionId !== extensionId);
    pairings.push({ extensionId, tokenHash, pairedAt });
    await writeJson(EXTENSION_AUTH_FILE, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pairings
    });
  });

  return { token, extensionId, pairedAt };
}

async function authorizeExtension({ origin, extensionIdHeader, token }) {
  const extensionId = assertExtensionIdentity(origin, extensionIdHeader);
  const suppliedToken = String(token || '');
  if (!suppliedToken) return false;

  if (AUTH_TOKEN && timingSafeStringEqual(suppliedToken, AUTH_TOKEN)) return true;

  const auth = await readExtensionAuth();
  const pairing = auth.pairings.find((item) => item.extensionId === extensionId);
  if (!pairing) return false;

  return timingSafeStringEqual(hashExtensionToken(suppliedToken), pairing.tokenHash);
}

function resetPairingStateForTests() {
  pendingPairing = null;
}

module.exports = {
  EXTENSION_ID_PATTERN,
  PAIRING_CODE_PATTERN,
  PAIRING_CODE_TTL_MS,
  extensionIdFromOrigin,
  normalizeExtensionId,
  isAllowedExtensionId,
  hashExtensionToken,
  validateStoredExtensionAuth,
  readExtensionAuth,
  createPairingCode,
  pairExtension,
  authorizeExtension,
  resetPairingStateForTests
};
