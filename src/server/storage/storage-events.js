const listeners = new Set();

function subscribeStorageChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('Storage change listener must be a function.');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitStorageChange(change) {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // Storage durability must not depend on derived-cache listeners.
    }
  }
}

module.exports = { subscribeStorageChanges, emitStorageChange };
