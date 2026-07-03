function appError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function errorHandler(err, req, res, _next) {
  const status = Number(err.status || err.statusCode || 500);
  if (status >= 500) console.error(err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: err.expose ? err.message : 'Something went wrong.'
  });
}

module.exports = { appError, errorHandler };
