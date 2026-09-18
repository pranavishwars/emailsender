'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.json');

// In-memory cache — loaded once, mutated on write
let ledger = null;

function ensureDataDir() {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDataDir();
  if (ledger !== null) return;
  if (fs.existsSync(LEDGER_PATH)) {
    try {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
    } catch (e) {
      logger.error({ err: e.message }, '[ledger] Failed to parse ledger.json — starting fresh');
      ledger = { sent: {} };
    }
  } else {
    ledger = { sent: {} };
  }
}

/** Atomically writes the in-memory ledger to disk. */
function flush() {
  ensureDataDir();
  const tmp = LEDGER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
  fs.renameSync(tmp, LEDGER_PATH);
}

/**
 * Ledger key: senderEmail → recipientEmail.
 * Two different senders are tracked independently.
 */
function makeKey(senderEmail, recipientEmail) {
  return `${senderEmail.toLowerCase()}|${recipientEmail.toLowerCase()}`;
}

/** Returns true if senderEmail has already sent to recipientEmail. */
function hasSent(senderEmail, recipientEmail) {
  load();
  return !!ledger.sent[makeKey(senderEmail, recipientEmail)];
}

/**
 * Records a successful send.
 * MUST be called BEFORE the inter-email delay and BEFORE marking job state as 'sent'.
 */
function recordSent(senderEmail, recipientEmail, { jobId, messageId }) {
  load();
  const key = makeKey(senderEmail, recipientEmail);
  ledger.sent[key] = {
    timestamp: new Date().toISOString(),
    jobId,
    messageId,
    senderEmail: senderEmail.toLowerCase(),
    recipientEmail: recipientEmail.toLowerCase(),
  };
  flush(); // atomic write
  logger.info({ senderEmail, recipientEmail, jobId }, '[ledger] Recorded sent');
}

/**
 * Separates emails into those not yet sent (by this sender) and those already sent.
 * @returns {{ toSend: string[], alreadySent: string[] }}
 */
function filterAlreadySent(senderEmail, emails) {
  load();
  const toSend = [];
  const alreadySent = [];
  for (const email of emails) {
    if (hasSent(senderEmail, email)) {
      alreadySent.push(email);
    } else {
      toSend.push(email);
    }
  }
  return { toSend, alreadySent };
}

/**
 * Counts how many emails senderEmail has sent in the last 24 hours.
 */
function countSentLast24h(senderEmail) {
  load();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const prefix = senderEmail.toLowerCase() + '|';
  let count = 0;
  for (const [key, entry] of Object.entries(ledger.sent)) {
    if (key.startsWith(prefix) && new Date(entry.timestamp).getTime() >= cutoff) {
      count++;
    }
  }
  return count;
}

module.exports = { hasSent, recordSent, filterAlreadySent, countSentLast24h };
