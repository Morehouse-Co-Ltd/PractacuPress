import { describe, expect, it } from 'vitest';
import { activityCsv, requestCsv } from './format';
import type { ActivityEntry, SystemLogEntry } from '../types';

/**
 * 日志导出 CSV 的转义测试。
 *
 * 两处导出（网站日志 / 请求日志）共用同一套 RFC 4180 规则：值一律加引号，内部引号翻倍。
 * 这里锁住列顺序与转义，避免以后有人「顺手」改成不引号输出，把含逗号的路径拆成两列。
 */
const AUDIT_HEAD = 'time,actor,action,target,detail';
const REQUEST_HEAD = 'time,method,path,status,duration_ms,request_id';

function auditEntry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'a1',
    at: '2026-02-01T10:00:00Z',
    actor: '张三',
    action: '发布内容',
    target: '第一篇',
    detail: '',
    ...over,
  };
}

function requestEntry(over: Partial<SystemLogEntry> = {}): SystemLogEntry {
  return {
    time: '2026-02-01T10:00:00Z',
    request_id: 'req_1',
    method: 'GET',
    path: '/api/v1/posts',
    status: 200,
    duration_ms: 12,
    site_id: 'site_1',
    user_id: 'user_1',
    ...over,
  };
}

describe('activityCsv', () => {
  it('空列表只输出表头', () => {
    expect(activityCsv([])).toBe(AUDIT_HEAD);
  });

  it('缺少详情时输出空单元格而不是 undefined', () => {
    const csv = activityCsv([auditEntry({ detail: undefined })]);
    expect(csv.split('\n')[1]).toBe('"2026-02-01T10:00:00Z","张三","发布内容","第一篇",""');
  });

  it('引号翻倍、逗号保留在同一个单元格里', () => {
    const csv = activityCsv([auditEntry({ actor: '他说"好", 然后走了' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"他说""好"", 然后走了"');
    // 逗号在引号内，所以表头列数仍然是 5 个字段；粗判一行里的分隔符没有把内容拆开。
    expect(row.startsWith('"2026-02-01T10:00:00Z",')).toBe(true);
  });

  it('行数与条目数一致', () => {
    const csv = activityCsv([auditEntry(), auditEntry({ id: 'a2' }), auditEntry({ id: 'a3' })]);
    expect(csv.split('\n')).toHaveLength(4);
  });
});

describe('requestCsv', () => {
  it('空列表只输出表头', () => {
    expect(requestCsv([])).toBe(REQUEST_HEAD);
  });

  it('按表格列顺序输出，状态码与耗时仍是文本单元格', () => {
    const csv = requestCsv([requestEntry({ status: 404, duration_ms: 7 })]);
    expect(csv.split('\n')[1]).toBe(
      '"2026-02-01T10:00:00Z","GET","/api/v1/posts","404","7","req_1"',
    );
  });

  it('路径里的引号与逗号不会撑破列', () => {
    const csv = requestCsv([requestEntry({ path: '/api/a"b,c', request_id: 'req_"9"' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"/api/a""b,c"');
    expect(row).toContain('"req_""9"""');
  });

  it('值里的换行被引号包住，不新增记录', () => {
    const csv = requestCsv([requestEntry({ path: '/api/v1/a\nb' })]);
    const lines = csv.split('\n');
    // 表头 + 1 条记录，但记录内部自带换行，所以按行切分多出一段。
    expect(csv.startsWith(REQUEST_HEAD + '\n')).toBe(true);
    expect(lines[0]).toBe(REQUEST_HEAD);
    expect(csv).toContain('"/api/v1/a\nb"');
  });

  it('行数与条目数一致', () => {
    const csv = requestCsv([
      requestEntry(),
      requestEntry({ request_id: 'req_2' }),
    ]);
    expect(csv.split('\n')).toHaveLength(3);
  });
});
