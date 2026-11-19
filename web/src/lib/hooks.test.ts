import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  draftIsStale,
  editorDraftKey,
  parseEditorDraft,
  readEditorDraft,
  removeEditorDraft,
  writeEditorDraft,
  type EditorDraftPayload,
  type EditorDraftRecord,
} from './hooks';

const payload: EditorDraftPayload = {
  title: '一份草稿',
  slug: 'draft',
  summary: '摘要',
  source_format: 'markdown',
  source_body: '正文',
  category_id: '',
  tags: ['标签'],
};

function record(overrides: Partial<EditorDraftRecord> = {}): EditorDraftRecord {
  return {
    version: 1,
    key: 'pp.editor.draft.v1:site:article:c:cnt_1',
    kind: 'article',
    content_id: 'cnt_1',
    site_id: 'site',
    saved_at: 1_700_000_000_000,
    base_revision: 3,
    server_updated_at: '2026-11-01T10:00:00Z',
    payload,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('editorDraftKey', () => {
  it('按站点、内容类型与内容 ID 隔离', () => {
    const key = editorDraftKey({ siteId: 'site-a', kind: 'article', contentId: 'cnt_1' });
    expect(key).toBe('pp.editor.draft.v1:site-a:article:c:cnt_1');
    expect(editorDraftKey({ siteId: 'site-b', kind: 'article', contentId: 'cnt_1' })).not.toBe(key);
    expect(editorDraftKey({ siteId: 'site-a', kind: 'post', contentId: 'cnt_1' })).not.toBe(key);
    expect(editorDraftKey({ siteId: 'site-a', kind: 'article', contentId: 'cnt_2' })).not.toBe(key);
  });

  it('新建内容使用固定的临时草稿位', () => {
    expect(editorDraftKey({ siteId: 'site-a', kind: 'article', contentId: null })).toBe(
      'pp.editor.draft.v1:site-a:article:new',
    );
  });

  it('站点或类型缺失时也能生成稳定键', () => {
    expect(editorDraftKey({ kind: 'article' })).toBe('pp.editor.draft.v1:local:article:new');
  });
});

describe('parseEditorDraft', () => {
  it('拒绝损坏的 JSON 与旧版本结构', () => {
    expect(parseEditorDraft('{oops')).toBeNull();
    expect(parseEditorDraft('null')).toBeNull();
    expect(parseEditorDraft(JSON.stringify({ ...record(), version: 0 }))).toBeNull();
    expect(parseEditorDraft(JSON.stringify({ ...record(), saved_at: 'yesterday' }))).toBeNull();
  });

  it('拒绝缺少字段的载荷', () => {
    expect(parseEditorDraft(JSON.stringify({ ...record(), payload: null }))).toBeNull();
    expect(
      parseEditorDraft(
        JSON.stringify({ ...record(), payload: { ...payload, source_body: 42 } }),
      ),
    ).toBeNull();
    expect(
      parseEditorDraft(JSON.stringify({ ...record(), payload: { ...payload, tags: 'not-array' } })),
    ).toBeNull();
  });

  it('兼容旧记录里缺省的元数据', () => {
    const parsed = parseEditorDraft(
      JSON.stringify({
        version: 1,
        key: 'k',
        saved_at: 1,
        payload,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.base_revision).toBeNull();
    expect(parsed?.content_id).toBeNull();
    expect(parsed?.kind).toBe('');
  });
});

describe('本地草稿读写', () => {
  it('写入后能原样读回', () => {
    const value = record();
    expect(writeEditorDraft(value)).toBe(true);
    const stored = readEditorDraft(value.key);
    expect(stored?.payload).toEqual(payload);
    expect(stored?.base_revision).toBe(3);
  });

  it('删除后读不到', () => {
    const value = record();
    writeEditorDraft(value);
    removeEditorDraft(value.key);
    expect(readEditorDraft(value.key)).toBeNull();
  });

  it('存储写入失败时返回 false，不抛异常', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(writeEditorDraft(record())).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('draftIsStale', () => {
  it('版本号一致时不算冲突', () => {
    expect(draftIsStale(record(), { revision: 3, updatedAt: '2026-11-01T10:00:00Z' })).toBe(false);
  });

  it('服务端版本号变了就算冲突', () => {
    expect(draftIsStale(record(), { revision: 4, updatedAt: '2026-11-01T10:00:00Z' })).toBe(true);
  });

  it('没有版本号时退回比较 updated_at', () => {
    const old = record({ base_revision: null });
    expect(draftIsStale(old, { updatedAt: '2026-11-01T10:00:00Z' })).toBe(false);
    expect(draftIsStale(old, { updatedAt: '2026-11-02T10:00:00Z' })).toBe(true);
  });

  it('没有服务端信息时不算冲突', () => {
    expect(draftIsStale(record(), null)).toBe(false);
  });
});
