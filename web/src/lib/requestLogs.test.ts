import { describe, expect, it } from 'vitest';
import { clampRequestLogLimit, logSourceFromSearch, REQUEST_LOG_LIMIT } from './requestLogs';

describe('请求日志 limit', () => {
  it('把超限值收在服务端契约内', () => {
    expect(clampRequestLogLimit(200)).toBe(REQUEST_LOG_LIMIT);
    expect(clampRequestLogLimit(100)).toBe(100);
    expect(clampRequestLogLimit(12.9)).toBe(12);
  });

  it('把零、负数和缺失值修正到合法范围', () => {
    expect(clampRequestLogLimit(0)).toBe(1);
    expect(clampRequestLogLimit(-5)).toBe(1);
    expect(clampRequestLogLimit(undefined)).toBe(REQUEST_LOG_LIMIT);
    expect(clampRequestLogLimit(Number.NaN)).toBe(REQUEST_LOG_LIMIT);
  });
});

describe('日志来源', () => {
  it('只把精确的 request 当作请求日志', () => {
    expect(logSourceFromSearch(new URLSearchParams('source=request'))).toBe('request');
    expect(logSourceFromSearch(new URLSearchParams('source=REQUEST'))).toBe('audit');
    expect(logSourceFromSearch(new URLSearchParams('source=audit'))).toBe('audit');
    expect(logSourceFromSearch(new URLSearchParams(''))).toBe('audit');
  });
});
