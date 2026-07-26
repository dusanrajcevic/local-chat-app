const nodeCrypto = require('node:crypto');
const { appError } = require('../errors');

const FINGERPRINT_VERSION = 1;

function createMessageRequestPayload({ text, sender, source, providerKey }) {
  return {
    version: FINGERPRINT_VERSION,
    text,
    sender: sender || null,
    source: source || null,
    providerKey: providerKey || null
  };
}

function fingerprintMessageRequest(payload) {
  const digest = nodeCrypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');

  return `sha256:${digest}`;
}

function legacyMessageMatchesPayload(message, payload) {
  return (
    message.text === payload.text &&
    (payload.sender === null || message.sender === payload.sender) &&
    (message.source || null) === payload.source &&
    (message.providerKey || null) === payload.providerKey
  );
}

function bindExistingMessageToPayload(message, payload, fingerprint) {
  if (message.clientIdempotencyFingerprint) {
    if (message.clientIdempotencyFingerprint !== fingerprint) {
      throw appError(409, 'Idempotency key was already used with a different message payload.');
    }
    return false;
  }

  if (!legacyMessageMatchesPayload(message, payload)) {
    throw appError(409, 'Idempotency key was already used with a different message payload.');
  }

  message.clientIdempotencyFingerprint = fingerprint;
  return true;
}

module.exports = {
  FINGERPRINT_VERSION,
  createMessageRequestPayload,
  fingerprintMessageRequest,
  legacyMessageMatchesPayload,
  bindExistingMessageToPayload
};
