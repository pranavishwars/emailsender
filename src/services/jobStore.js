'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const JOBS_DIR = path.join(process.cwd(), 'data', 'jobs');

function ensureDir() {
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  }
}

function jobPath(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}
function tmpPath(jobId) {
  return path.join(JOBS_DIR, `${jobId}.tmp`);
}

/**
 * Atomically writes a job object to disk.
 * Write to .tmp then rename (atomic on POSIX).
 * IMPORTANT: appPassword must NEVER be present in the job object passed here.
 */
function persist(job) {
  ensureDir();
  const data = JSON.stringify(job, null, 2);
  const tmp = tmpPath(job.jobId);
  const dest = jobPath(job.jobId);
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, dest);
}

/**
 * Creates a new job record and persists it.
 * @returns {string} jobId
 */
function createJob({ senderName, senderEmail, recipients }) {
  ensureDir();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    senderName,
    senderEmail,
    abortReason: null,
    recipients: recipients.map((email) => ({
      email,
      status: 'pending',
      attempts: 0,
      messageId: null,
      smtpResponse: null,
      error: null,
      sentAt: null,
    })),
  };
  persist(job);
  logger.info({ jobId, senderEmail, count: recipients.length }, '[jobStore] Job created');
  return jobId;
}

/**
 * Returns the full job object (loaded fresh from disk) or null if not found.
 */
function getJob(jobId) {
  ensureDir();
  const p = jobPath(jobId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    logger.error({ jobId, err: e.message }, '[jobStore] Failed to read job');
    return null;
  }
}

/**
 * Updates a single recipient's fields and persists.
 */
function updateRecipient(jobId, email, patch) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const rec = job.recipients.find((r) => r.email === email);
  if (!rec) throw new Error(`Recipient ${email} not found in job ${jobId}`);
  Object.assign(rec, patch);
  job.updatedAt = new Date().toISOString();
  persist(job);
}

/**
 * Updates the job's top-level status and persists.
 */
function updateJobStatus(jobId, status, extra = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  job.status = status;
  job.updatedAt = new Date().toISOString();
  Object.assign(job, extra);
  persist(job);
  logger.info({ jobId, status }, '[jobStore] Job status updated');
}

/**
 * On startup: scan for jobs stuck in 'running' state (server crashed mid-job).
 * Set them to 'aborted' and any 'sending' recipients to 'uncertain'.
 */
function recoverStaleJobs() {
  ensureDir();
  const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  let recovered = 0;
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, file), 'utf-8'));
      if (job.status === 'running') {
        job.status = 'aborted';
        job.abortReason = 'Server restarted while job was running.';
        job.updatedAt = new Date().toISOString();
        for (const rec of job.recipients) {
          if (rec.status === 'sending') {
            // Cannot know if the send succeeded — mark uncertain, NOT pending
            rec.status = 'uncertain';
            rec.error = 'Server restarted mid-send. Check Gmail Sent folder.';
          }
        }
        persist(job);
        logger.warn({ jobId: job.jobId }, '[jobStore] Recovered stale job → aborted');
        recovered++;
      }
    } catch (e) {
      logger.error({ file, err: e.message }, '[jobStore] Failed to recover job file');
    }
  }
  if (recovered > 0) logger.warn({ recovered }, '[jobStore] Stale jobs recovered on startup');
}

module.exports = { createJob, getJob, updateRecipient, updateJobStatus, recoverStaleJobs };
