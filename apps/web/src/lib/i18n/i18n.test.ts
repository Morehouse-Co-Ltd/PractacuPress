import { describe, expect, it } from 'vitest';
import { errorText, getLocale, setLocale, t } from './index';

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
});
