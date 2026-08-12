const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-compacted-message-mirroring-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;

const { MUTATION_JOURNAL_FILE } = require('../src/server/config');
const { ensureBaseFiles } = require('../src/server/storage/file-store');
const {
  recoverPendingMutation,
  setMutationFailureInjectorForTests
} = require('../src/server/storage/mutation-coordinator');
const {
  addMessage,
  createSession,
  readSession,
  upsertCompactedSession
} = require('../src/server/services/session-service');

async function createCompactedPair(title = 'Mirrored conversation') {
  const parent = await createSession({ title, aiName: 'ChatGPT' });
  await addMessage(parent.id, {
    sender: 'me',
    text: 'Source question',
    providerKey: 'chatgpt',
    idempotencyKey: 'source-question-0001'
  });
  await addMessage(parent.id, {
    sender: 'bot',
    text: 'Source answer',
    providerKey: 'chatgpt',
    idempotencyKey: 'source-answer-0001'
  });
  const compacted = await upsertCompactedSession(parent.id, {
    requestId: `compact:req:${Date.now()}`,
    compactedMessage: 'Compacted source context',
    providerKey: 'chatgpt'
  });
  return { parent, child: compacted.session };
}

function mirroredMessageBody(text, sender, idempotencyKey) {
  return {
    text,
    sender,
    source: 'browser extension',
    providerKey: 'chatgpt',
    idempotencyKey
  };
}

test.before(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  await ensureBaseFiles();
});

test.afterEach(() => {
  setMutationFailureInjectorForTests(null);
});

test.after(async () => {
  setMutationFailureInjectorForTests(null);
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('messages added to a compacted session are mirrored to its parent with one logical message id', async () => {
  const { parent, child } = await createCompactedPair();

  const userResult = await addMessage(
    child.id,
    mirroredMessageBody('Continue from the compacted context', 'me', 'mirrored-user-0001')
  );
  const botResult = await addMessage(
    child.id,
    mirroredMessageBody('Continuation response', 'bot', 'mirrored-bot-0001')
  );

  assert.equal(userResult.created, true);
  assert.equal(botResult.created, true);

  const storedParent = await readSession(parent.id);
  const storedChild = await readSession(child.id);
  assert.equal(storedParent.messages.length, 4);
  assert.equal(storedChild.messages.length, 2);
  assert.deepEqual(
    storedChild.messages.map((message) => message.id),
    storedParent.messages.slice(-2).map((message) => message.id)
  );
  assert.deepEqual(storedChild.messages, storedParent.messages.slice(-2));
});

test('automatic senders are derived from compacted-session continuation order and mirrored unchanged', async () => {
  const { parent, child } = await createCompactedPair('Automatic mirrored senders');

  const first = await addMessage(child.id, { text: 'Automatic first continuation' });
  const second = await addMessage(child.id, { text: 'Automatic second continuation' });

  assert.equal(first.message.sender, 'me');
  assert.equal(second.message.sender, 'bot');

  const storedParent = await readSession(parent.id);
  const storedChild = await readSession(child.id);
  assert.deepEqual(
    storedChild.messages.map((message) => [message.id, message.sender]),
    storedParent.messages.slice(-2).map((message) => [message.id, message.sender])
  );
});

test('normal sessions continue to store messages only in themselves', async () => {
  const session = await createSession({ title: 'Normal session', aiName: 'ChatGPT' });
  const result = await addMessage(session.id, {
    text: 'Normal message',
    sender: 'me',
    idempotencyKey: 'normal-message-0001'
  });

  assert.equal(result.created, true);
  const stored = await readSession(session.id);
  assert.equal(stored.kind, 'normal');
  assert.equal(stored.compactedSessionId, null);
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].id, result.message.id);
});

test('idempotent compacted-session retries do not duplicate either copy', async () => {
  const { parent, child } = await createCompactedPair('Idempotent mirrored continuation');
  const body = mirroredMessageBody('Save this once in both sessions', 'me', 'mirrored-retry-0001');

  const first = await addMessage(child.id, body);
  const retry = await addMessage(child.id, body);

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, first.message.id);

  const storedParent = await readSession(parent.id);
  const storedChild = await readSession(child.id);
  assert.equal(
    storedParent.messages.filter((message) => message.clientIdempotencyKey === body.idempotencyKey).length,
    1
  );
  assert.equal(
    storedChild.messages.filter((message) => message.clientIdempotencyKey === body.idempotencyKey).length,
    1
  );
});

