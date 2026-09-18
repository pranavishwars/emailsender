'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// ─── Error classification ────────────────────────────────────────────────────

/**
 * Classifies a Nodemailer / SMTP error into one of four categories:
 *   'transient'  – safe to retry
 *   'permanent'  – do not retry (bad mailbox, policy rejection)
 *   'fatal'      – abort the entire job (auth failure, quota exceeded)
 *   'uncertain'  – error occurred after DATA was sent; NEVER auto-retry (risk of duplicate)
 *
 * When in doubt → 'uncertain' (spec §3.5, last line)
 */
function classifyError(err) {
  const code = err.code || '';
  const responseCode = err.responseCode || 0;
  const command = (err.command || '').toUpperCase();
  const response = (err.response || err.message || '').toLowerCase();

  // Uncertain: error happened after DATA command was transmitted — unknown if server accepted it
  if (command === 'DATA' && (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNECTION')) {
    return 'uncertain';
  }

  // Fatal: authentication, account-level blocks, quota
  if (
    responseCode === 535 ||
    responseCode === 534 ||
    code === 'EAUTH' ||
    response.includes('5.4.5') ||           // daily sending quota exceeded
    response.includes('4.7.0 too many')     // temporary block
  ) {
    return 'fatal';
  }

  // Permanent: bad mailbox, policy rejection
  if (
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 553 ||
    responseCode === 554 ||
    response.includes('5.1.1') ||
    response.includes('user unknown')
  ) {
    return 'permanent';
  }

  // Transient: connection issues before DATA, temporary server errors
  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    responseCode === 421 ||
    responseCode === 450 ||
    responseCode === 451 ||
    responseCode === 452
  ) {
    return 'transient';
  }

  // Default: uncertain (spec §3.5)
  return 'uncertain';
}

// ─── Transport factory ───────────────────────────────────────────────────────

/**
 * Creates a scoped Nodemailer transport for a single job.
 * The transport uses the user-supplied Gmail credentials (already space-stripped).
 *
 * @param {{ gmailUser: string, appPassword: string }} creds
 * @returns {nodemailer.Transporter}
 */
function createTransport({ gmailUser, appPassword }) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // TLS
    auth: {
      user: gmailUser,
      pass: appPassword,
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
  });
}

// ─── Send ────────────────────────────────────────────────────────────────────

/**
 * Sends a single email and returns { ok, messageId, response } on success,
 * or { ok: false, class, error } on failure.
 *
 * @param {nodemailer.Transporter} transporter
 * @param {{ to: string, from: { name: string, address: string }, subject: string, text: string, html: string, replyTo: string }} message
 * @returns {Promise<{ ok: boolean, messageId?: string, response?: string, class?: string, error?: string }>}
 */
async function send(transporter, message) {
  try {
    const info = await transporter.sendMail(message);

    const accepted = Array.isArray(info.accepted) ? info.accepted.map((a) => a.toString().toLowerCase()) : [];
    const rejected = info.rejected || [];

    if (!accepted.includes(message.to.toLowerCase()) || rejected.length > 0) {
      const errMsg = `SMTP did not confirm acceptance. accepted=${JSON.stringify(info.accepted)}, rejected=${JSON.stringify(info.rejected)}`;
      logger.warn({ to: message.to, accepted: info.accepted, rejected: info.rejected }, '[mailer] Send not confirmed');
      return { ok: false, class: 'uncertain', error: errMsg };
    }

    logger.info({ to: message.to, messageId: info.messageId, response: info.response }, '[mailer] Sent OK');
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    const errClass = classifyError(err);
    logger.warn({ to: message.to, errClass, code: err.code, responseCode: err.responseCode, response: err.response }, '[mailer] Send error');
    return { ok: false, class: errClass, error: err.message };
  }
}

const fs = require('fs');
const path = require('path');

/**
 * Returns array of attachments for the sponsorship email.
 * Checks process.env.BROCHURE_PATH, IEEE_SSIT_Brochure.pdf, or any root PDF.
 */
function getAttachments() {
  const customPath = process.env.BROCHURE_PATH
    ? path.resolve(process.cwd(), process.env.BROCHURE_PATH)
    : null;

  if (customPath && fs.existsSync(customPath)) {
    return [
      {
        filename: path.basename(customPath),
        path: customPath,
        contentType: 'application/pdf',
      },
    ];
  }

  const defaultFile = path.resolve(process.cwd(), 'IEEE_SSIT_Brochure.pdf');
  if (fs.existsSync(defaultFile)) {
    return [
      {
        filename: 'IEEE_SSIT_Brochure.pdf',
        path: defaultFile,
        contentType: 'application/pdf',
      },
    ];
  }

  try {
    const files = fs.readdirSync(process.cwd());
    const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
    if (pdf) {
      return [
        {
          filename: pdf,
          path: path.resolve(process.cwd(), pdf),
          contentType: 'application/pdf',
        },
      ];
    }
  } catch (_) {
    // Ignore FS errors
  }

  return [];
}

/**
 * Builds the Nodemailer message object for a single recipient.
 */
function buildMessage({ to, senderName, gmailUser, subject, text, html, attachments }) {
  const message = {
    from: { name: senderName, address: gmailUser },
    to,
    replyTo: gmailUser,
    subject,
    text,
    html,
    encoding: 'utf-8',
    headers: {
      'X-Mailer': 'ChapterSponsorMailer',
      'List-Unsubscribe': `<mailto:${gmailUser}?subject=unsubscribe>`,
    },
  };

  const atts = attachments !== undefined ? attachments : getAttachments();
  if (atts && atts.length > 0) {
    message.attachments = atts;
  }

  return message;
}

module.exports = { createTransport, send, buildMessage, getAttachments, classifyError };

