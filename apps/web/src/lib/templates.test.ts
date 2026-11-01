import { describe, expect, it } from 'vitest';
import { PAGE_TEMPLATES, templateById } from './templates';
import { BLOCK_TYPES } from './blocks';

describe('页面模板改为纯页面编排', () => {
  it('每个模板都只生成区块编排，不再生成 Markdown 正文', () => {
    for (const template of PAGE_TEMPLATES) {
      const built = template.build();
      expect(built).not.toHaveProperty('body');
      expect(built.layout && Array.isArray(built.layout.blocks)).toBe(true);
      expect(built.template).toBe(template.id);
    }
  });

  it('模板区块类型都在已注册的区块表里', () => {
    for (const template of PAGE_TEMPLATES) {
      for (const block of template.build().layout.blocks) {
        expect(BLOCK_TYPES.has(block.type)).toBe(true);
      }
    }
  });

  it('除空白页外，模板都带有可编辑内容', () => {
    for (const template of PAGE_TEMPLATES) {
      if (template.id === 'blank') {
        expect(template.build().layout.blocks).toHaveLength(0);
        continue;
      }
      expect(template.build().layout.blocks.length).toBeGreaterThan(0);
    }
  });

  it('templateById 能按名称找回模板', () => {
    expect(templateById('about')?.name).toBe('关于页');
    expect(templateById('missing')).toBeUndefined();
  });
});
