import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// emailParser requires DNS — we mock it
const dns = require('dns').promises;
import { vi } from 'vitest';

// Mock dns to return OK by default
vi.spyOn(dns, 'resolveMx').mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]);

const { parse, checkCounts } = require('../src/services/emailParser');

describe('emailParser.parse', () => {
  it('handles newline-separated emails', async () => {
    const { valid } = await parse('a@example.com\nb@example.com');
    expect(valid).toContain('a@example.com');
    expect(valid).toContain('b@example.com');
  });

  it('handles comma-separated emails', async () => {
    const { valid } = await parse('a@example.com, b@example.com');
    expect(valid.length).toBe(2);
  });

  it('handles semicolon, tab, and mixed separators', async () => {
    const { valid } = await parse('a@x.com;b@x.com\tc@x.com');
    expect(valid.length).toBe(3);
  });

  it('deduplicates case-insensitively', async () => {
    const { valid, duplicatesInInput } = await parse('A@X.COM\na@x.com\nA@X.COM');
    expect(valid.length).toBe(1);
    expect(duplicatesInInput.length).toBeGreaterThan(0);
  });

  it('extracts address from "Name <addr@x.com>" format', async () => {
    const { valid } = await parse('John Smith <john@company.com>');
    expect(valid).toContain('john@company.com');
  });

  it('extracts address from "Name" <addr@x.com> format', async () => {
    const { valid } = await parse('"Jane Doe" <jane@company.com>');
    expect(valid).toContain('jane@company.com');
  });

  it('strips trailing punctuation', async () => {
    const { valid } = await parse('a@example.com,');
    expect(valid).toContain('a@example.com');
  });

  it('lowercases addresses', async () => {
    const { valid } = await parse('TEST@EXAMPLE.COM');
    expect(valid).toContain('test@example.com');
  });

  it('rejects CR/LF header injection attempt', async () => {
    const { invalid } = await parse('a@b.com\r\nBcc: x@y.com');
    // The injected part should be rejected or the combined string rejected
    const rejectedTokens = invalid.map(i => i.token);
    expect(rejectedTokens.some(t => t.includes('Bcc') || t.includes('\r\n'))).toBe(true);
  });

  it('rejects invalid email syntax', async () => {
    const { invalid } = await parse('notanemail hello @broken');
    expect(invalid.length).toBeGreaterThan(0);
  });

  it('drops empty tokens', async () => {
    const { valid } = await parse('  ,  ;;  ');
    expect(valid.length).toBe(0);
  });

  it('flags domain with no MX records as invalid', async () => {
    dns.resolveMx.mockRejectedValueOnce(Object.assign(new Error('no records'), { code: 'ENOTFOUND' }));
    const { invalid } = await parse('test@nomx-domain-xyz.com');
    expect(invalid.some(i => i.reason.includes('no MX'))).toBe(true);
  });

  it('treats DNS timeout as unknown (attempts anyway)', async () => {
    dns.resolveMx.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const { valid } = await parse('test@timeout-domain.com');
    expect(valid).toContain('test@timeout-domain.com');
  });
});

describe('emailParser.checkCounts', () => {
  it('accepts a single valid address (no minimum)', () => {
    const emails = ['user@example.com'];
    const err = checkCounts(emails, { max: 100 });
    expect(err).toBeNull();
  });

  it('rejects zero valid addresses', () => {
    const err = checkCounts([], { max: 100 });
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/no valid email/i);
  });

  it('rejects above max cap', () => {
    const emails = Array.from({ length: 101 }, (_, i) => `user${i}@example.com`);
    const err = checkCounts(emails, { max: 100 });
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/exceed.*maximum/i);
  });
});
