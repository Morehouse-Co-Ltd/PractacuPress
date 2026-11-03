import { describe, expect, it } from 'vitest';
import { ApiError, fallbackProblem } from './api';
import {
  DEFAULT_DOMAINS,
  boundDomains,
  defaultCorsOrigins,
  domainAllowed,
  domainEntryError,
  domainVerificationErrorReason,
  hostMatches,
  isDomainPendingVerification,
  isPublicIp,
  normalizeDomain,
  normalizeOrigin,
  readDomains,
} from './domains';

const enabled = {
  ...DEFAULT_DOMAINS,
  enabled: true,
  primary: 'example.com',
  aliases: ['www.example.com', '*.blog.example.com'],
};

describe('normalizeDomain', () => {
  it('normalizes protocols, ports, paths and case', () => {
    expect(normalizeDomain('https://Example.COM:443/path?q=1')).toBe('example.com');
    expect(normalizeDomain('  example.com. ')).toBe('example.com');
    expect(normalizeDomain('*.Example.com')).toBe('*.example.com');
  });

  it('rejects empty and malformed hosts', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('not a domain')).toBe('');
    expect(normalizeDomain('https://')).toBe('');
    expect(normalizeDomain('*.com')).toBe('');
  });

  it('converts IDN to punycode', () => {
    expect(normalizeDomain('例子.测试')).toMatch(/^xn--/);
  });
});

describe('host matching', () => {
  it('supports exact and wildcard rules without matching the apex', () => {
    expect(hostMatches('a.blog.example.com', '*.blog.example.com')).toBe(true);
    expect(hostMatches('blog.example.com', '*.blog.example.com')).toBe(false);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
  });

  it('allows the www form when the bare domain is bound', () => {
    const settings = {
      ...enabled,
      aliases: ['*.blog.example.com'],
      allow_www: true,
      allow_localhost: false,
      allow_ip: false,
    };
    expect(domainAllowed('www.example.com', settings)).toBe(true);
    expect(domainAllowed('www.example.com', { ...settings, allow_www: false })).toBe(false);
    expect(domainAllowed('www.blog.example.com', settings)).toBe(true);
  });

  it('without a domain allows only public IPs (localhost stays for local admin)', () => {
    const settings = { ...DEFAULT_DOMAINS, enabled: true, primary: '' };
    expect(domainAllowed('8.8.8.8', settings)).toBe(true);
    expect(domainAllowed('2001:4860:4860::8888', settings)).toBe(true);
    expect(domainAllowed('example.com', settings)).toBe(false);
    expect(domainAllowed('10.0.0.1', settings)).toBe(false);
    expect(domainAllowed('192.168.1.10', settings)).toBe(false);
    expect(domainAllowed('localhost', settings)).toBe(true);
    expect(domainAllowed('localhost', { ...settings, allow_localhost: false })).toBe(false);
  });

  it('classifies public and private IPs', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('10.1.2.3')).toBe(false);
    expect(isPublicIp('172.20.0.1')).toBe(false);
    expect(isPublicIp('192.168.1.1')).toBe(false);
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('100.64.0.1')).toBe(false);
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('fe80::1')).toBe(false);
    expect(isPublicIp('fd00::1')).toBe(false);
    expect(isPublicIp('2001:db8::1')).toBe(true);
    expect(isPublicIp('example.com')).toBe(false);
  });

  it('honours localhost and IP switches', () => {
    const settings = { ...enabled, allow_localhost: false, allow_ip: false };
    expect(domainAllowed('localhost', settings)).toBe(false);
    expect(domainAllowed('127.0.0.1', settings)).toBe(false);
    expect(domainAllowed('localhost', { ...settings, allow_localhost: true })).toBe(true);
    expect(domainAllowed('10.0.0.1', { ...settings, allow_ip: true })).toBe(true);
  });
});

describe('readDomains', () => {
  it('deduplicates aliases and normalizes origins', () => {
    const settings = readDomains({
      domains: {
        ...enabled,
        aliases: ['https://www.example.com', 'www.example.com', 'bad host', '*.Blog.Example.com'],
        cors_origins: ['https://example.com/path', 'ftp://bad'],
        trusted_proxies: ['127.0.0.1', ' 127.0.0.1 '],
      },
    });
    expect(settings.aliases).toEqual(['www.example.com', '*.blog.example.com']);
    expect(settings.cors_origins).toEqual(['https://example.com']);
    expect(settings.trusted_proxies).toEqual(['127.0.0.1']);
  });

  it('builds bound domains and default CORS origins', () => {
    const settings = { ...enabled, cors_origins: ['https://extra.example.net'] };
    expect(boundDomains(settings)).toEqual([
      'example.com',
      'www.example.com',
      '*.blog.example.com',
    ]);
    expect(defaultCorsOrigins(settings)).toEqual([
      'https://extra.example.net',
      'https://example.com',
      'https://www.example.com',
    ]);
  });

  it('validates each alias entry for the UI', () => {
    expect(domainEntryError('example.com')).toBe('');
    expect(domainEntryError('www.example.com')).toBe('');
    expect(domainEntryError('has space.com')).toContain('空格');
    expect(domainEntryError('not a domain')).not.toBe('');
  });
});

describe('normalizeOrigin', () => {
  it('accepts bare hosts and rejects non-http schemes', () => {
    expect(normalizeOrigin('cdn.example.com')).toBe('https://cdn.example.com');
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeOrigin('ftp://example.com')).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * V-12 主域名归属验证
 * ------------------------------------------------------------------ */

describe('isDomainPendingVerification', () => {
  const check = {
    domain: 'press.example.com',
    verified: false,
    verification_token: 'pp_verify_abc',
    record_name: '_practacu-verify.press.example.com',
    record_type: 'TXT',
  };

  it('is pending when the saved domain matches and is not verified', () => {
    expect(isDomainPendingVerification(check, 'press.example.com')).toBe(true);
    expect(isDomainPendingVerification(check, '  PRESS.example.com ')).toBe(true);
    expect(isDomainPendingVerification(check, 'press.example.com:443')).toBe(true);
    expect(isDomainPendingVerification({ ...check, verified: true }, 'press.example.com')).toBe(false);
  });

  it('is not pending for an empty, different or missing domain', () => {
    expect(isDomainPendingVerification(check, '')).toBe(false);
    expect(isDomainPendingVerification(check, 'other.example.com')).toBe(false);
    expect(isDomainPendingVerification(null, 'press.example.com')).toBe(false);
    expect(isDomainPendingVerification(undefined, 'press.example.com')).toBe(false);
  });
});

describe('domainVerificationErrorReason', () => {
  it('maps server reasons to readable categories', () => {
    expect(
      domainVerificationErrorReason(
        new ApiError({ ...fallbackProblem(400), details: { reason: 'domain_verification_failed' } }),
      ),
    ).toBe('dns_not_found');
    expect(
      domainVerificationErrorReason(
        new ApiError({ ...fallbackProblem(400), details: { reason: 'validation_failed' } }),
      ),
    ).toBe('validation_failed');
    expect(
      domainVerificationErrorReason(
        new ApiError({ ...fallbackProblem(409), details: { reason: 'revision_conflict' } }),
      ),
    ).toBe('unknown');
    expect(domainVerificationErrorReason(new Error('boom'))).toBe('unknown');
  });
});
