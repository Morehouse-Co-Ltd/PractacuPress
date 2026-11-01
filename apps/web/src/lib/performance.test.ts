import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERFORMANCE,
  applyMotionPreference,
  configurePerformance,
  currentPerformance,
  motionReduced,
  readPerformance,
} from './performance';

describe('readPerformance', () => {
  it('returns the safe defaults for a legacy config', () => {
    expect(readPerformance({})).toEqual(DEFAULT_PERFORMANCE);
  });

  it('clamps values and normalizes preconnect origins', () => {
    const performance = readPerformance({
      performance: {
        feed_limit: 0,
        archive_limit: 999,
        cache_ttl: 0,
        request_cache: true,
        lazy_media: false,
        disable_animations: true,
        preconnect: ['cdn.example.com', 'https://cdn.example.com/path', 'ftp://x.test'],
        gzip: false,
        static_cache_days: 0,
        keepalive_timeout: 0,
        client_max_body_size_mb: 0,
        proxy_read_timeout: 0,
        api_read_timeout: 0,
        api_idle_timeout: 0,
        db_max_open_conns: -2,
        db_max_idle_conns: 999,
        db_conn_max_lifetime: 999999,
      },
    });
    expect(performance.feed_limit).toBe(1);
    expect(performance.archive_limit).toBe(60);
    expect(performance.cache_ttl).toBe(1);
    expect(performance.lazy_media).toBe(false);
    expect(performance.disable_animations).toBe(true);
    expect(performance.preconnect).toEqual(['https://cdn.example.com']);
    expect(performance.gzip).toBe(false);
    expect(performance.static_cache_days).toBe(1);
    expect(performance.keepalive_timeout).toBe(1);
    expect(performance.client_max_body_size_mb).toBe(1);
    expect(performance.proxy_read_timeout).toBe(1);
    expect(performance.api_read_timeout).toBe(1);
    expect(performance.api_idle_timeout).toBe(1);
    expect(performance.db_max_open_conns).toBe(0);
    expect(performance.db_max_idle_conns).toBe(512);
    expect(performance.db_conn_max_lifetime).toBe(86400);
  });
});

describe('motion preference', () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion;
  });

  it('writes and reads the reduced-motion flag', () => {
    applyMotionPreference({ ...DEFAULT_PERFORMANCE, disable_animations: true });
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(motionReduced()).toBe(true);

    applyMotionPreference({ ...DEFAULT_PERFORMANCE, disable_animations: false });
    expect(document.documentElement.dataset.motion).toBe('full');
    expect(motionReduced()).toBe(false);
  });
});

describe('currentPerformance', () => {
  afterEach(() => {
    configurePerformance(DEFAULT_PERFORMANCE);
  });

  it('is updated by configurePerformance for the non-React request layer', () => {
    configurePerformance({ ...DEFAULT_PERFORMANCE, request_cache: true, cache_ttl: 42 });
    expect(currentPerformance().request_cache).toBe(true);
    expect(currentPerformance().cache_ttl).toBe(42);
  });
});
