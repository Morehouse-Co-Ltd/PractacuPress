import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODERATION, readCustomization } from './customize';

function aiOf(value: unknown) {
  return readCustomization({ customization: { comments: { ai: value } } } as never).comments.ai;
}

describe('AI 审核设置归一化', () => {
  it('没有 AI 配置时使用默认值：关闭、跟随先审后发、只审评论', () => {
    const ai = readCustomization({ customization: {} } as never).comments.ai;
    expect(ai.enabled).toBe(false);
    expect(ai.auto).toBe(true);
    expect(ai.scopes).toEqual({ article: false, comment: true });
    expect(ai).not.toBe(DEFAULT_AI_MODERATION);
  });

  it('旧版 mode 配置迁移成只给建议，避免升级后自动删评', () => {
    const ai = aiOf({ enabled: true, mode: 'auto_hold', sensitivity: 'high', blocked_terms: [' 广告 '] });
    expect(ai.enabled).toBe(true);
    expect(ai.auto).toBe(false);
    expect(ai.scopes).toEqual({ article: false, comment: true });
    expect(ai.sensitivity).toBe('high');
    expect(ai.blocked_terms).toEqual(['广告']);
  });

  it('新配置可以分别打开文章与评论范围', () => {
    const ai = aiOf({ enabled: true, scopes: { article: true, comment: false }, auto: true });
    expect(ai.scopes).toEqual({ article: true, comment: false });
    expect(ai.auto).toBe(true);
  });

  it('范围只写一半时，缺失的评论范围按旧行为开启', () => {
    const ai = aiOf({ enabled: true, scopes: { article: true } });
    expect(ai.scopes).toEqual({ article: true, comment: true });
  });

  it('自定义风险词去重、截断并限制数量', () => {
    const terms = Array.from({ length: 60 }, (_, index) => ` 词${index} `);
    const ai = aiOf({ enabled: true, blocked_terms: terms });
    expect(ai.blocked_terms).toHaveLength(50);
    expect(ai.blocked_terms[0]).toBe('词0');
  });
});
