# Project Spec: Sponsorship Cold-Mail Bot

> **Instruction to the coding bot:** Build exactly what is described below. The **backend is the product**. The frontend is deliberately minimal and must not consume effort that belongs to the backend. When something in this document conflicts with your own habits or defaults, this document wins. If something is ambiguous, choose the option that maximises **safe, uncorrupted, non-duplicated delivery** of each email.

---

## 1. Purpose

A small web app used by a student chapter to send **cold sponsorship emails**.

- The user pastes **15 or more recipient email addresses** into one input box and presses **Send**.
- The backend sends **one fixed, pre-written email (the "blueprint")** to every address.
- The blueprint has placeholders so the **sender's name** can be changed without editing the template.
- Every email must go to a **different external account** (the recipients are strangers at other companies), not to the account owner.

### Priority order (never violate)

1. **Every email is delivered intact**: no garbled characters, no broken links, no truncated body, no header corruption, no wrong recipient, no exposed recipient list.
2. **No duplicate sends** to the same person (a cold mail sent twice hurts the chapter's reputation).
3. **Deliverability**: the email should not look like spam.
4. **Traceability**: the user can see exactly which addresses succeeded, failed, or are uncertain.
5. Simplicity of UI (lowest priority).

---

## 2. Which API / provider to use (and which not to)

### 2.1 Why Resend does not work here
Resend's free/onboarding setup (`onboarding@resend.dev`) only delivers to the **account owner's own email**. Sending to arbitrary third parties requires a verified custom domain. Since the chapter is emailing many different external accounts, **do not use Resend**.

### 2.2 "Google AI Studio" is not a mail API
Google AI Studio / Gemini API generates text with AI. It **cannot send email**, and it is **not wanted here anyway**: the blueprint text must be sent exactly as written, and an LLM could alter it. **Do not use any LLM in this project.**
The correct Google product for sending mail is **Gmail (SMTP or Gmail API)**.

### 2.3 Provider comparison

| Provider | Can email arbitrary recipients on free tier? | Notes | Verdict |
|---|---|---|---|
| **Gmail SMTP via App Password (Nodemailer)** | Yes | Sent from the chapter's real Google account. Mail is copied to the Sent folder automatically (free audit trail). Best reputation for low-volume cold mail. 500 recipients/day (free Gmail), 2,000/day (Workspace). | **PRIMARY** |
| **Gmail API (OAuth2)** | Yes | Same quota and reputation. More setup. Can be used through Nodemailer's OAuth2 transport with no other code changes. | **Supported alternative** (config switch) |
| Resend | No (owner email only without verified domain) | | Rejected |
| Mailgun (sandbox) | No (authorised recipients only) | | Rejected |
| Amazon SES (sandbox) | No (verified recipients only until production access is granted) | | Rejected |
| SendGrid | Needs sender/domain verification; no ongoing free tier | | Not recommended |
| Brevo (SMTP relay) | Yes, ~300/day free | Sending "as" a gmail.com address through a third-party relay fails DMARC alignment and often lands in spam. Only good if the chapter owns a domain and sets up SPF/DKIM. | **Fallback only** |

### 2.4 Final decision
- **Runtime:** Node.js 20+ (LTS).
- **Framework:** Express.
- **Mail library:** `nodemailer`.
- **Transport:** Gmail SMTP (`smtp.gmail.com`, port 465, TLS) with an **App Password**. Optionally switchable to Gmail OAuth2 through env config.
- **Wrap the transport behind a `mailer.js` interface** so the provider can be swapped later without touching other files.

> Prerequisite for the user (document this in README): the sending Google account needs **2-Step Verification enabled**, then generate an **App Password** at Google Account → Security → App passwords. Google Workspace admins may have disabled app passwords; in that case use the OAuth2 option.

---

## 3. Functional requirements

### 3.1 Inputs
- **Recipient emails** (required): one text area. Accept addresses separated by **newlines, commas, semicolons, spaces, or tabs**, in any mix.
- **Sender name** (config): stored in `.env` as `SENDER_NAME`. It is used in the `From` display name **and** in the email body signature via the `{{sender_name}}` placeholder.
  - *Optional convenience:* the UI may include a single small optional text field "Sender name (leave blank to use default)". If provided, it overrides `SENDER_NAME` for that job only. Keep the UI otherwise limited to the textarea and the Send button.

### 3.2 Parsing and validation (backend is the source of truth)
The frontend may do light checks, but **all rules are enforced on the backend**:

1. Split input on `/[\s,;]+/`, trim each token, drop empty tokens.
2. Strip surrounding characters like `<`, `>`, quotes, and trailing punctuation (people paste `"John <john@x.com>"` or `john@x.com,`). If a token looks like `Name <addr@x.com>`, extract the address.
3. Lowercase the whole address (domain must be lowercased; lowercasing the local part is acceptable for this use).
4. Validate syntax with the `validator` package (`validator.isEmail`) or an equally strict check. Reject anything containing `\r`, `\n`, `,`, or whitespace (header injection protection).
5. **Deduplicate** (case-insensitive).
6. **Minimum 15 valid unique addresses required.** If fewer, return `400` with a message such as `"Only 12 valid unique addresses found; minimum is 15."` and include the list of rejected/duplicate tokens so the user can fix them. **Send nothing** in this case.
7. **Maximum cap** configurable via `MAX_RECIPIENTS_PER_JOB` (default 100, hard ceiling 400 to stay under Gmail's daily limit). Reject above the cap.
8. Optional but recommended: **MX record lookup** (`dns.promises.resolveMx`) per unique domain. A domain with no MX records is flagged as invalid (rejected, listed in the response) rather than attempted. A DNS timeout must **not** reject the address (treat as "unknown, attempt anyway").
9. Check the ledger (section 3.6): addresses that have already been emailed are excluded unless `force: true` is passed. Recheck the minimum-15 rule on the **new** addresses only, or report clearly if the remaining count falls below 15 (see 3.6).

### 3.3 Sending behaviour (the most important part)
- **One individual email per recipient.** Never put multiple recipients in `To`, `Cc`, or `Bcc`. Recipients must never see each other's addresses.
- Emails are sent **sequentially, not in parallel**, with a **randomised delay** between messages (`SEND_DELAY_MIN_MS` = 8000, `SEND_DELAY_MAX_MS` = 20000 by default). This mimics human sending, protects the account's reputation, and prevents rate-limit errors.
- Reuse a **single pooled SMTP connection** for the whole job (`pool: true`, `maxConnections: 1`, `maxMessages: 100`). Do not open a new connection per email.
- Each email is built from the template with `sender_name` substituted (section 4).
- A message counts as **`sent`** only when Nodemailer resolves and `info.accepted` **includes** that recipient and `info.rejected` is empty. Log `info.messageId` and `info.response` (should look like `250 2.0.0 OK ...`).

### 3.4 Job model (asynchronous, because sending 15+ emails with delays takes minutes)
HTTP request timeouts must never interrupt a send. Therefore:

- `POST /api/send` validates input, creates a **job**, immediately returns `202 Accepted` with `{ jobId, accepted: [...], rejected: [...], duplicates: [...], alreadySent: [...] }`, and starts sending **in the background**.
- `GET /api/jobs/:jobId` returns live progress: overall status (`queued | running | completed | completed_with_errors | aborted`) and a per-recipient array with `status` in `pending | sending | sent | failed | uncertain`, timestamps, attempt count, `messageId`, and error text.
- **Only one job may run at a time** (simple in-process mutex). A second `POST /api/send` while a job is running returns `409 Conflict`. This prevents accidental double-clicks from double-sending.
- **The Send button must be disabled after click** and the backend must be **idempotent** even if the frontend misbehaves (see the ledger and the mutex).
- Job state is **persisted to disk after every recipient update** (write to a temp file, then atomic rename). If the server crashes or restarts mid-job, on startup any job in `running` state is marked `aborted`, and any recipient stuck in `sending` is marked **`uncertain`** (not `pending`, to avoid duplicate sends).

### 3.5 Error handling and retries

Classify every failure:

| Class | Examples | Action |
|---|---|---|
| **Transient (safe to retry)** | connection failure *before* the message body was sent (`ECONNECTION`, `ETIMEDOUT` on connect, `ECONNRESET` on connect), SMTP `421`, `450`, `451`, `452` | Retry up to `MAX_RETRIES` (default 3) with exponential backoff (30 s, 60 s, 120 s) plus jitter. Reopen the transport if needed. |
| **Permanent** | SMTP `550`, `551`, `553`, `554` (bad mailbox, policy rejection), `5.1.1` user unknown | Mark `failed`. **Do not retry.** Store the full SMTP response. |
| **Account-level / fatal** | `535` authentication failure, `534`, `550 5.4.5 Daily user sending quota exceeded`, `421 4.7.0` temporary block | **Abort the whole job immediately.** Mark remaining recipients `pending` and job `aborted`, with a clear message. Do not keep hammering. |
| **Uncertain** | A timeout or connection drop **after the message data was transmitted** (during or after `DATA`), where it's unknown whether the server accepted it | Mark **`uncertain`**. **Never auto-retry** (this would risk a duplicate). The UI tells the user to check the account's Sent folder for those addresses. |

If uncertain how to classify an error, treat it as `uncertain` rather than retrying. A missed email can be resent manually; a duplicate cold mail cannot be un-sent.

### 3.6 Ledger (duplicate protection across jobs)
- Maintain `data/ledger.json` (or SQLite via `better-sqlite3`, developer's choice; SQLite preferred if the coder is comfortable, JSON with atomic writes is acceptable).
- Record every successfully `sent` address with timestamp, jobId, and messageId.
- Before creating a job, exclude addresses already in the ledger and return them in `alreadySent`.
- The user may override with `force: true` (the frontend does not need to expose this; it is available via API only).
- If exclusion drops the remaining count below 15, **still send** (the 15-minimum is a validation on what the user submits, not on what remains). But the response must clearly say how many were skipped as already sent.

### 3.7 Frontend/API safety
- The Send endpoint must be protected. Otherwise anyone who finds the URL can use the chapter's Gmail account as a spam relay.
  - Require a shared secret: the frontend sends the header `x-access-key`, which must equal `ACCESS_KEY` in `.env`. The UI has a tiny password field or reads it from a `prompt()` once and keeps it in memory (not localStorage). Use a constant-time compare (`crypto.timingSafeEqual`).
  - Apply `express-rate-limit` (e.g. 10 requests/min per IP) and `helmet`.
  - Body size limit (`express.json({ limit: '200kb' })`).
- CORS: same-origin only (the Express server serves the frontend statically), so no CORS package is required.

---

## 4. Email content and MIME correctness (this is where "corruption" happens, so follow closely)

### 4.1 Template files
Store templates outside the code so the user can edit them without touching JavaScript:

```
templates/
  subject.txt        // one line, may contain {{placeholders}}
  sponsorship.html   // HTML body
  sponsorship.txt    // plain-text body (must convey the same content)
```

### 4.2 Placeholders (simple `{{name}}` replacement; do not add a heavy template engine)
| Placeholder | Source |
|---|---|
| `{{sender_name}}` | `SENDER_NAME` or the per-job override |
| `{{sender_role}}` | `SENDER_ROLE` (optional, may be empty) |
| `{{chapter_name}}` | `CHAPTER_NAME` |
| `{{event_name}}` | `EVENT_NAME` |
| `{{contact_email}}` | the sending account address |
| `{{contact_phone}}` | `CONTACT_PHONE` (optional) |

Rules:
- The recipient's name is **not known**, so the greeting must be generic ("Hello," / "Dear Sir/Madam,"). Do **not** invent a recipient name from the email address.
- **HTML-escape** every substituted value in the HTML template (`&`, `<`, `>`, `"`, `'`). Do **not** escape in the plain-text template.
- On startup and before each job, **fail fast if any `{{placeholder}}` remains unresolved** in the rendered subject/HTML/text (regex `/{{\s*[\w]+\s*}}/`). An email with a visible `{{sender_name}}` is a corrupted email. Abort with a clear error rather than sending.
- Strip `\r` and `\n` from values used in the **subject** and **From name** (header injection).

### 4.3 Message construction
Build each message with Nodemailer like this:

```js
{
  from: { name: senderName, address: process.env.GMAIL_USER },
  to: recipient,                       // single address string only
  replyTo: process.env.REPLY_TO || process.env.GMAIL_USER,
  subject: renderedSubject,
  text: renderedPlainText,             // ALWAYS include plain-text alternative
  html: renderedHtml,                  // multipart/alternative is produced automatically
  encoding: 'utf-8',                   // explicit
  headers: {
    'X-Mailer': 'ChapterSponsorMailer', // optional, harmless
    // Optional and recommended for cold mail:
    'List-Unsubscribe': '<mailto:' + process.env.GMAIL_USER + '?subject=unsubscribe>'
  }
}
```

Corruption-prevention checklist:
- Always send **`multipart/alternative`** (text + HTML). HTML-only mail is spam-flagged.
- **UTF-8 everywhere**; the HTML must include `<meta charset="utf-8">`. Let Nodemailer choose quoted-printable/base64 automatically. **Do not hand-build MIME.**
- Non-ASCII characters in the **From name or subject** (for example "Ananya Iyer", "R. Müller", emoji) are handled by Nodemailer's RFC 2047 encoding. Test them (section 8).
- **No line over 998 characters** in the HTML (Nodemailer will wrap with QP, but keep the source sane).
- Keep the HTML **simple**: inline CSS only, tables or plain `<p>` tags, **no external CSS, no JavaScript, no forms, no embedded base64 images**.
- **No tracking pixels, no link shorteners** (bit.ly etc.). Both hurt cold-mail deliverability.
- **No attachments** in the email body (attachments frequently trigger spam filters for cold mail). If the sponsorship deck is needed, link to it (a single Google Drive/Docs link or the chapter's website) in the body. If the user later insists on an attachment, keep it a PDF under 2 MB.
- Use **absolute `https://` URLs** only, and at most 2 links total.
- Subject: under about 60 characters, no ALL CAPS, no "!!!", no "FREE", no "URGENT", no "$$$".
- Body: about 120-200 words, human tone, clear ask, one call to action, and an easy way to decline ("Reply 'no thanks' and we won't contact you again").
- The **Message-ID** should be generated by Nodemailer using the sending domain (default behaviour). Do not override it.
- **The rendered messages must be identical apart from the sender name substitution.** Add a unit test asserting this.

### 4.4 Sample blueprint (the user will replace the wording; this is a placeholder to demonstrate the structure)

`templates/subject.txt`
```
Sponsorship opportunity: {{event_name}} by {{chapter_name}}
```

`templates/sponsorship.txt`
```
Hello,

I'm {{sender_name}}, {{sender_role}} at {{chapter_name}}. We are organising {{event_name}} and are looking for sponsors who would like to reach an audience of engaged students and young professionals.

In return for your support we can offer brand visibility at the event, a mention across our social channels, and direct interaction with participants. We would be glad to share the full sponsorship brief and tailor a package to your goals.

If this is of interest, simply reply to this email or write to {{contact_email}}. If it isn't relevant to you, reply "no thanks" and we won't contact you again.

Thank you for your time.

Warm regards,
{{sender_name}}
{{sender_role}}, {{chapter_name}}
{{contact_email}}
```

`templates/sponsorship.html`
```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #222;">
  <p>Hello,</p>
  <p>I'm {{sender_name}}, {{sender_role}} at {{chapter_name}}. We are organising {{event_name}} and are looking for sponsors who would like to reach an audience of engaged students and young professionals.</p>
  <p>In return for your support we can offer brand visibility at the event, a mention across our social channels, and direct interaction with participants. We would be glad to share the full sponsorship brief and tailor a package to your goals.</p>
  <p>If this is of interest, simply reply to this email or write to {{contact_email}}. If it isn't relevant to you, reply "no thanks" and we won't contact you again.</p>
  <p>Thank you for your time.</p>
  <p>Warm regards,<br>{{sender_name}}<br>{{sender_role}}, {{chapter_name}}<br>{{contact_email}}</p>
</body>
</html>
```
If `sender_role` is empty, the template must degrade gracefully (implement: remove the line/segment cleanly or require the value at startup). Simplest rule: **require `SENDER_ROLE` to be non-empty** or make the coder split templates into conditional segments. Do not leave stray commas like "I'm Name, at Chapter".

---

## 5. Deliverability guidance (build these in, and document the rest in the README)

Built into the code:
- Sequential sending with randomised 8-20 s spacing (see 3.3).
- Personalised `From` display name plus a real, monitored `Reply-To`.
- Plain text plus HTML, few links, no attachments, no tracking, opt-out line, `List-Unsubscribe` header.
- Daily send counter: track total sent in the last 24 h from the ledger and **refuse to start** a job that would exceed `DAILY_SEND_LIMIT` (default 400 for consumer Gmail, safely under the 500 limit; can be set to 1500 for Workspace).

Document in the README (operational advice for the user):
- Send from an **established** Google account that has real, normal usage. A brand-new account sending cold mail will get flagged.
- If the chapter has a **Google Workspace with its own domain**, verify **SPF, DKIM (enable in Workspace admin), and DMARC** DNS records. This is the single biggest deliverability improvement.
- Warm up: if the account has never sent bulk mail, start with 15-20 emails/day and increase gradually.
- Do not send the same job twice; do not send at 3 a.m.; avoid weekends when possible.
- Check the sending inbox for **bounce notifications** (`Mail Delivery Subsystem`), since SMTP acceptance is not the same as inbox delivery.
- Be honest about the guarantee: the bot can guarantee that each message is **correctly formed and accepted by the recipient's mail system** (or reports precisely why not). No software can guarantee it avoids the recipient's spam folder.

---

## 6. API specification

### `GET /api/health`
Runs `transporter.verify()` and returns `{ ok: true, smtp: "ready", sender: "<address>", sentLast24h: n, dailyLimit: n }` or `{ ok: false, error }`. The frontend calls this on load and shows a red banner if the SMTP is not ready.

### `POST /api/preview` *(recommended)*
Body: `{ senderName? }` → returns the rendered subject, HTML, and text (no recipients). Lets the user see exactly what will be sent before sending. The frontend may show this in a collapsible area (optional).

### `POST /api/send`
Headers: `x-access-key`.
Body:
```json
{ "emails": "a@x.com, b@y.com\nc@z.org ...", "senderName": "optional", "force": false }
```
Responses:
- `202` → `{ jobId, total, toSend: [...], invalid: [...], duplicatesInInput: [...], alreadySent: [...] }`
- `400` → validation failure, including the fewer-than-15 case, with details
- `401` → bad access key
- `409` → another job already running
- `422` → template error (unresolved placeholder, missing template)
- `429` → rate-limited, or daily limit would be exceeded
- `503` → SMTP not ready

### `GET /api/jobs/:jobId`
Returns the full job (status plus per-recipient results). Poll every 3 s from the frontend.

### `GET /api/jobs/:jobId/report.csv` *(nice to have)*
CSV of `email,status,attempts,messageId,error,timestamp`.

---

## 7. Frontend (intentionally minimal)

Single static `public/index.html` with vanilla JS (no build step, no framework):
- A `<textarea>` labelled "Recipient emails (minimum 15, separated by commas or new lines)".
- A live counter beneath it of "N valid unique addresses" (cosmetic, computed client-side).
- One **Send** button. It is **disabled while a job is running** and on click (prevents double sends).
- After sending: a plain list/table showing each address and its live status (pending / sending / sent / failed / uncertain), refreshed by polling `/api/jobs/:id`. Show any error text next to failed rows and a note next to `uncertain` rows: "Check the Sent folder before resending."
- If `/api/health` reports the SMTP is not ready, show a visible warning.
- No styling effort beyond basic readable defaults.

---

## 8. Project structure

```
sponsor-mailer/
├── package.json
├── .env.example
├── .gitignore                 # must include .env, data/, logs/
├── README.md                  # setup steps (Gmail App Password, running, operational advice)
├── server.js                  # app bootstrap, static hosting, routes, graceful shutdown
├── src/
│   ├── config.js              # loads + validates env (fail fast on missing/invalid values)
│   ├── middleware/
│   │   ├── auth.js            # x-access-key check (timingSafeEqual)
│   │   └── limits.js          # helmet, rate limit
│   ├── routes/
│   │   ├── send.js
│   │   ├── jobs.js
│   │   ├── preview.js
│   │   └── health.js
│   ├── services/
│   │   ├── emailParser.js     # parse/validate/dedupe/MX check
│   │   ├── template.js        # load, render, escape, unresolved-placeholder check
│   │   ├── mailer.js          # Nodemailer transport factory (gmail-smtp | gmail-oauth2), send(), error classifier
│   │   ├── jobRunner.js       # background loop: sequential send, delay, retries, abort logic, mutex
│   │   ├── jobStore.js        # persistent job state (atomic writes), recovery on startup
│   │   └── ledger.js          # sent-address ledger, 24h counter
│   └── utils/
│       ├── logger.js          # pino or winston; log to console and logs/app.log
│       └── sleep.js
├── templates/                 # subject.txt, sponsorship.html, sponsorship.txt
├── public/index.html
├── data/                      # ledger + jobs (gitignored)
├── logs/
└── tests/
```

### Dependencies
`express`, `nodemailer`, `dotenv`, `validator`, `helmet`, `express-rate-limit`, `pino` (or `winston`), `nanoid` (job IDs, or use `crypto.randomUUID()`), optionally `better-sqlite3`. Dev: `vitest` or `jest`, `supertest`.

### `.env.example`
```
# --- Server ---
PORT=3000
ACCESS_KEY=change-me-to-a-long-random-string

# --- Gmail SMTP (primary) ---
MAIL_TRANSPORT=gmail-smtp            # gmail-smtp | gmail-oauth2
GMAIL_USER=chapter.account@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# --- Gmail OAuth2 (only if MAIL_TRANSPORT=gmail-oauth2) ---
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=

# --- Identity / template values ---
SENDER_NAME=Aarav Sharma
SENDER_ROLE=Sponsorship Lead
CHAPTER_NAME=Your Chapter Name
EVENT_NAME=Your Event Name
CONTACT_PHONE=
REPLY_TO=

# --- Sending behaviour ---
MIN_RECIPIENTS=15
MAX_RECIPIENTS_PER_JOB=100
SEND_DELAY_MIN_MS=8000
SEND_DELAY_MAX_MS=20000
MAX_RETRIES=3
DAILY_SEND_LIMIT=400
```

`config.js` must validate all of the above at startup and **exit with a clear message** if anything required is missing (for example no `GMAIL_APP_PASSWORD`), rather than failing halfway through a job. Strip spaces from the app password before use.

---

## 9. Backend implementation notes

**Job runner pseudo-flow**
```
run(job):
  acquire mutex
  verify transport (transporter.verify()); if it fails → job aborted, no mail sent
  render template once for subject/text/html *per sender name*; run unresolved-placeholder check; abort on failure
  for each recipient in order:
      if job.aborted: break
      mark recipient 'sending'; persist
      result = await sendWithRetry(recipient)
      if result.ok: mark 'sent'; append to ledger; persist
      else if result.class == 'fatal': mark remaining as 'pending', job 'aborted', persist, break
      else if result.class == 'uncertain': mark 'uncertain'; persist
      else: mark 'failed'; persist
      await sleep(randomBetween(MIN, MAX))    // skip after the last one
  final status = all sent ? 'completed' : 'completed_with_errors' (or 'aborted')
  close transporter pool; release mutex
```

**Details that matter**
- The **ledger append happens before** the delay and **inside the same persisted step** as marking `sent` (write ledger first, then job state, so a crash cannot lead to "sent but not recorded").
- Verify with `transporter.verify()` at **server startup** and at **job start**.
- `SIGINT`/`SIGTERM`: stop accepting new jobs, let the current send finish (or mark it `uncertain`), persist, close transporter, then exit.
- Never log the app password, access key, or full email bodies. Logging recipient addresses and SMTP responses is fine.
- Treat the server as **single instance** (no clustering, no serverless). Serverless platforms (Vercel, Netlify functions) will kill a long background job. Deploy on a small always-on Node host (Render, Railway, a VPS, or just run locally on a laptop during the sending session). Document this.
- Gmail's SMTP will **overwrite the `From` address** with the authenticated account unless a "Send mail as" alias is verified in Gmail settings. The display name is free to change; the address is not. Do not try to spoof another address.

---

## 10. Testing requirements (do not skip; the priority is correctness)

**Unit tests**
1. `emailParser`: mixed separators, duplicates with different case, `Name <a@b.com>` format, trailing punctuation, invalid syntax, CR/LF injection attempt (`a@b.com\r\nBcc: x@y.com`), exactly 14 vs 15 valid addresses.
2. `template`: all placeholders resolved; HTML escaping of `<`, `&`, `"` in sender name (`O'Brien & Sons <x>`); unresolved placeholder → throws; CR/LF stripped from subject; Unicode names.
3. `mailer` error classifier: table-driven tests with real SMTP error shapes (`responseCode` 421/450/550/535, `code` `ETIMEDOUT`/`ECONNECTION`/`EAUTH`, and `command` `DATA` vs `CONN`) → correct class.
4. `jobRunner` with a **mocked transport**: all succeed; one permanent failure; transient failure then success; fatal auth failure aborts and leaves the rest `pending`; uncertain error is **not** retried; crash recovery marks `sending` as `uncertain`; second concurrent job → 409; the ledger prevents re-sending.

**MIME integrity tests** (use Nodemailer's `streamTransport` or `jsonTransport` to capture the raw message without sending)
- Exactly one `To` address per message and **no `Cc`/`Bcc`**.
- `multipart/alternative` with both `text/plain` and `text/html` parts, both `charset=utf-8`.
- Subject and From name with non-ASCII characters round-trip correctly after decoding (use `mailparser`'s `simpleParser` to parse the captured raw message and compare).
- The body from the decoded parts equals the rendered template exactly.
- Across all recipients, messages differ only in the `To` header, `Message-ID`, and `Date`.

**Manual end-to-end acceptance test (document as a checklist in the README)**
1. Send a real job of 15 addresses consisting of **test accounts the team controls** on at least Gmail, Outlook/Hotmail, and Yahoo (repeat or use plus-addressing like `name+1@gmail.com`, `name+2@gmail.com` to reach the minimum of 15).
2. In each received message confirm: correct sender name in From and signature, no garbled characters, links intact, plain and HTML both display, not in spam.
3. In Gmail use *Show original* on a received message and confirm **SPF: PASS, DKIM: PASS, DMARC: PASS**.
4. Optionally score a message with mail-tester.com (aim for 9/10 or better).
5. Kill the server mid-job, restart, and confirm no recipient was emailed twice.

---

## 11. Acceptance criteria (definition of done)

- [ ] Submitting fewer than 15 valid unique addresses sends **nothing** and explains why.
- [ ] Submitting 15+ valid addresses sends **exactly one** individual email to each, with no recipient seeing another.
- [ ] Sender name changes via `.env` (and optional UI override) and appears correctly in both From and body, with no leftover `{{placeholders}}`.
- [ ] Non-ASCII names and subjects arrive uncorrupted.
- [ ] Emails are plain-text + HTML multipart, UTF-8, with no attachments, tracking, or link shorteners.
- [ ] A double-click, page refresh, second browser tab, or server restart **cannot** produce duplicate sends.
- [ ] Every recipient ends in a clear state (`sent`, `failed`, `uncertain`) with the SMTP response stored, visible in the UI and retrievable after a restart.
- [ ] Fatal errors (bad credentials, quota exceeded) abort the job cleanly instead of failing silently.
- [ ] The endpoint requires the access key; the credentials never appear in logs or the repo.
- [ ] README explains Gmail App Password setup, the run steps, deliverability advice, and the acceptance-test checklist.

---

## 12. Explicit non-goals (do not build)
- No AI/LLM text generation or rewriting.
- No per-recipient personalisation beyond the sender name (recipient names are unknown).
- No open/click tracking, no analytics pixels.
- No user accounts, database-backed admin panel, or campaign scheduling.
- No parallel or bulk-BCC sending.
- No polished frontend design.
