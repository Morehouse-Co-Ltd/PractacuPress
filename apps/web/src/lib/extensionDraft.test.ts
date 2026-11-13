import { describe, expect, it } from 'vitest';
import type { CustomExtension } from '../types';
import { EXTENSION_LIMITS } from './customize';
import { createExtension } from './extensions';
import {
  applyTemplateToDraft,
  buildExtensionForSave,
  emptyExtensionDraft,
  extensionCodeOverLimit,
  extensionDraftDirty,
  extensionDraftFrom,
  extensionHasContent,
  extensionPreviewPageKind,
  toggleDraftPage,
  toggleDraftPermission,
  toggleDraftSlot,
  validateExtensionDraft,
} from './extensionDraft';
import type { ExtensionTemplate } from './extensionTemplates';

/**
 * 工坊草稿逻辑的单测。
 *
 * 这里覆盖的正是「修改扩展不刷新页面」依赖的三件事：草稿与已保存清单的差异判断、
 * 保存时的收敛（截断 / trim / 兜底），以及勾选后的稳定顺序。UI 不再重复这些规则。
 */

function savedExtension(overrides: Partial<CustomExtension> = {}): CustomExtension {
  return {
    ...createExtension({
      id: 'ext_authorcard',
      name: '作者卡',
      version: '1.2.0',
      author: '站长',
      description: '文末作者名片',
      icon: '作',
      enabled: true,
      slots: ['article_bottom'],
      pages: ['article'],
      permissions: ['navigate'],
      html: '<p>hi</p>',
      css: 'p{color:red}',
      js: 'window.PP.setHeight(20)',
    }),
    ...overrides,
  };
}

