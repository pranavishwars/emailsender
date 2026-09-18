'use strict';

const express = require('express');
const credentialValidator = require('../services/credentialValidator');
const template = require('../services/template');

const router = express.Router();

const fs = require('fs');
const mailer = require('../services/mailer');

/**
 * POST /api/preview
 * Body: { gmailUser }
 * Returns: { subject, html, text, attachments }
 * No auth required — no sending happens.
 */
router.post('/preview', (req, res) => {
  try {
    const { gmailUser } = req.body || {};
    const cleanEmail = (gmailUser || '').trim() || 'your.email@gmail.com';

    const rendered = template.render({ gmailUser: cleanEmail });
    const attachments = mailer.getAttachments().map((a) => ({
      filename: a.filename,
      sizeBytes: fs.existsSync(a.path) ? fs.statSync(a.path).size : 0,
    }));

    return res.json({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments,
    });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
});

module.exports = router;
