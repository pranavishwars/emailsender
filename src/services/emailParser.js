'use strict';

const dns = require('dns').promises;
const validator = require('validator');
const config = require('../config');

/**
 * Parses, validates, deduplicates, and optionally MX-checks a raw email input string.
 *
 * @param {string} raw - Raw input (may contain newlines, commas, semicolons, spaces, tabs)
 * @returns {Promise<{ valid: string[], invalid: Array<{token:string,reason:string}>, duplicatesInInput: string[] }>}
 */
async function parse(raw) {
  const valid = [];
  const invalid = [];
  const duplicatesInInput = [];
  const seen = new Set();
  const mxCache = {}; // cache per domain to avoid redundant DNS lookups

  // Step 1: Split on whitespace, commas, semicolons
  const tokens = (raw || '').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

  for (const token of tokens) {
    // Step 2: Extract address from "Name <addr@x.com>" or <addr@x.com> patterns
    let addr = token;
    const angleMatch = token.match(/<([^>]+)>/);
    if (angleMatch) {
      addr = angleMatch[1].trim();
    } else {
      // Strip surrounding quotes and trailing punctuation
      addr = addr.replace(/^["']+|["']+$/g, '').replace(/[.,;:!?]+$/, '').trim();
    }

    // Step 3: Lowercase
    addr = addr.toLowerCase();

    // Step 4a: Header injection protection — reject addresses containing \r, \n, comma, or whitespace
    if (/[\r\n,\s]/.test(addr)) {
      invalid.push({ token, reason: 'Contains invalid characters (possible header injection).' });
      continue;
    }

    // Step 4b: Syntax validation
    if (!validator.isEmail(addr)) {
      invalid.push({ token, reason: `"${addr}" is not a valid email address.` });
      continue;
    }

    // Step 5: Deduplication (case-insensitive, already lowercased)
    if (seen.has(addr)) {
      duplicatesInInput.push(addr);
      continue;
    }
    seen.add(addr);

    // Step 6: MX record lookup (per unique domain)
    const domain = addr.split('@')[1];
    if (!(domain in mxCache)) {
      mxCache[domain] = await checkMx(domain);
    }
    const mxResult = mxCache[domain];
    if (mxResult === 'no-mx') {
      invalid.push({ token, reason: `Domain "${domain}" has no MX records — may not be a real email domain.` });
      continue;
    }
    // mxResult === 'ok' or 'timeout' (timeout = attempt anyway)

    valid.push(addr);
  }

  return { valid, invalid, duplicatesInInput };
}

/**
 * Checks whether a domain has MX records.
 * Returns 'ok', 'no-mx', or 'timeout'.
 */
async function checkMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return 'no-mx';
    return 'ok';
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ESERVFAIL') {
      // Definitive "no records" response
      return 'no-mx';
    }
    // Timeout, network error — don't reject, attempt anyway
    return 'timeout';
  }
}

/**
 * Validates parsed results against MIN/MAX recipient rules.
 * Returns an error object if invalid, or null if OK.
 *
 * @param {string[]} validEmails
 * @param {object} opts - { min, max }
 */
function checkCounts(validEmails, opts = {}) {
  const max = opts.max ?? config.MAX_RECIPIENTS_PER_JOB;

  if (validEmails.length === 0) {
    return {
      statusCode: 400,
      message: 'No valid email addresses found. Please paste at least one valid address.',
    };
  }
  if (validEmails.length > max) {
    return {
      statusCode: 400,
      message: `${validEmails.length} addresses exceed the maximum of ${max} per job.`,
    };
  }
  return null;
}

module.exports = { parse, checkCounts };
