const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function parseUrl(value) {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalAppNavigationUrl(value, localChatUrl) {
  const parsed = parseUrl(value);
  const local = parseUrl(localChatUrl);
  if (!parsed || !local || parsed.origin !== local.origin) return false;
  if (parsed.username || parsed.password || parsed.search) return false;

  return parsed.pathname === '/' || parsed.pathname === '/index.html';
}

function externalUrlToOpen(value) {
  const parsed = parseUrl(value);
  if (!parsed || !ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;

  if (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    (parsed.username || parsed.password)
  ) {
    return null;
  }

  return parsed.href;
}

function installNavigationGuards(
  webContents,
  { localChatUrl, openExternal, defer = setImmediate, logError = console.error }
) {
  const localUrl = parseUrl(localChatUrl);

  function openApprovedExternal(url) {
    const parsed = parseUrl(url);
    if (parsed && localUrl && parsed.origin === localUrl.origin) return false;

    const approvedUrl = externalUrlToOpen(url);
    if (!approvedUrl) return false;

    defer(() => {
      try {
        Promise.resolve(openExternal(approvedUrl)).catch((error) => {
          logError('Could not open external URL:', error);
        });
      } catch (error) {
        logError('Could not open external URL:', error);
      }
    });
    return true;
  }

  webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalAppNavigationUrl(url, localChatUrl)) openApprovedExternal(url);
    return { action: 'deny' };
  });

  function guardNavigation(event, url) {
    if (isLocalAppNavigationUrl(url, localChatUrl)) return;

    event.preventDefault();
    openApprovedExternal(url);
  }

  webContents.on('will-navigate', guardNavigation);
  webContents.on('will-redirect', guardNavigation);
}

module.exports = {
  ALLOWED_EXTERNAL_PROTOCOLS,
  parseUrl,
  isLocalAppNavigationUrl,
  externalUrlToOpen,
  installNavigationGuards
};