test('compacted-session idempotency keys reject changed payloads', async () => {
  const { child } = await createCompactedPair('Mirrored payload conflict');
  const key = 'mirrored-conflict-0001';

  await addMessage(child.id, mirroredMessageBody('Original mirrored payload', 'me', key));
  await assert.rejects(
    () => addMessage(child.id, mirroredMessageBody('Changed mirrored payload', 'me', key)),
    (error) => error?.status === 409 && /different message payload/i.test(error.message)
  );
});

test('retries for messages already inside the compaction boundary are not re-added to the child', async () => {
  const parent = await createSession({ title: 'Compaction boundary retry', aiName: 'ChatGPT' });
  const body = mirroredMessageBody('Already compacted source message', 'me', 'pre-compaction-retry-0001');
  const original = await addMessage(parent.id, body);
  const compacted = await upsertCompactedSession(parent.id, {
    requestId: 'compact:req:boundary-retry-001',
    compactedMessage: 'Context containing the source message',
    providerKey: 'chatgpt'
  });

  const retry = await addMessage(compacted.session.id, body);
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, original.message.id);
  assert.deepEqual((await readSession(compacted.session.id)).messages, []);
  assert.equal((await readSession(parent.id)).messages.length, 1);
});

test('concurrent distinct compacted-session writes preserve every message in both sessions', async () => {
  const { parent, child } = await createCompactedPair('Concurrent mirrored continuation');
  const count = 24;

  const results = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      addMessage(
        child.id,
        mirroredMessageBody(
          `Mirrored concurrent message ${index}`,
          index % 2 === 0 ? 'me' : 'bot',
          `mirrored-concurrent-${String(index).padStart(4, '0')}`
        )
      )
    )
  );

  assert.equal(
    results.every((result) => result.created),
    true
  );
  const storedParent = await readSession(parent.id);
  const storedChild = await readSession(child.id);
  assert.equal(storedChild.messages.length, count);
  assert.equal(storedParent.messages.length, count + 2);
  assert.deepEqual(
    new Set(storedChild.messages.map((message) => message.id)),
    new Set(storedParent.messages.slice(2).map((message) => message.id))
  );
});

test('an interrupted mirrored write recovers the missing child copy from the mutation journal', async () => {
  const { parent, child } = await createCompactedPair('Recover mirrored continuation');
  const body = mirroredMessageBody('Recover this mirrored message', 'me', 'mirrored-recovery-0001');

  setMutationFailureInjectorForTests((checkpoint) => {
    if (checkpoint === 'mirror-compacted-message:after-parent-write') {
      throw new Error('Injected mirrored message failure');
    }
  });

  await assert.rejects(() => addMessage(child.id, body), /Injected mirrored message failure/);
  await fs.access(MUTATION_JOURNAL_FILE);

  const interruptedParent = await readSession(parent.id);
  const interruptedChild = await readSession(child.id);
  const parentMessage = interruptedParent.messages.find(
    (message) => message.clientIdempotencyKey === body.idempotencyKey
  );
  assert.ok(parentMessage);
  assert.equal(
    interruptedChild.messages.some((message) => message.clientIdempotencyKey === body.idempotencyKey),
    false
  );

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  await assert.rejects(
    () => fs.access(MUTATION_JOURNAL_FILE),
    (error) => error?.code === 'ENOENT'
  );
  const recoveredParent = await readSession(parent.id);
  const recoveredChild = await readSession(child.id);
  const recoveredParentMessage = recoveredParent.messages.find(
    (message) => message.clientIdempotencyKey === body.idempotencyKey
  );
  const recoveredChildMessage = recoveredChild.messages.find(
    (message) => message.clientIdempotencyKey === body.idempotencyKey
  );
  assert.equal(recoveredChildMessage.id, recoveredParentMessage.id);
  assert.deepEqual(recoveredChildMessage, recoveredParentMessage);

  const retry = await addMessage(child.id, body);
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, recoveredParentMessage.id);
  assert.equal((await readSession(parent.id)).messages.filter((message) => message.id === retry.message.id).length, 1);
  assert.equal((await readSession(child.id)).messages.filter((message) => message.id === retry.message.id).length, 1);
});
