const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-compaction-upsert-${process.pid}-${Date.now()}`);
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
  listSessions,
  readSession,
  upsertCompactedSession
} = require('../src/server/services/session-service');

async function createSessionWithMessages(title, count = 2) {
  const session = await createSession({ title, aiName: 'ChatGPT' });
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const result = await addMessage(session.id, {
      sender: index % 2 === 0 ? 'me' : 'bot',
      text: `Source message ${index + 1}`,
      providerKey: 'chatgpt'
    });
    messages.push(result.message);
  }
  return { session, messages };
}

function compactionBody(requestId, compactedMessage = `Compacted context for ${requestId}`) {
  return { requestId, compactedMessage, providerKey: 'chatgpt' };
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

test('first compaction creates one child and links it to the normal parent', async () => {
  const { session: parent, messages } = await createSessionWithMessages('Architecture review');
  const result = await upsertCompactedSession(parent.id, compactionBody('compact:req:create-001'));

  assert.equal(result.created, true);
  assert.equal(result.replaced, false);
  assert.equal(result.session.kind, 'compacted');
  assert.equal(result.session.parentSessionId, parent.id);
  assert.equal(result.session.title, 'Architecture review (compacted)');

  const storedParent = await readSession(parent.id);
  const child = await readSession(result.session.id);
  assert.equal(storedParent.compactedSessionId, child.id);
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.compaction.requestId, 'compact:req:create-001');
  assert.equal(child.compaction.text, 'Compacted context for compact:req:create-001');
  assert.equal(child.compaction.providerKey, 'chatgpt');
  assert.equal(child.compaction.sourceMessageCount, 2);
  assert.equal(child.compaction.throughMessageId, messages.at(-1).id);
  assert.ok(!Number.isNaN(Date.parse(child.compaction.createdAt)));
  assert.deepEqual(child.messages, []);
});

test('compacted titles retain the suffix without exceeding the session title limit', async () => {
  const { session: parent } = await createSessionWithMessages('x'.repeat(160), 1);
  const result = await upsertCompactedSession(parent.id, compactionBody('compact:req:title-001'));

  assert.equal(result.session.title.length, 160);
  assert.ok(result.session.title.endsWith(' (compacted)'));
});

test('recompaction reuses the same child, replaces its compaction, and clears post-compaction messages', async () => {
  const { session: parent } = await createSessionWithMessages('Reusable compacted child');
  const first = await upsertCompactedSession(parent.id, compactionBody('compact:req:replace-001', 'First context'));

  await addMessage(first.session.id, { sender: 'me', text: 'Post-compaction continuation' });
  assert.equal((await readSession(first.session.id)).messages.length, 1);

  const second = await upsertCompactedSession(
    first.session.id,
    compactionBody('compact:req:replace-002', 'Replacement context')
  );

  assert.equal(second.created, false);
  assert.equal(second.replaced, true);
  assert.equal(second.session.id, first.session.id);

  const storedChild = await readSession(first.session.id);
  assert.equal(storedChild.compaction.requestId, 'compact:req:replace-002');
  assert.equal(storedChild.compaction.text, 'Replacement context');
  assert.deepEqual(storedChild.messages, []);
  assert.equal((await readSession(parent.id)).compactedSessionId, first.session.id);
});

test('retrying the same request is idempotent and does not clear later child messages', async () => {
  const { session: parent } = await createSessionWithMessages('Idempotent compaction');
  const body = compactionBody('compact:req:retry-001', 'Stable compacted context');
  const first = await upsertCompactedSession(parent.id, body);

  await addMessage(first.session.id, { sender: 'me', text: 'Keep this continuation' });
  const beforeRetry = await readSession(first.session.id);
  const originalCreatedAt = beforeRetry.compaction.createdAt;

  const retry = await upsertCompactedSession(parent.id, body);
  assert.equal(retry.created, false);
  assert.equal(retry.replaced, false);
  assert.equal(retry.session.id, first.session.id);

  const afterRetry = await readSession(first.session.id);
  assert.equal(afterRetry.compaction.createdAt, originalCreatedAt);
  assert.equal(afterRetry.messages.length, 1);
  assert.equal(afterRetry.messages[0].text, 'Keep this continuation');
});

test('reusing a compaction request ID with different content returns a conflict', async () => {
  const { session: parent } = await createSessionWithMessages('Compaction request conflict');
  await upsertCompactedSession(parent.id, compactionBody('compact:req:conflict-001', 'Original compacted text'));

  await assert.rejects(
    () => upsertCompactedSession(parent.id, compactionBody('compact:req:conflict-001', 'Different compacted text')),
    (error) => error?.status === 409 && /already used with different content/i.test(error.message)
  );
});

test('concurrent compactions never create more than one compacted child', async () => {
  const { session: parent } = await createSessionWithMessages('Concurrent compaction', 1);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      upsertCompactedSession(
        parent.id,
        compactionBody(`compact:req:parallel-${String(index).padStart(3, '0')}`, `Parallel context ${index}`)
      )
    )
  );

  const childIds = new Set(results.map((result) => result.session.id));
  assert.equal(childIds.size, 1);

  const storedParent = await readSession(parent.id);
  const [childId] = childIds;
  assert.equal(storedParent.compactedSessionId, childId);

  const children = (await listSessions()).filter((session) => session.parentSessionId === parent.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, childId);
});

test('interrupted first compaction recovers the child-to-parent relationship from the journal', async () => {
  const { session: parent } = await createSessionWithMessages('Recoverable compaction', 1);
  setMutationFailureInjectorForTests((checkpoint) => {
    if (checkpoint === 'upsert-compaction:after-child-write') {
      throw new Error('Injected compaction failure');
    }
  });

  await assert.rejects(
    () => upsertCompactedSession(parent.id, compactionBody('compact:req:recover-001', 'Recover this context')),
    /Injected compaction failure/
  );

  await fs.access(MUTATION_JOURNAL_FILE);
  assert.equal((await readSession(parent.id)).compactedSessionId, null);
  const orphanedChild = (await listSessions()).find((session) => session.parentSessionId === parent.id);
  assert.ok(orphanedChild);

  setMutationFailureInjectorForTests(null);
  await recoverPendingMutation();

  await assert.rejects(
    () => fs.access(MUTATION_JOURNAL_FILE),
    (error) => error?.code === 'ENOENT'
  );
  assert.equal((await readSession(parent.id)).compactedSessionId, orphanedChild.id);
  const recoveredChild = await readSession(orphanedChild.id);
  assert.equal(recoveredChild.compaction.requestId, 'compact:req:recover-001');
  assert.equal(recoveredChild.compaction.text, 'Recover this context');
});

test('compaction rejects empty sessions and malformed request fields', async () => {
  const empty = await createSession({ title: 'Empty compaction target', aiName: 'ChatGPT' });

  await assert.rejects(
    () => upsertCompactedSession(empty.id, compactionBody('compact:req:empty-001')),
    (error) => error?.status === 409 && /no messages/i.test(error.message)
  );
  await assert.rejects(
    () => upsertCompactedSession(empty.id, { requestId: 'bad id', compactedMessage: 'Text' }),
    (error) => error?.status === 400 && /request ID is invalid/i.test(error.message)
  );
  await assert.rejects(
    () => upsertCompactedSession(empty.id, { requestId: 'compact:req:valid-001', compactedMessage: {} }),
    (error) => error?.status === 400 && /must be a string/i.test(error.message)
  );
});
