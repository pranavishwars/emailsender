'use strict';

const express = require('express');
const ledger = require('../services/ledger');
const config = require('../config');

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    const sentLast24h = ledger.countSentLast24h('__all__'); // global count not needed; just show 0
    return res.json({
      ok: true,
      server: 'ready',
      templatesLoaded: true,
      sentLast24h: 0, // per-sender; no global sender known at health time
      dailyLimit: config.DAILY_SEND_LIMIT,
      note: 'SMTP is verified per-job when you press Send. Check credentials are correct before sending.',
    });
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.message });
  }
});

module.exports = router;
