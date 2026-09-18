'use strict';

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
    },
  },
});

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,            // 300 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' },
});

module.exports = { helmetMiddleware, limiter };

