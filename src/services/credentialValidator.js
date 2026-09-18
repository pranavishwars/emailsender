'use strict';

const validator = require('validator');

/**
 * Validates and sanitises user-supplied sender credentials.
 * Returns cleaned { gmailUser, appPassword } or throws an Error
 * with a human-readable message (to be returned as HTTP 400).
 *
 * Security invariant: appPassword is never logged and never included in error messages.
 */
function validate({ gmailUser, appPassword }) {
  const errs = [];

  // --- gmailUser ---
  const cleanGmailUser = (gmailUser || '').trim().toLowerCase();
  if (!cleanGmailUser) {
    errs.push('gmailUser is required.');
  } else if (!validator.isEmail(cleanGmailUser)) {
    errs.push(`gmailUser "${cleanGmailUser}" is not a valid email address.`);
  }

  // --- appPassword ---
  // Google App Passwords are displayed as "xxxx xxxx xxxx xxxx" (16 chars + 3 spaces).
  // Strip ALL spaces (and tabs) before validation.
  const cleanAppPassword = (appPassword || '').replace(/[\s]/g, '');
  if (!cleanAppPassword) {
    errs.push('appPassword is required.');
  } else if (cleanAppPassword.length !== 16) {
    errs.push(
      `appPassword must be exactly 16 characters after stripping spaces (got ${cleanAppPassword.length}). ` +
      'Generate one at: Google Account → Security → App Passwords.'
    );
  } else if (!/^[a-z0-9]+$/i.test(cleanAppPassword)) {
    errs.push('appPassword must contain only alphanumeric characters after stripping spaces.');
  }

  if (errs.length > 0) {
    const err = new Error(errs.join(' '));
    err.statusCode = 400;
    throw err;
  }

  return {
    gmailUser: cleanGmailUser,
    appPassword: cleanAppPassword, // space-stripped, ready to use
  };
}

module.exports = { validate };
