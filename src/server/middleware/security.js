const cors = require('cors');
const { AUTH_TOKEN, EXTRA_ALLOWED_ORIGINS } = require('../config');

function isChromeExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(String(origin || ''));
}

function isSameRequestOrigin(origin, req) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === req.get('host');
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  if (EXTRA_ALLOWED_ORIGINS.has(origin)) return true;
  if (isSameRequestOrigin(origin, req)) return true;
  if (isChromeExtensionOrigin(origin)) return true;
  return false;
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
    allowedHeaders: ['Content-Type', 'X-Local-Chat-Token', 'Idempotency-Key'],
    maxAge: 600
  });
}

function requireConfiguredTokenForExtensions(req, res, next) {
  if (!AUTH_TOKEN || !req.path.startsWith('/api/')) return next();
  const origin = req.get('origin');
  if (!isChromeExtensionOrigin(origin)) return next();
  if (req.get('x-local-chat-token') === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'Local Chat token is required for extension access.' });
}

function setSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function installSecurityMiddleware(app) {
  app.disable('x-powered-by');
  app.use(setSecurityHeaders);
  app.use(rejectUntrustedOrigin);
  app.use(cors(corsOptionsDelegate));
  app.use(requireConfiguredTokenForExtensions);
}

module.exports = {
  isChromeExtensionOrigin,
  isSameRequestOrigin,
  isAllowedOrigin,
  rejectUntrustedOrigin,
  corsOptionsDelegate,
  requireConfiguredTokenForExtensions,
  setSecurityHeaders,
  installSecurityMiddleware
};
