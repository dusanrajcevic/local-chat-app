function closeHttpServer(server, options = {}) {
  if (!server || typeof server.close !== 'function' || server.listening === false) {
    return Promise.resolve();
  }

  const forceAfterMs = Number.isFinite(options.forceAfterMs) ? options.forceAfterMs : 5_000;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer = null;

    function finish(error) {
      if (settled) return;
      settled = true;
      if (forceTimer) cancel(forceTimer);
      if (error) reject(error);
      else resolve();
    }

    try {
      server.close((error) => finish(error || null));
      if (settled) return;

      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }

      if (forceAfterMs >= 0 && typeof server.closeAllConnections === 'function') {
        forceTimer = schedule(() => {
          try {
            server.closeAllConnections();
          } catch (error) {
            finish(error);
          }
        }, forceAfterMs);
        if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
      }
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = { closeHttpServer };
