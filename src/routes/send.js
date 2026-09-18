'use strict';

const express = require('express');
const authMiddleware = require('../middleware/auth');
const credentialValidator = require('../services/credentialValidator');
const emailParser = require('../services/emailParser');
const template = require('../services/template');
const ledger = require('../services/ledger');
const jobStore = require('../services/jobStore');
const jobRunner = require('../services/jobRunner');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/send
 * Headers: x-access-key
 * Body: { gmailUser, appPassword, emails, force? }
 */
router.post('/send', authMiddleware, async (req, res) => {
  const { gmailUser, appPassword, emails, force = false } = req.body || {};

  // Step 1: Mutex check
  if (jobRunner.isBusy()) {
    return res.status(409).json({
      error: 'A job is already running. Wait for it to finish before starting a new one.',
    });
  }

  // Step 2: Validate credentials
  let creds;
  try {
    creds = credentialValidator.validate({ gmailUser, appPassword });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  // Step 3: Parse and validate emails
  let parsed;
  try {
    parsed = await emailParser.parse(emails || '');
  } catch (err) {
    return res.status(400).json({ error: `Email parsing failed: ${err.message}` });
  }

  // Step 4: Filter ledger (unless force=true)
  let toSend = parsed.valid;
  let alreadySent = [];
  if (!force) {
    const ledgerResult = ledger.filterAlreadySent(creds.gmailUser, parsed.valid);
    toSend = ledgerResult.toSend;
    alreadySent = ledgerResult.alreadySent;
  }

  // Step 5: Check recipient count against min/max (on toSend after ledger filter if force=false)
  // The minimum-15 rule applies to what the user submits (parsed.valid), not post-ledger
  const countErr = emailParser.checkCounts(parsed.valid);
  if (countErr) {
    return res.status(countErr.statusCode).json({
      error: countErr.message,
      invalid: parsed.invalid,
      duplicatesInInput: parsed.duplicatesInInput,
    });
  }

  // If after ledger filtering nothing is left to send
  if (toSend.length === 0) {
    return res.status(200).json({
      message: 'All valid addresses have already been emailed by this account. Use force=true to override.',
      toSend: [],
      alreadySent,
      invalid: parsed.invalid,
      duplicatesInInput: parsed.duplicatesInInput,
    });
  }

  // Step 6: Daily limit check
  const sentToday = ledger.countSentLast24h(creds.gmailUser);
  if (sentToday + toSend.length > config.DAILY_SEND_LIMIT) {
    return res.status(429).json({
      error: `Daily send limit would be exceeded. Sent today: ${sentToday}, limit: ${config.DAILY_SEND_LIMIT}, requested: ${toSend.length}.`,
    });
  }

  // Step 7: Validate template renders cleanly
  try {
    template.render({ gmailUser: creds.gmailUser });
  } catch (tmplErr) {
    return res.status(422).json({ error: `Template error: ${tmplErr.message}` });
  }

  // Step 8: Create job (appPassword NOT stored in job record)
  const jobId = jobStore.createJob({
    senderName: config.CHAPTER_SHORT_NAME || config.CHAPTER_NAME,
    senderEmail: creds.gmailUser,
    recipients: toSend,
  });

  logger.info({ jobId, senderEmail: creds.gmailUser, count: toSend.length }, '[send] Job created, starting runner');

  // Step 9: Start job runner in background (do not await)
  setImmediate(() => {
    jobRunner.run(jobId, { gmailUser: creds.gmailUser, appPassword: creds.appPassword }).catch((err) => {
      logger.error({ jobId, err: err.message }, '[send] Unhandled jobRunner error');
    });
  });

  // Step 10: Return 202 immediately
  return res.status(202).json({
    jobId,
    total: toSend.length,
    toSend,
    invalid: parsed.invalid,
    duplicatesInInput: parsed.duplicatesInInput,
    alreadySent,
  });
});

module.exports = router;
