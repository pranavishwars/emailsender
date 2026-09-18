'use strict';

const config = require('../config');
const mailer = require('./mailer');
const ledger = require('./ledger');
const jobStore = require('./jobStore');
const template = require('./template');
const { sleep, randomBetween } = require('../utils/sleep');
const logger = require('../utils/logger');

// ─── Mutex ───────────────────────────────────────────────────────────────────

let isRunning = false;
let isShuttingDown = false;

function isBusy() { return isRunning; }
function beginShutdown() { isShuttingDown = true; }

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Attempts to send one email, retrying on transient errors with exponential backoff.
 *
 * @param {object} transporter
 * @param {object} message - built by mailer.buildMessage
 * @param {string} recipient
 * @returns {Promise<{ ok: boolean, messageId?: string, response?: string, class?: string, error?: string }>}
 */
async function sendWithRetry(transporter, message, recipient) {
  const backoff = [30_000, 60_000, 120_000];

  for (let attempt = 0; attempt <= config.MAX_RETRIES; attempt++) {
    const result = await mailer.send(transporter, message);

    if (result.ok) return result;

    // Never retry uncertain or permanent or fatal
    if (result.class !== 'transient') {
      return result;
    }

    // Transient — retry if attempts remain
    if (attempt < config.MAX_RETRIES) {
      const delay = backoff[Math.min(attempt, backoff.length - 1)] + randomBetween(0, 5000);
      logger.warn({ recipient, attempt: attempt + 1, delay }, '[jobRunner] Transient error — retrying after delay');
      await sleep(delay);
    }
  }

  // Exhausted retries
  return { ok: false, class: 'permanent', error: 'Max retries exhausted on transient errors.' };
}

// ─── Main job runner ─────────────────────────────────────────────────────────

/**
 * Runs a job in the background.
 * credentials: { gmailUser, appPassword } — held in memory only, never persisted.
 *
 * @param {string} jobId
 * @param {{ gmailUser: string, appPassword: string }} credentials
 */
async function run(jobId, credentials) {
  isRunning = true;
  let transporter = null;

  try {
    jobStore.updateJobStatus(jobId, 'running');

    // Create a scoped transport for this job
    transporter = mailer.createTransport(credentials);

    // Verify credentials before sending anything
    try {
      await transporter.verify();
      logger.info({ jobId }, '[jobRunner] SMTP transport verified OK');
    } catch (verifyErr) {
      logger.error({ jobId, err: verifyErr.message }, '[jobRunner] SMTP verify failed — aborting job');
      jobStore.updateJobStatus(jobId, 'aborted', { abortReason: `SMTP verify failed: ${verifyErr.message}` });
      return;
    }

    // Render template once for this job's sender
    const job = jobStore.getJob(jobId);
    let rendered;
    try {
      rendered = template.render({ gmailUser: job.senderEmail });
    } catch (tmplErr) {
      logger.error({ jobId, err: tmplErr.message }, '[jobRunner] Template render failed — aborting job');
      jobStore.updateJobStatus(jobId, 'aborted', { abortReason: `Template error: ${tmplErr.message}` });
      return;
    }

    const recipients = job.recipients;
    let allSent = true;

    for (let i = 0; i < recipients.length; i++) {
      const rec = recipients[i];

      // Re-read job status in case of external abort signal
      const currentJob = jobStore.getJob(jobId);
      if (currentJob.status === 'aborted' || isShuttingDown) {
        logger.info({ jobId }, '[jobRunner] Job aborted — stopping send loop');
        break;
      }

      // Mark recipient as sending
      jobStore.updateRecipient(jobId, rec.email, {
        status: 'sending',
        attempts: rec.attempts,
      });

      const message = mailer.buildMessage({
        to: rec.email,
        senderName: job.senderName,
        gmailUser: job.senderEmail,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });

      // Update attempt count before sending
      jobStore.updateRecipient(jobId, rec.email, { attempts: rec.attempts + 1 });

      const result = await sendWithRetry(transporter, message, rec.email);

      if (result.ok) {
        // Ledger FIRST, then job state (crash safety)
        ledger.recordSent(job.senderEmail, rec.email, {
          jobId,
          messageId: result.messageId,
        });
        jobStore.updateRecipient(jobId, rec.email, {
          status: 'sent',
          messageId: result.messageId,
          smtpResponse: result.response,
          sentAt: new Date().toISOString(),
        });
        logger.info({ jobId, to: rec.email }, '[jobRunner] Recipient sent');

      } else if (result.class === 'fatal') {
        logger.error({ jobId, to: rec.email, error: result.error }, '[jobRunner] Fatal error — aborting job');
        jobStore.updateRecipient(jobId, rec.email, {
          status: 'failed',
          error: result.error,
        });

        // Mark all remaining recipients as pending
        for (let j = i + 1; j < recipients.length; j++) {
          jobStore.updateRecipient(jobId, recipients[j].email, { status: 'pending' });
        }

        jobStore.updateJobStatus(jobId, 'aborted', {
          abortReason: `Fatal SMTP error on ${rec.email}: ${result.error}`,
        });
        allSent = false;
        return; // exit the loop — finally block will clean up

      } else if (result.class === 'uncertain') {
        jobStore.updateRecipient(jobId, rec.email, {
          status: 'uncertain',
          error: result.error,
        });
        allSent = false;
        logger.warn({ jobId, to: rec.email }, '[jobRunner] Recipient uncertain');

      } else {
        // permanent
        jobStore.updateRecipient(jobId, rec.email, {
          status: 'failed',
          error: result.error,
        });
        allSent = false;
        logger.warn({ jobId, to: rec.email, error: result.error }, '[jobRunner] Recipient failed (permanent)');
      }

      // Inter-email delay (skip after the last recipient)
      if (i < recipients.length - 1 && !isShuttingDown) {
        const delay = randomBetween(config.SEND_DELAY_MIN_MS, config.SEND_DELAY_MAX_MS);
        logger.info({ jobId, delay }, '[jobRunner] Sleeping between sends');
        await sleep(delay);
      }
    }

    // Determine final status
    const finalJob = jobStore.getJob(jobId);
    if (finalJob.status !== 'aborted') {
      const finalStatus = allSent ? 'completed' : 'completed_with_errors';
      jobStore.updateJobStatus(jobId, finalStatus);
      logger.info({ jobId, finalStatus }, '[jobRunner] Job finished');
    }

  } catch (unexpectedErr) {
    logger.error({ jobId, err: unexpectedErr.message }, '[jobRunner] Unexpected error');
    jobStore.updateJobStatus(jobId, 'aborted', { abortReason: `Unexpected error: ${unexpectedErr.message}` });
  } finally {
    // Always close transport and clear credential references
    if (transporter) {
      try { transporter.close(); } catch (_) {}
      transporter = null;
    }
    credentials = null; // explicitly drop the password reference
    isRunning = false;
    logger.info({ jobId }, '[jobRunner] Transport closed, mutex released');
  }
}

module.exports = { run, isBusy, beginShutdown };
