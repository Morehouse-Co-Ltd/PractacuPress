import { describe, expect, it } from 'vitest';
import { databaseDraftError } from './setupValidation';

const VALID = {
  host: 'db.internal',
  port: '5432',
  name: 'practacu',
  user: 'practacu',
  password: 's3cret',
};

describe('databaseDraftError', () => {
  it('accepts a complete MySQL / PostgreSQL connection', () => {
    expect(databaseDraftError(VALID)).toBe('');
    expect(databaseDraftError({ ...VALID, port: '3306' })).toBe('');
    expect(databaseDraftError({ ...VALID, port: '65535' })).toBe('');
  });

  it('requires host, port, name, user and password', () => {
    expect(databaseDraftError({ ...VALID, host: '' })).toBe('请填写数据库主机。');
    expect(databaseDraftError({ ...VALID, port: '' })).toBe('请填写数据库端口。');
    expect(databaseDraftError({ ...VALID, name: '' })).toBe('请填写数据库名称。');
    expect(databaseDraftError({ ...VALID, user: '' })).toBe('请填写数据库用户。');
    expect(databaseDraftError({ ...VALID, password: '' })).toBe('请填写数据库密码。');
  });

  it('treats whitespace-only values as missing', () => {
    expect(databaseDraftError({ ...VALID, host: '   ' })).toBe('请填写数据库主机。');
    expect(databaseDraftError({ ...VALID, port: '\t' })).toBe('请填写数据库端口。');
    expect(databaseDraftError({ ...VALID, name: '  ' })).toBe('请填写数据库名称。');
    expect(databaseDraftError({ ...VALID, user: ' ' })).toBe('请填写数据库用户。');
    expect(databaseDraftError({ ...VALID, password: '   ' })).toBe('请填写数据库密码。');
  });

  it('rejects ports outside 1–65535 or non-integers', () => {
    for (const port of ['0', '65536', 'abc', '12.5', '-1', '1e3']) {
      expect(databaseDraftError({ ...VALID, port }), port).toBe(
        '数据库端口必须是 1 到 65535 之间的整数。',
      );
    }
    // 输入框两侧的空白不算错误：trim 之后再校验。
    expect(databaseDraftError({ ...VALID, port: ' 3306 ' })).toBe('');
  });
});
