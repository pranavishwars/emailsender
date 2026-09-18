import { describe, it, expect } from 'vitest';
// credentialValidator uses require — import it via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { validate } = require('../src/services/credentialValidator');

describe('credentialValidator', () => {
  it('passes valid credentials', () => {
    const result = validate({
      gmailUser: 'test@gmail.com',
      appPassword: 'abcdefghijklmnop', // 16 chars
    });
    expect(result.gmailUser).toBe('test@gmail.com');
    expect(result.appPassword).toBe('abcdefghijklmnop');
  });

  it('strips spaces from appPassword (Google format)', () => {
    const result = validate({
      gmailUser: 'test@gmail.com',
      appPassword: 'abcd efgh ijkl mnop', // 16 chars + 3 spaces
    });
    expect(result.appPassword).toBe('abcdefghijklmnop');
  });

  it('lowercases gmailUser', () => {
    const result = validate({
      gmailUser: 'TEST@GMAIL.COM',
      appPassword: 'abcdefghijklmnop',
    });
    expect(result.gmailUser).toBe('test@gmail.com');
  });

  it('rejects appPassword with 15 chars after stripping', () => {
    expect(() => validate({
      gmailUser: 'test@gmail.com',
      appPassword: 'abcdefghijklmno', // 15 chars
    })).toThrow(/16 characters/);
  });

  it('rejects appPassword with 17 chars after stripping', () => {
    expect(() => validate({
      gmailUser: 'test@gmail.com',
      appPassword: 'abcdefghijklmnopq', // 17 chars
    })).toThrow(/16 characters/);
  });

  it('rejects appPassword with non-alphanumeric characters', () => {
    expect(() => validate({
      gmailUser: 'test@gmail.com',
      appPassword: 'abcdefghijklmno!', // has !
    })).toThrow(/alphanumeric/);
  });

  it('rejects invalid gmailUser', () => {
    expect(() => validate({
      gmailUser: 'not-an-email',
      appPassword: 'abcdefghijklmnop',
    })).toThrow(/valid email/);
  });

  it('rejects missing appPassword', () => {
    expect(() => validate({
      gmailUser: 'test@gmail.com',
      appPassword: '',
    })).toThrow(/required/);
  });
});
