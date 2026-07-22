function appError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function normalizeRequestError(error) {
  if (error?.type === 'entity.parse.failed') return appError(400, 'Request body contains invalid JSON.');
  if (error?.type === 'entity.too.large') return appError(413, 'Request body is too large.');
  if (error?.type === 'charset.unsupported' || error?.type === 'encoding.unsupported') {
    return appError(415, 'Request body encoding is not supported.');
  }
  return error;
}

function errorHandler(err, req, res, _next) {
  const error = normalizeRequestError(err);
  const status = Number(error.status || error.statusCode || 500);
  if (status >= 500) console.error(error);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error.expose ? error.message : 'Something went wrong.'
  });
}

module.exports = { appError, normalizeRequestError, errorHandler };
