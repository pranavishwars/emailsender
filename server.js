'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Ensure data/ and logs/ exist before any module needs them
const dataDir = path.join(__dirname, 'data');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const express = require('express');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { helmetMiddleware, limiter } = require('./src/middleware/limits');
const jobStore = require('./src/services/jobStore');
const template = require('./src/services/template');
const jobRunner = require('./src/services/jobRunner');

const healthRouter = require('./src/routes/health');
const previewRouter = require('./src/routes/preview');
const sendRouter = require('./src/routes/send');
const jobsRouter = require('./src/routes/jobs');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmetMiddleware);
app.use(limiter);
app.use(express.json({ limit: '200kb' }));

// ─── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api', healthRouter);
app.use('/api', previewRouter);
app.use('/api', sendRouter);
app.use('/api', jobsRouter);

// ─── Startup sequence ─────────────────────────────────────────────────────────
function startup() {
  // 1. Crash recovery — must run before accepting any requests
  logger.info('[server] Recovering stale jobs...');
  jobStore.recoverStaleJobs();

  // 2. Load and validate template files (fail fast if missing)
  logger.info('[server] Loading templates...');
  try {
    template.loadTemplates();
    logger.info('[server] Templates loaded OK');
  } catch (err) {
    logger.error({ err: err.message }, '[server] Template load failed — cannot start');
    process.exit(1);
  }

  // 3. Start listening
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, `[server] Sponsorship Mailer running on http://localhost:${config.PORT}`);
    logger.info('[server] Note: SMTP credentials are validated per-job (no fixed sending account)');
  });

  // ─── Graceful shutdown ─────────────────────────────────────────────────────
  function gracefulShutdown(signal) {
    logger.info({ signal }, '[server] Shutdown signal received');
    jobRunner.beginShutdown();

    server.close(() => {
      logger.info('[server] HTTP server closed');
      // Give the current job runner up to 10 s to finish its current send
      let waited = 0;
      const interval = setInterval(() => {
        if (!jobRunner.isBusy() || waited >= 10_000) {
          clearInterval(interval);
          logger.info('[server] Shutdown complete');
          process.exit(0);
        }
        waited += 500;
      }, 500);
    });
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startup();
