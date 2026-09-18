'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Middleware: validates the x-access-key header using constant-time comparison.
 * Returns 401 if missing or incorrect.
 */
function authMiddleware(req, res, next) {
  const provided = req.headers['x-access-key'] || '';
  const expected = config.ACCESS_KEY;

  // timingSafeEqual requires equal-length buffers
  if (!provided || provided.length !== expected.length) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing access key.' });
  }

  try {
    const provBuf = Buffer.from(provided);
    const expBuf = Buffer.from(expected);
    if (!crypto.timingSafeEqual(provBuf, expBuf)) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing access key.' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing access key.' });
  }

  next();
}

module.exports = authMiddleware;
