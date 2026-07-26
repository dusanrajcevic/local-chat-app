const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-idempotency-test-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const { createSession, addMessage, readSession } = require('../src/server/services/session-service');
const {
  createMessageRequestPayload,
  fingerprintMessageRequest,
  bindExistingMessageToPayload
} = require('../src/server/services/message-idempotency');

test.before(async () => {
  await ensureBaseFiles();
});

test.after(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

async function newSession(title) {
  return createSession({ title, aiName: 'Test Bot' });
}

test('message request fingerprints are deterministic and field-sensitive', () => {
  const payload = createMessageRequestPayload({
    text: 'Saved text',
    sender: 'me',
    source: 'browser extension',
    providerKey: 'chatgpt'
  });
  const first = fingerprintMessageRequest(payload);
  const second = fingerprintMessageRequest({ ...payload });

  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.notEqual(fingerprintMessageRequest({ ...payload, text: 'Changed text' }), first);
  assert.notEqual(fingerprintMessageRequest({ ...payload, sender: null }), first);
  assert.notEqual(fingerprintMessageRequest({ ...payload, source: 'manual' }), first);
  assert.notEqual(fingerprintMessageRequest({ ...payload, providerKey: 'claude' }), first);
});

test('legacy keyed messages are checked against the payload and upgraded in memory', () => {
  const payload = createMessageRequestPayload({
    text: 'Legacy message',
    sender: null,
    source: 'extension',
    providerKey: 'chatgpt'
  });
  const fingerprint = fingerprintMessageRequest(payload);
  const message = {
    sender: 'me',
    text: 'Legacy message',
    source: 'extension',
    providerKey: 'chatgpt'
  };

  assert.equal(bindExistingMessageToPayload(message, payload, fingerprint), true);
  assert.equal(message.clientIdempotencyFingerprint, fingerprint);
  assert.equal(bindExistingMessageToPayload(message, payload, fingerprint), false);
  assert.throws(
    () =>
      bindExistingMessageToPayload(
        message,
        { ...payload, text: 'Different' },
        fingerprintMessageRequest({ ...payload, text: 'Different' })
      ),
    (error) => error.status === 409 && /different message payload/i.test(error.message)
  );
});

test('identical normalized retries return the original automatic-sender message', async () => {
  const session = await newSession('Normalized retry');
  const key = 'normalized-retry-0001';
  const first = await addMessage(session.id, {
    text: '  Saved text  ',
    source: ' browser   extension ',
    providerKey: ' chatgpt ',
    idempotencyKey: key
  });

  await addMessage(session.id, { text: 'Intervening explicit message', sender: 'me' });

  const retry = await addMessage(session.id, {
    text: 'Saved text',
    source: 'browser extension',
    providerKey: 'chatgpt',
    idempotencyKey: key
  });

  assert.equal(first.created, true);
  assert.equal(first.message.sender, 'me');
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, first.message.id);

  const stored = await readSession(session.id);
  assert.equal(stored.messages.length, 2);
});

test('reusing a key with changed normalized content returns a conflict', async () => {
  const session = await newSession('Payload conflicts');
  const cases = [
    [
      { text: 'Original', sender: 'me' },
      { text: 'Changed', sender: 'me' }
    ],
    [
      { text: 'Sender', sender: 'me' },
      { text: 'Sender', sender: 'bot' }
    ],
    [
      { text: 'Source', sender: 'me', source: 'extension' },
      { text: 'Source', sender: 'me', source: 'manual' }
    ],
    [
      { text: 'Provider', sender: 'me', providerKey: 'chatgpt' },
      { text: 'Provider', sender: 'me', providerKey: 'claude' }
    ]
  ];

  for (const [index, [original, changed]] of cases.entries()) {
    const key = `payload-conflict-${index}-0001`;
    await addMessage(session.id, { ...original, idempotencyKey: key });
    await assert.rejects(
      addMessage(session.id, { ...changed, idempotencyKey: key }),
      (error) => error.status === 409 && /different message payload/i.test(error.message)
    );
  }

  const stored = await readSession(session.id);
  assert.equal(stored.messages.length, cases.length);
});

test('concurrent mixed-payload reuse creates one message and rejects the other', async () => {
  const session = await newSession('Concurrent payload conflict');
  const key = 'concurrent-conflict-0001';
  const results = await Promise.allSettled([
    addMessage(session.id, { text: 'First candidate', sender: 'me', idempotencyKey: key }),
    addMessage(session.id, { text: 'Second candidate', sender: 'me', idempotencyKey: key })
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.created, true);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);

  const stored = await readSession(session.id);
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].clientIdempotencyKey, key);
});
