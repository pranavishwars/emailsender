(function () {
  'use strict';

  const MIN_VALID = 1;
  let pollInterval = null;
  let currentJobId = null;

  // ── Element refs ──────────────────────────────────────────────────────────
  const gmailUserInput   = document.getElementById('gmail-user-input');
  const appPasswordInput = document.getElementById('app-password-input');
  const accessKeyInput   = document.getElementById('access-key-input');
  const emailInput       = document.getElementById('email-input');
  const addressCounter   = document.getElementById('address-counter');
  const sendBtn          = document.getElementById('send-btn');
  const smtpBanner       = document.getElementById('smtp-banner');
  const errorBanner      = document.getElementById('error-banner');
  const successBanner    = document.getElementById('success-banner');
  const resultsSection   = document.getElementById('results-section');
  const resultsTbody     = document.getElementById('results-tbody');
  const jobSummary       = document.getElementById('job-summary');
  const csvLink          = document.getElementById('csv-link');
  const previewToggle    = document.getElementById('preview-toggle');
  const previewSection   = document.getElementById('preview-section');
  const previewSubject   = document.getElementById('preview-subject');
  const previewAttachment= document.getElementById('preview-attachment');
  const previewText      = document.getElementById('preview-text');

  // ── Banners ───────────────────────────────────────────────────────────────
  function showBanner(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
  }
  function hideBanner(el) {
    if (!el) return;
    el.textContent = '';
    el.classList.remove('visible');
  }

  // ── Health check on load ──────────────────────────────────────────────────
  fetch('/api/health')
    .then(r => r.json())
    .then(data => {
      if (!data.ok) {
        showBanner(smtpBanner, '⚠️ Server health check failed: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(() => {
      showBanner(smtpBanner, '⚠️ Cannot reach server. Make sure it is running.');
    });

  // ── Live address counter ──────────────────────────────────────────────────
  let counterDebounce = null;
  function scheduleCounterUpdate() {
    clearTimeout(counterDebounce);
    counterDebounce = setTimeout(updateCounter, 100);
  }

  if (emailInput) {
    emailInput.addEventListener('input', scheduleCounterUpdate);
    emailInput.addEventListener('keyup', scheduleCounterUpdate);
    emailInput.addEventListener('paste', () => setTimeout(updateCounter, 50));
    emailInput.addEventListener('change', updateCounter);
  }

  function quickParse(raw) {
    const seen = new Set();
    (raw || '').split(/[\s,;]+/).forEach(t => {
      t = t.trim().replace(/^[<"']+|[>"',;.]+$/g, '').toLowerCase();
      if (t && t.includes('@') && t.includes('.')) seen.add(t);
    });
    return seen.size;
  }

  function updateCounter() {
    if (!addressCounter || !emailInput) return;
    const n = quickParse(emailInput.value);
    addressCounter.textContent = n + ' valid unique address' + (n !== 1 ? 'es' : '');
    addressCounter.className = n >= MIN_VALID ? 'valid' : (n > 0 ? 'warn' : '');
  }

  // Initial counter check
  updateCounter();

  // ── Preview ───────────────────────────────────────────────────────────────
  if (previewToggle && previewSection) {
    previewToggle.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpen = previewSection.classList.toggle('open');
      previewToggle.textContent = isOpen ? 'Hide preview' : 'Show preview';
      if (isOpen) loadPreview();
    });
  }

  function loadPreview() {
    if (!previewSubject || !previewText) return;
    previewSubject.textContent = 'Loading subject…';
    previewText.textContent = 'Loading body…';

    const emailVal = (gmailUserInput && gmailUserInput.value ? gmailUserInput.value.trim() : '') || 'your.email@gmail.com';
    const body = { gmailUser: emailVal };

    fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          previewSubject.textContent = 'Error loading preview';
          if (previewAttachment) previewAttachment.style.display = 'none';
          previewText.textContent = data.error;
        } else {
          previewSubject.textContent = 'Subject: ' + (data.subject || '');
          if (previewAttachment) {
            if (data.attachments && data.attachments.length > 0) {
              const attList = data.attachments.map(a => `${a.filename} (${Math.round(a.sizeBytes / 1024)} KB)`).join(', ');
              previewAttachment.textContent = '📎 Attached: ' + attList;
              previewAttachment.style.display = 'block';
            } else {
              previewAttachment.style.display = 'none';
            }
          }
          previewText.textContent = data.text || '';
        }
      })
      .catch(err => {
        previewSubject.textContent = 'Error loading preview';
        if (previewAttachment) previewAttachment.style.display = 'none';
        previewText.textContent = 'Could not load preview: ' + err.message;
      });
  }

  // Reload preview when email input loses focus
  if (gmailUserInput) {
    gmailUserInput.addEventListener('blur', () => {
      if (previewSection && previewSection.classList.contains('open')) {
        loadPreview();
      }
    });
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  if (sendBtn) {
    sendBtn.addEventListener('click', handleSend);
  }

  async function handleSend() {
    hideBanner(errorBanner);
    hideBanner(successBanner);

    const gmailUser   = gmailUserInput ? gmailUserInput.value.trim() : '';
    const appPassword = appPasswordInput ? appPasswordInput.value : '';
    const accessKey   = accessKeyInput ? accessKeyInput.value.trim() : '';
    const emails      = emailInput ? emailInput.value : '';

    if (!gmailUser)   { showBanner(errorBanner, 'Gmail address is required.'); return; }
    if (!appPassword) { showBanner(errorBanner, 'App Password is required.'); return; }
    if (!accessKey)   { showBanner(errorBanner, 'Access key is required.'); return; }
    if (!emails.trim()){ showBanner(errorBanner, 'Paste at least one recipient email address.'); return; }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-key': accessKey,
        },
        body: JSON.stringify({ gmailUser, appPassword, emails, force: false }),
      });

      const data = await res.json();

      if (res.status === 202) {
        currentJobId = data.jobId;
        const msg = `Job started! Sending to ${data.toSend.length} address${data.toSend.length !== 1 ? 'es' : ''}.` +
          (data.alreadySent && data.alreadySent.length > 0 ? ` ${data.alreadySent.length} already sent (skipped).` : '');
        showBanner(successBanner, msg);
        initResultsTable(data);
        startPolling(data.jobId);
        sendBtn.textContent = 'Job running…';
      } else {
        const msg = data.error || JSON.stringify(data);
        showBanner(errorBanner, `Error ${res.status}: ${msg}`);
        resetSendBtn();
      }
    } catch (err) {
      showBanner(errorBanner, 'Network error: ' + err.message);
      resetSendBtn();
    }
  }

  function resetSendBtn() {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Emails';
    }
  }

  // ── Results table ─────────────────────────────────────────────────────────
  function initResultsTable(data) {
    if (!resultsSection || !resultsTbody) return;
    resultsSection.classList.add('visible');
    resultsTbody.innerHTML = '';
    if (csvLink) csvLink.style.display = 'none';
    if (jobSummary) jobSummary.textContent = `Job ${data.jobId} — ${data.toSend.length} to send`;

    (data.toSend || []).forEach(email => {
      resultsTbody.appendChild(buildRow(email, 'pending', 0, null, null));
    });
  }

  function buildRow(email, status, attempts, error, messageId) {
    const tr = document.createElement('tr');
    tr.id = 'row-' + CSS.escape(email);
    tr.innerHTML = `
      <td>${escHtml(email)}</td>
      <td><span class="status-badge badge-${status}">${status}</span></td>
      <td>${attempts}</td>
      <td>
        ${status === 'uncertain' ? '<div class="note-uncertain">⚠ Check your Gmail Sent folder before resending.</div>' : ''}
        ${error && status !== 'sent' ? '<div class="note-error">' + escHtml(error) + '</div>' : ''}
        ${messageId ? '<div style="font-size:11px;color:#888;">' + escHtml(messageId) + '</div>' : ''}
      </td>`;
    return tr;
  }

  function updateRow(rec) {
    if (!resultsTbody) return;
    const existing = document.getElementById('row-' + CSS.escape(rec.email));
    const newRow = buildRow(rec.email, rec.status, rec.attempts, rec.error, rec.messageId);
    if (existing) existing.replaceWith(newRow);
    else resultsTbody.appendChild(newRow);
  }

  // ── Polling ───────────────────────────────────────────────────────────────
  function startPolling(jobId) {
    stopPolling();
    pollInterval = setInterval(() => pollJob(jobId), 3000);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  async function pollJob(jobId) {
    try {
      const res = await fetch('/api/jobs/' + jobId);
      if (!res.ok) return;
      const job = await res.json();

      // Update all rows
      (job.recipients || []).forEach(rec => updateRow(rec));

      // Update summary
      const counts = { sent: 0, failed: 0, uncertain: 0, pending: 0, sending: 0 };
      (job.recipients || []).forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      if (jobSummary) {
        jobSummary.textContent = `Job ${job.jobId} [${job.status}] — ` +
          Object.entries(counts).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k}`).join(', ');
      }

      // Terminal states
      const done = ['completed', 'completed_with_errors', 'aborted'].includes(job.status);
      if (done) {
        stopPolling();
        resetSendBtn();
        if (job.status === 'aborted') {
          showBanner(errorBanner, 'Job aborted: ' + (job.abortReason || 'Unknown reason'));
        }
        if (csvLink) {
          csvLink.href = `/api/jobs/${jobId}/report.csv`;
          csvLink.style.display = 'inline';
        }
      }
    } catch (_) { /* ignore transient fetch errors during polling */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
})();
