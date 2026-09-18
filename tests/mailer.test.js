import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { classifyError } = require('../src/services/mailer');

function makeErr(overrides) {
  return Object.assign(new Error('SMTP error'), overrides);
}

describe('mailer.classifyError', () => {
  // Transient cases
  it('421 → transient', () => {
    expect(classifyError(makeErr({ responseCode: 421 }))).toBe('transient');
  });
  it('450 → transient', () => {
    expect(classifyError(makeErr({ responseCode: 450 }))).toBe('transient');
  });
  it('451 → transient', () => {
    expect(classifyError(makeErr({ responseCode: 451 }))).toBe('transient');
  });
  it('452 → transient', () => {
    expect(classifyError(makeErr({ responseCode: 452 }))).toBe('transient');
  });
  it('ECONNECTION → transient', () => {
    expect(classifyError(makeErr({ code: 'ECONNECTION' }))).toBe('transient');
  });
  it('ETIMEDOUT on CONN command → transient', () => {
    expect(classifyError(makeErr({ code: 'ETIMEDOUT', command: 'CONN' }))).toBe('transient');
  });
  it('ECONNRESET on CONN command → transient', () => {
    expect(classifyError(makeErr({ code: 'ECONNRESET', command: 'CONN' }))).toBe('transient');
  });

  // Permanent cases
  it('550 → permanent', () => {
    expect(classifyError(makeErr({ responseCode: 550 }))).toBe('permanent');
  });
  it('551 → permanent', () => {
    expect(classifyError(makeErr({ responseCode: 551 }))).toBe('permanent');
  });
  it('553 → permanent', () => {
    expect(classifyError(makeErr({ responseCode: 553 }))).toBe('permanent');
  });
  it('554 → permanent', () => {
    expect(classifyError(makeErr({ responseCode: 554 }))).toBe('permanent');
  });
  it('5.1.1 in response → permanent', () => {
    expect(classifyError(makeErr({ response: '550 5.1.1 user unknown' }))).toBe('permanent');
  });

  // Fatal cases
  it('535 → fatal', () => {
    expect(classifyError(makeErr({ responseCode: 535 }))).toBe('fatal');
  });
  it('534 → fatal', () => {
    expect(classifyError(makeErr({ responseCode: 534 }))).toBe('fatal');
  });
  it('EAUTH → fatal', () => {
    expect(classifyError(makeErr({ code: 'EAUTH' }))).toBe('fatal');
  });
  it('5.4.5 quota exceeded → fatal', () => {
    expect(classifyError(makeErr({ response: '550 5.4.5 Daily user sending quota exceeded' }))).toBe('fatal');
  });

  // Uncertain cases
  it('ETIMEDOUT after DATA command → uncertain', () => {
    expect(classifyError(makeErr({ code: 'ETIMEDOUT', command: 'DATA' }))).toBe('uncertain');
  });
  it('ECONNRESET after DATA command → uncertain', () => {
    expect(classifyError(makeErr({ code: 'ECONNRESET', command: 'DATA' }))).toBe('uncertain');
  });
  it('unknown error → uncertain (safe default)', () => {
    expect(classifyError(makeErr({ code: 'SOMETHING_WEIRD' }))).toBe('uncertain');
  });
});

const { getAttachments, buildMessage } = require('../src/services/mailer');

describe('mailer.attachments', () => {
  it('detects IEEE_SSIT_Brochure.pdf in project root', () => {
    const atts = getAttachments();
    expect(atts.length).toBeGreaterThan(0);
    expect(atts[0].filename).toBe('IEEE_SSIT_Brochure.pdf');
    expect(atts[0].contentType).toBe('application/pdf');
  });

  it('buildMessage includes brochure attachment automatically', () => {
    const msg = buildMessage({
      to: 'sponsor@example.com',
      senderName: 'IEEE-SSIT',
      gmailUser: 'test@gmail.com',
      subject: 'Subject',
      text: 'Text',
      html: '<p>HTML</p>',
    });
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments.length).toBeGreaterThan(0);
    expect(msg.attachments[0].filename).toBe('IEEE_SSIT_Brochure.pdf');
  });

  it('buildMessage respects empty attachments array override', () => {
    const msg = buildMessage({
      to: 'sponsor@example.com',
      senderName: 'IEEE-SSIT',
      gmailUser: 'test@gmail.com',
      subject: 'Subject',
      text: 'Text',
      html: '<p>HTML</p>',
      attachments: [],
    });
    expect(msg.attachments).toBeUndefined();
  });
});

