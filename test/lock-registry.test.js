const test = require('node:test');
const assert = require('node:assert/strict');

const { createLockRegistry } = require('../src/server/storage/file-store');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('lock registry removes an entry after a successful task', async () => {
  const registry = createLockRegistry();
  const entered = deferred();
  const releaseTask = deferred();

  const resultPromise = registry.withLock('session-a', async () => {
    entered.resolve();
    await releaseTask.promise;
    return 'saved';
  });

  await entered.promise;
  assert.equal(registry.size, 1);

  releaseTask.resolve();
  assert.equal(await resultPromise, 'saved');
  assert.equal(registry.size, 0);
});

test('lock registry removes an entry after a failed task', async () => {
  const registry = createLockRegistry();

  await assert.rejects(
    registry.withLock('session-a', async () => {
      throw new Error('write failed');
    }),
    /write failed/
  );

  assert.equal(registry.size, 0);
});

test('same-key tasks remain serialized and clean up after the final task', async () => {
  const registry = createLockRegistry();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const events = [];

  const first = registry.withLock('session-a', async () => {
    events.push('first:start');
    firstEntered.resolve();
    await releaseFirst.promise;
    events.push('first:end');
  });

  await firstEntered.promise;

  const second = registry.withLock('session-a', async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await nextTurn();
  assert.deepEqual(events, ['first:start']);
  assert.equal(registry.size, 1);

  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(registry.size, 0);
});

test('a failed task releases the next same-key task', async () => {
  const registry = createLockRegistry();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondRan = false;

  const first = registry.withLock('session-a', async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
    throw new Error('first write failed');
  });

  await firstEntered.promise;
  const second = registry.withLock('session-a', async () => {
    secondRan = true;
    return 'recovered';
  });

  releaseFirst.resolve();
  await assert.rejects(first, /first write failed/);
  assert.equal(await second, 'recovered');
  assert.equal(secondRan, true);
  assert.equal(registry.size, 0);
});

test('many unique lock keys do not accumulate registry entries', async () => {
  const registry = createLockRegistry();

  await Promise.all(
    Array.from({ length: 250 }, (_, index) =>
      registry.withLock(`session-${index}`, async () => index)
    )
  );

  assert.equal(registry.size, 0);
});
