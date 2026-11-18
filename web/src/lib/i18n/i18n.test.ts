import { describe, expect, it } from 'vitest';
import { errorText, getLocale, setLocale, t } from './index';
import { liveCatalog } from './live';

describe('i18n 内核', () => {
  it('中文下原样返回中文键', () => {
    setLocale('zh-CN');
    expect(t('保存')).toBe('保存');
  });

  it('英文下查表', () => {
    setLocale('en');
    expect(t('保存')).toBe('Save');
    setLocale('zh-CN');
  });

  it('缺少英文条目时回退中文，不返回空串', () => {
    setLocale('en');
    expect(t('这句还没有英文')).toBe('这句还没有英文');
    setLocale('zh-CN');
  });

  it('插值在两种语言下都生效', () => {
    setLocale('zh-CN');
    expect(t('共 {count} 篇文章', { count: 3 })).toBe('共 3 篇文章');
    setLocale('en');
    expect(t('共 {count} 篇文章', { count: 3 })).toBe('3 articles');
    setLocale('zh-CN');
  });

  it('英文复数按 count 选形式', () => {
    setLocale('en');
    expect(t('{count} 条评论', { count: 1 })).toBe('1 comment');
    expect(t('{count} 条评论', { count: 5 })).toBe('5 comments');
    setLocale('zh-CN');
    expect(t('{count} 条评论', { count: 5 })).toBe('5 条评论');
  });

  it('非法语言回退中文', () => {
    setLocale('fr-FR');
    expect(getLocale()).toBe('zh-CN');
  });

  it('英文下按错误码翻译后端错误', () => {
    setLocale('en');
    expect(errorText({ problem: { code: 'unauthenticated', message: '请先登录' } })).toBe(
      'Your session has expired. Please sign in again.',
    );
    setLocale('zh-CN');
    expect(errorText({ problem: { code: 'unauthenticated', message: '请先登录' } })).toBe('请先登录');
  });

  it('未收录的错误码回退服务端原文', () => {
    setLocale('en');
    expect(errorText({ problem: { code: 'brand_new_code', message: '新错误' } })).toBe('新错误');
    setLocale('zh-CN');
  });

  it('liveCatalog 让模块级目录跟随语言切换', () => {
    // 模拟模块级常量：构建时是中文，读取时再翻译。
    const defs = liveCatalog([
      { id: 'a', name: t('保存'), note: 'save-note' },
      { id: 'b', name: t('取消'), note: 'cancel-note' },
    ]);
    setLocale('zh-CN');
    expect(defs[0].name).toBe('保存');
    setLocale('en');
    expect(defs[0].name).toBe('Save');
    expect(defs[1].name).toBe('Cancel');
    // 不含中文的值原样保留，不会被当成键去查表。
    expect(defs[0].note).toBe('save-note');
    setLocale('zh-CN');
  });

  it('liveCatalog 跳过持久化数据（skip）', () => {
    const defs = liveCatalog(
      [{ id: 'a', name: t('保存'), defaults: { title: t('保存') } }],
      { skip: ['defaults'] },
    );
    setLocale('en');
    expect(defs[0].name).toBe('Save');
    expect(defs[0].defaults.title).toBe('保存');
    setLocale('zh-CN');
  });
});