describe('emptyExtensionDraft', () => {
  it('新建草稿默认不启用、名称留空、挂到文章底部', () => {
    const draft = emptyExtensionDraft('2026-01-01T00:00:00.000Z');
    expect(draft.id).toMatch(/^ext_[a-z0-9]{8}$/);
    expect(draft.name).toBe('');
    expect(draft.enabled).toBe(false);
    expect(draft.slots).toEqual(['article_bottom']);
    expect(draft.pages).toEqual(['all']);
    expect(draft.permissions).toEqual([]);
    expect(draft.html).toBe('');
    expect(draft.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(draft.updated_at).toBe(draft.created_at);
  });

  it('每次新建都是不同的 id', () => {
    expect(emptyExtensionDraft().id).not.toBe(emptyExtensionDraft().id);
  });
});

describe('extensionDraftFrom', () => {
  it('复制数组：改草稿不会改到站点设计里的清单', () => {
    const saved = savedExtension();
    const draft = extensionDraftFrom(saved);
    draft.slots.push('floating');
    draft.pages.push('home');
    draft.permissions.push('notify');

    expect(saved.slots).toEqual(['article_bottom']);
    expect(saved.pages).toEqual(['article']);
    expect(saved.permissions).toEqual(['navigate']);
  });
});

describe('extensionDraftDirty', () => {
  it('刚复制的草稿没有改动', () => {
    const saved = savedExtension();
    expect(extensionDraftDirty(extensionDraftFrom(saved), saved)).toBe(false);
  });

  it('忽略 updated_at：保存后不会立刻显示「有未保存修改」', () => {
    const saved = savedExtension();
    const draft = { ...extensionDraftFrom(saved), updated_at: '2030-01-01T00:00:00.000Z' };
    expect(extensionDraftDirty(draft, saved)).toBe(false);
  });

  it('名称首尾空格不算改动（保存时会 trim）', () => {
    const saved = savedExtension();
    const draft = { ...extensionDraftFrom(saved), name: '  作者卡  ' };
    expect(extensionDraftDirty(draft, saved)).toBe(false);
  });

  it('图标 undefined 与空串视为同一个值', () => {
    const saved = savedExtension({ icon: undefined });
    const draft = { ...extensionDraftFrom(saved), icon: '' };
    expect(extensionDraftDirty(draft, saved)).toBe(false);
  });

  it('开关、槽位、代码的改动都会变脏', () => {
    const saved = savedExtension();
    expect(extensionDraftDirty({ ...extensionDraftFrom(saved), enabled: false }, saved)).toBe(true);
    expect(
      extensionDraftDirty({ ...extensionDraftFrom(saved), slots: ['article_bottom', 'floating'] }, saved),
    ).toBe(true);
    expect(extensionDraftDirty({ ...extensionDraftFrom(saved), html: '<p>bye</p>' }, saved)).toBe(true);
  });

  it('槽位顺序不同也算改动：配置按顺序生效', () => {
    const saved = savedExtension({ slots: ['article_top', 'article_bottom'] });
    const draft = extensionDraftFrom(saved);
    draft.slots = ['article_bottom', 'article_top'];
    expect(extensionDraftDirty(draft, saved)).toBe(true);
  });

  it('没有已保存版本时永远视为有未保存内容', () => {
    expect(extensionDraftDirty(emptyExtensionDraft(), null)).toBe(true);
  });
});

describe('validateExtensionDraft', () => {
  it('名称必填，纯空格也不算', () => {
    expect(validateExtensionDraft({ ...emptyExtensionDraft(), name: '' })).not.toBe('');
    expect(validateExtensionDraft({ ...emptyExtensionDraft(), name: '   ' })).not.toBe('');
  });

  it('填了名称就通过', () => {
    expect(validateExtensionDraft({ ...emptyExtensionDraft(), name: '作者卡' })).toBe('');
  });
});

describe('勾选顺序', () => {
  it('槽位按常量顺序输出，重复勾选不会出现两份', () => {
    let draft = { ...emptyExtensionDraft(), slots: [] as CustomExtension['slots'] };
    draft = toggleDraftSlot(draft, 'floating');
    draft = toggleDraftSlot(draft, 'site_header');
    expect(draft.slots).toEqual(['site_header', 'floating']);

    // 取消再勾回来，顺序仍然是常量顺序。
    draft = toggleDraftSlot(draft, 'site_header');
    expect(draft.slots).toEqual(['floating']);
    draft = toggleDraftSlot(draft, 'site_header');
    expect(draft.slots).toEqual(['site_header', 'floating']);
  });

  it('页面与权限同样按常量顺序输出', () => {
    let draft = { ...emptyExtensionDraft(), pages: [] as CustomExtension['pages'], permissions: [] as CustomExtension['permissions'] };
    draft = toggleDraftPage(draft, 'search');
    draft = toggleDraftPage(draft, 'home');
    expect(draft.pages).toEqual(['home', 'search']);

    draft = toggleDraftPermission(draft, 'storage');
    draft = toggleDraftPermission(draft, 'notify');
    expect(draft.permissions).toEqual(['notify', 'storage']);
  });

  it('「全部页面」可以和其他页面同时存在（表示忽略其它选项）', () => {
    const draft = toggleDraftPage({ ...emptyExtensionDraft(), pages: ['all'] }, 'home');
    expect(draft.pages).toEqual(['all', 'home']);
  });

  it('勾选不改动传入的草稿对象', () => {
    const draft = { ...emptyExtensionDraft(), slots: [] as CustomExtension['slots'] };
    toggleDraftSlot(draft, 'floating');
    expect(draft.slots).toEqual([]);
  });
});

describe('buildExtensionForSave', () => {
  it('保留创建时间、刷新更新时间，并 trim 文本', () => {
    const saved = savedExtension({ created_at: '2020-01-01T00:00:00.000Z' });
    const draft = { ...extensionDraftFrom(saved), name: '  作者卡  ', version: ' 2.0.0 ' };
    const result = buildExtensionForSave(draft, saved);

    expect(result.created_at).toBe('2020-01-01T00:00:00.000Z');
    expect(result.updated_at).not.toBe('2020-01-01T00:00:00.000Z');
    expect(result.name).toBe('作者卡');
    expect(result.version).toBe('2.0.0');
    expect(result.enabled).toBe(true);
    expect(result.id).toBe(saved.id);
  });

  it('超长内容按上限截断，保存后的清单与草稿一致（不会一直显示未保存）', () => {
    const saved = savedExtension();
    const draft = {
      ...extensionDraftFrom(saved),
      html: 'x'.repeat(EXTENSION_LIMITS.html + 25),
    };
    const result = buildExtensionForSave(draft, saved);

    expect(result.html.length).toBe(EXTENSION_LIMITS.html);
    // 草稿里还留着超长内容，所以对截断后的清单仍然是「有未保存修改」：
    // 工坊保存后必须把草稿收敛成 result，才会回到干净状态。
    expect(extensionDraftDirty(draft, result)).toBe(true);
    expect(extensionDraftDirty(extensionDraftFrom(result), result)).toBe(false);
  });

  it('空槽位 / 空页面回退到默认值', () => {
    const saved = savedExtension();
    const draft = { ...extensionDraftFrom(saved), slots: [] as CustomExtension['slots'], pages: [] as CustomExtension['pages'] };
    const result = buildExtensionForSave(draft, saved);
    expect(result.slots).toEqual(['article_bottom']);
    expect(result.pages).toEqual(['all']);
  });

  it('非法枚举值被过滤', () => {
    const saved = savedExtension();
    const draft = {
      ...extensionDraftFrom(saved),
      permissions: ['navigate', 'root'] as unknown as CustomExtension['permissions'],
    };
    expect(buildExtensionForSave(draft, saved).permissions).toEqual(['navigate']);
  });
});

describe('applyTemplateToDraft', () => {
  const template: ExtensionTemplate = {
    id: 'demo',
    name: '示例扩展',
    description: '示例说明',
    icon: '示',
    slots: ['article_top'],
    pages: ['article'],
    permissions: ['notify'],
    html: '<div>demo</div>',
    css: 'div{color:blue}',
    js: 'window.PP.notify("hi")',
  };

  it('替换内容但保留同一份草稿的身份与启用状态', () => {
    const draft = { ...emptyExtensionDraft(), id: 'ext_keepme', enabled: true, created_at: '2020-01-01T00:00:00.000Z' };
    const next = applyTemplateToDraft(draft, template);

    expect(next.id).toBe('ext_keepme');
    expect(next.created_at).toBe('2020-01-01T00:00:00.000Z');
    expect(next.enabled).toBe(true);
    expect(next.name).toBe('示例扩展');
    expect(next.slots).toEqual(['article_top']);
    expect(next.pages).toEqual(['article']);
    expect(next.permissions).toEqual(['notify']);
    expect(next.html).toBe('<div>demo</div>');
    expect(next.css).toBe('div{color:blue}');
    expect(next.js).toBe('window.PP.notify("hi")');
  });
});

describe('预览辅助', () => {
  it('预览页类型优先文章页', () => {
    expect(extensionPreviewPageKind([])).toBe('article');
    expect(extensionPreviewPageKind(['all'])).toBe('article');
    expect(extensionPreviewPageKind(['article'])).toBe('article');
    expect(extensionPreviewPageKind(['home'])).toBe('home');
    expect(extensionPreviewPageKind(['list'])).toBe('list');
    expect(extensionPreviewPageKind(['search'])).toBe('search');
    expect(extensionPreviewPageKind(['home', 'search'])).toBe('home');
  });

  it('三项全空时没有内容可预览', () => {
    expect(extensionHasContent({ html: '', css: '  ', js: '\n' })).toBe(false);
    expect(extensionHasContent({ html: '', css: 'p{}', js: '' })).toBe(true);
  });

  it('恰好等于上限不算超限', () => {
    expect(extensionCodeOverLimit('css', EXTENSION_LIMITS.css)).toBe(false);
    expect(extensionCodeOverLimit('css', EXTENSION_LIMITS.css + 1)).toBe(true);
  });
});
