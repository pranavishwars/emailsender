'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const TEMPLATES_DIR = path.join(process.cwd(), 'templates');

// Loaded once at startup
let rawSubject = null;
let rawHtml = null;
let rawText = null;

/** Regex that matches any unresolved {{placeholder}} */
const UNRESOLVED_RE = /\{\{\s*[\w]+\s*\}\}/g;

/**
 * Loads all three template files. Throws if any are missing.
 * Call once at server startup.
 */
function loadTemplates() {
  const files = {
    'subject.txt': 'rawSubject',
    'sponsorship.html': 'rawHtml',
    'sponsorship.txt': 'rawText',
  };

  for (const [filename, varName] of Object.entries(files)) {
    const filePath = path.join(TEMPLATES_DIR, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`[template] Missing required template file: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    // Store in module-level vars
    ({ rawSubject, rawHtml, rawText } = {
      rawSubject: varName === 'rawSubject' ? content : rawSubject,
      rawHtml: varName === 'rawHtml' ? content : rawHtml,
      rawText: varName === 'rawText' ? content : rawText,
    });
  }
}

/**
 * HTML-escapes a string for safe insertion into the HTML template.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips \r and \n from a value used in headers (subject, From name).
 */
function stripNewlines(str) {
  return String(str).replace(/[\r\n]/g, '');
}

/**
 * Replaces all occurrences of {{key}} with a value.
 * escapeForHtml: if true, HTML-escapes the value before substitution.
 */
function substitute(template, key, value, escapeForHtml) {
  const safeValue = escapeForHtml ? escapeHtml(value) : String(value);
  return template.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), safeValue);
}

/**
 * Renders the templates for a given job.
 *
 * @param {{ gmailUser: string }} creds
 * @returns {{ subject: string, html: string, text: string }}
 * @throws if any {{placeholder}} remains unresolved
 */
function render({ gmailUser }) {
  if (!rawSubject || !rawHtml || !rawText) {
    throw new Error('[template] Templates not loaded. Call loadTemplates() at startup.');
  }

  const chapterShortName = config.CHAPTER_SHORT_NAME || config.CHAPTER_NAME;

  // All substitution values
  const values = {
    sender_name: chapterShortName,  // From the chapter, not a personal name
    sender_role: config.SENDER_ROLE,
    chapter_name: config.CHAPTER_NAME,
    chapter_short_name: chapterShortName,
    event_name: config.EVENT_NAME,
    contact_email: gmailUser,
    contact_phone: config.CONTACT_PHONE || '',
  };

  let subject = rawSubject;
  let html = rawHtml;
  let text = rawText;

  for (const [key, value] of Object.entries(values)) {
    // Subject: strip newlines from values (header injection protection)
    subject = substitute(subject, key, stripNewlines(value), false);
    // HTML body: HTML-escape values
    html = substitute(html, key, value, true);
    // Plain text: no escaping
    text = substitute(text, key, value, false);
  }

  // If contact_phone is empty, clean up lines that only have the placeholder
  if (!config.CONTACT_PHONE) {
    html = html.replace(/<br>\s*\n?\s*$/m, '').replace(/\{\{contact_phone\}\}/g, '');
    text = text.replace(/^\s*\{\{contact_phone\}\}\s*\n?/gm, '');
  }

  // Final strip of subject newlines
  subject = subject.replace(/[\r\n]/g, '').trim();

  // Unresolved placeholder check — MUST throw before any sending
  for (const [label, content] of [['subject', subject], ['html', html], ['text', text]]) {
    const matches = content.match(UNRESOLVED_RE);
    if (matches) {
      throw new Error(
        `[template] Unresolved placeholder(s) in ${label}: ${[...new Set(matches)].join(', ')}. ` +
        'Check your .env file and template files.'
      );
    }
  }

  return { subject, html, text };
}

module.exports = { loadTemplates, render };
