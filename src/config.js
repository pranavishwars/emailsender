'use strict';

require('dotenv').config();

const errors = [];

function required(name, extra) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    errors.push(`  Missing required env var: ${name}${extra ? ' — ' + extra : ''}`);
    return '';
  }
  return val.trim();
}

function optional(name, defaultVal = '') {
  return (process.env[name] || '').trim() || defaultVal;
}

function positiveInt(name, defaultVal) {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) {
    errors.push(`  ${name} must be a positive integer, got: "${raw}"`);
    return defaultVal;
  }
  return n;
}

const MAIL_TRANSPORT = optional('MAIL_TRANSPORT', 'gmail-smtp');
if (!['gmail-smtp', 'gmail-oauth2'].includes(MAIL_TRANSPORT)) {
  errors.push(`  MAIL_TRANSPORT must be "gmail-smtp" or "gmail-oauth2", got: "${MAIL_TRANSPORT}"`);
}

const SEND_DELAY_MIN_MS = positiveInt('SEND_DELAY_MIN_MS', 8000);
const SEND_DELAY_MAX_MS = positiveInt('SEND_DELAY_MAX_MS', 20000);
if (SEND_DELAY_MAX_MS < SEND_DELAY_MIN_MS) {
  errors.push(`  SEND_DELAY_MAX_MS (${SEND_DELAY_MAX_MS}) must be >= SEND_DELAY_MIN_MS (${SEND_DELAY_MIN_MS})`);
}

const MAX_RECIPIENTS_PER_JOB = positiveInt('MAX_RECIPIENTS_PER_JOB', 100);
if (MAX_RECIPIENTS_PER_JOB > 400) {
  errors.push(`  MAX_RECIPIENTS_PER_JOB cannot exceed 400 (hard ceiling for Gmail safety), got: ${MAX_RECIPIENTS_PER_JOB}`);
}

const config = {
  PORT: parseInt(optional('PORT', '3000'), 10),
  ACCESS_KEY: required('ACCESS_KEY'),
  MAIL_TRANSPORT,

  // Chapter / event identity (server-level)
  CHAPTER_NAME: required('CHAPTER_NAME'),
  CHAPTER_SHORT_NAME: optional('CHAPTER_SHORT_NAME', ''), // falls back to CHAPTER_NAME in template.js
  EVENT_NAME: required('EVENT_NAME'),
  SENDER_ROLE: required('SENDER_ROLE'),
  CONTACT_PHONE: optional('CONTACT_PHONE', ''),

  // Sending behaviour
  MIN_RECIPIENTS: positiveInt('MIN_RECIPIENTS', 1),
  MAX_RECIPIENTS_PER_JOB,
  SEND_DELAY_MIN_MS,
  SEND_DELAY_MAX_MS,
  MAX_RETRIES: positiveInt('MAX_RETRIES', 3),
  DAILY_SEND_LIMIT: positiveInt('DAILY_SEND_LIMIT', 400),
};

if (errors.length > 0) {
  console.error('[config] Server startup failed — fix the following:\n' + errors.join('\n'));
  process.exit(1);
}

module.exports = config;
