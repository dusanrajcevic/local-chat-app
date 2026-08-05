const net = require('node:net');
const cors = require('cors');
const { EXTRA_ALLOWED_ORIGINS } = require('../config');
const {
  extensionIdFromOrigin,
  isAllowedExtensionId,
  authorizeExtension
} = require('../services/extension-auth-service');
const { setSecurityHeaders } = require('./security-headers');

function isChromeExtensionOrigin(origin) {
  return Boolean(extensionIdFromOrigin(origin));
}

function parseHostHeader(hostHeader) {
  if (
    typeof hostHeader !== 'string' ||
    !hostHeader ||
    hostHeader !== hostHeader.trim() ||
    /[/\\?#@,\s]/.test(hostHeader)
  ) {
    return null;
  }

  let hostname;
  let portText = '';

  if (hostHeader.startsWith('[')) {
    const closingBracket = hostHeader.indexOf(']');
    if (closingBracket < 2) return null;

    hostname = hostHeader.slice(1, closingBracket);
    const suffix = hostHeader.slice(closingBracket + 1);
    if (suffix) {
      const portMatch = suffix.match(/^:(\d{1,5})$/);
      if (!portMatch) return null;
      portText = portMatch[1];
    }
  } else {
    const match = hostHeader.match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!match) return null;
    hostname = match[1];
    portText = match[2] || '';
  }

  const port = portText ? Number(portText) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

  return { hostname: hostname.toLowerCase(), port };
}

function normalizeSocketAddress(address) {
  const normalized = String(address || '')
    .toLowerCase()
    .split('%')[0];
  return normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
}

function isLoopbackAddress(address) {
  if (address === '::1') return true;
  if (net.isIP(address) !== 4) return false;
  return address.startsWith('127.');
}

function isAllowedRequestHost(req) {
  const parsedHost = parseHostHeader(req.get('host'));
  const localPort = Number(req.socket && req.socket.localPort);
  if (!parsedHost || !Number.isInteger(localPort)) return false;

  const requestPort = parsedHost.port ?? 80;
  if (requestPort !== localPort) return false;

  const localAddress = normalizeSocketAddress(req.socket.localAddress);
  const allowedHostnames = new Set(localAddress ? [localAddress] : []);
  if (isLoopbackAddress(localAddress)) {
    allowedHostnames.add('localhost');
    allowedHostnames.add('127.0.0.1');
    allowedHostnames.add('::1');
  }

  return allowedHostnames.has(parsedHost.hostname);
}

function parseHttpOrigin(origin) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;

    const authority = parseHostHeader(parsed.host);
    if (!authority) return null;
    return { hostname: authority.hostname, port: authority.port ?? 80 };
  } catch {
    return null;
  }
}

function isSameRequestOrigin(origin, req) {
  if (!origin) return true;
  if (!isAllowedRequestHost(req)) return false;

  const parsedOrigin = parseHttpOrigin(origin);
  const parsedHost = parseHostHeader(req.get('host'));
  if (!parsedOrigin || !parsedHost) return false;

  return parsedOrigin.hostname === parsedHost.hostname && parsedOrigin.port === (parsedHost.port ?? 80);
}

function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  if (EXTRA_ALLOWED_ORIGINS.has(origin)) return true;
  if (isSameRequestOrigin(origin, req)) return true;
  if (isChromeExtensionOrigin(origin)) {
    return isAllowedExtensionId(extensionIdFromOrigin(origin));
  }
  return false;
}

function rejectUntrustedHost(req, res, next) {
  if (!isAllowedRequestHost(req)) {
    return res.status(403).json({ error: 'Host is not allowed.' });
  }
  return next();
}

function rejectUntrustedOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(origin, req)) {
    return res.status(403).json({ error: 'Origin is not allowed.' });
  }
  return next();
}

function corsOptionsDelegate(req, callback) {
  const origin = req.get('origin');
  callback(null, {
    origin: origin && isAllowedOrigin(origin, req) ? origin : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Local-Chat-Token',
      'X-Local-Chat-Extension-Id',
      'Idempotency-Key'
    ],
    maxAge: 600
  });
}

function requireExtensionAuthorization(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const origin = req.get('origin');
  if (!isChromeExtensionOrigin(origin)) return next();
  if (req.path === '/api/extension/pair') return next();

  authorizeExtension({
    origin,
    extensionIdHeader: req.get('x-local-chat-extension-id'),
    token: req.get('x-local-chat-token')
  })
    .then((authorized) => {
      if (authorized) return next();
      return res.status(401).json({ error: 'Browser extension pairing is required.' });
    })
    .catch(next);
}

function installSecurityMiddleware(app) {
  app.disable('x-powered-by');
  app.use(setSecurityHeaders);
  app.use(rejectUntrustedHost);
  app.use(rejectUntrustedOrigin);
  app.use(cors(corsOptionsDelegate));
  app.use(requireExtensionAuthorization);
}

module.exports = {
  isChromeExtensionOrigin,
  parseHostHeader,
  normalizeSocketAddress,
  isLoopbackAddress,
  isAllowedRequestHost,
  parseHttpOrigin,
  isSameRequestOrigin,
  isAllowedOrigin,
  rejectUntrustedHost,
  rejectUntrustedOrigin,
  corsOptionsDelegate,
  requireExtensionAuthorization,
  setSecurityHeaders,
  installSecurityMiddleware
};
