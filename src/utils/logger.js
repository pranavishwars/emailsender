'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFilePath = path.join(logsDir, 'app.log');

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      // Never log these fields anywhere in the log output
      paths: ['appPassword', 'pass', 'password', 'auth.pass', '*.appPassword'],
      censor: '[REDACTED]',
    },
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: fs.createWriteStream(logFilePath, { flags: 'a' }) },
  ])
);

module.exports = logger;
