'use strict';

const express = require('express');
const jobStore = require('../services/jobStore');

const router = express.Router();

/**
 * GET /api/jobs/:jobId
 * Returns the full job object. Frontend polls every 3 seconds.
 */
router.get('/jobs/:jobId', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  return res.json(job);
});

/**
 * GET /api/jobs/:jobId/report.csv
 * Returns a CSV report of per-recipient results.
 */
router.get('/jobs/:jobId/report.csv', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const rows = [
    ['email', 'status', 'attempts', 'messageId', 'error', 'sentAt'].join(','),
    ...job.recipients.map((r) =>
      [
        csvCell(r.email),
        csvCell(r.status),
        r.attempts,
        csvCell(r.messageId || ''),
        csvCell(r.error || ''),
        csvCell(r.sentAt || ''),
      ].join(',')
    ),
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="job-${req.params.jobId}.csv"`);
  return res.send(rows.join('\r\n'));
});

function csvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/"/g, '""');
  return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
}

module.exports = router;
