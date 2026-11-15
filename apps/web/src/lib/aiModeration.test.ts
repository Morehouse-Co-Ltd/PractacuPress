import { describe, expect, it } from 'vitest';
import type { AiModerationSettings } from '../types';
import {
  aiArticleDecision,
  aiAutoEnabled,
  aiCommentDecision,
  aiRiskReasonText,
  assessArticleRisk,
  assessCommentRisk,
  plainTextOf,
} from './aiModeration';

const BASE: AiModerationSettings = {
  enabled: true,
  scopes: { article: true, comment: true },
  auto: true,
  sensitivity: 'medium',
  blocked_terms: [],
};

describe('AI 评论风险评分', () => {
  it('正常讨论不加分', () => {
    const risk = assessCommentRisk('这段讨论很有帮助，谢谢作者。', BASE);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.reasons).toEqual([]);
  });

  it('命中多类垃圾特征时升为高风险并给出原因代码', () => {
    const risk = assessCommentRisk('加微信 xyz 一起刷单返利，联系我', BASE);
    expect(risk.score).toBeGreaterThanOrEqual(7);
    expect(risk.level).toBe('high');
    expect(risk.reasons).toContain('contact');
    expect(risk.reasons).toContain('promotion');
  });

  it('自定义风险词每次加 5 分，并转成小写保存', () => {
    const risk = assessCommentRisk('这里有竞品两个字', {
      ...BASE,
      blocked_terms: ['竞品'],
    });
    expect(risk.score).toBe(5);
    expect(risk.level).toBe('medium');
    expect(risk.reasons).toContain('custom:竞品');
  });

  it('超过 600 字的评论额外加一分', () => {
    const risk = assessCommentRisk('字'.repeat(601), BASE);
    expect(risk.score).toBe(1);
    expect(risk.reasons).toContain('length');
  });

  it('敏感度改变同一段正文的等级', () => {
    const text = '低息贷款推荐';
    expect(assessCommentRisk(text, { ...BASE, sensitivity: 'low' }).level).toBe('low');
    expect(assessCommentRisk(text, { ...BASE, sensitivity: 'high' }).level).toBe('high');
  });
});

describe('AI 文章风险评分', () => {
  it('只把标签外的文字算进评分，href 里的链接不算外链堆砌', () => {
    const risk = assessArticleRisk(
      {
        title: '排版笔记',
        summary: '关于正文与标题的关系。',
        rendered_html:
          '<p>正文没有任何推广。</p><a href="https://a.example">甲</a><a href="https://b.example">乙</a>',
      },
      BASE,
    );
    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
  });

  it('标题与摘要参与评分', () => {
    const risk = assessArticleRisk(
      { title: '加微信领取资料', summary: '限时优惠', rendered_html: '<p>正文</p>' },
      BASE,
    );
    expect(risk.score).toBeGreaterThanOrEqual(7);
    expect(risk.level).toBe('high');
  });

  it('文章不做篇幅异常判断', () => {
    const risk = assessArticleRisk({ title: '长文', rendered_html: `<p>${'字'.repeat(800)}</p>` }, BASE);
    expect(risk.reasons).not.toContain('length');
  });

  it('plainTextOf 去掉脚本、样式与 &nbsp;', () => {
    const text = plainTextOf('<script>alert(1)</script><style>p{}</style><p>甲&nbsp;乙</p>');
    expect(text).toBe('甲 乙');
  });

  it('原因代码翻成当前语言的中文说明', () => {
    expect(aiRiskReasonText('contact')).toBe('引导私下联系');
    expect(aiRiskReasonText('custom:竞品')).toBe('自定义词：竞品');
    expect(aiRiskReasonText('unknown')).toBe('unknown');
  });
});

describe('AI 自动处理决策', () => {
  it('总开关、范围、权限三者都开才允许自动处理', () => {
    expect(aiAutoEnabled(BASE, 'comment')).toBe(true);
    expect(aiAutoEnabled({ ...BASE, auto: false }, 'comment')).toBe(false);
    expect(aiAutoEnabled({ ...BASE, enabled: false }, 'comment')).toBe(false);
    expect(aiAutoEnabled({ ...BASE, scopes: { ...BASE.scopes, comment: false } }, 'comment')).toBe(
      false,
    );
  });

  it('先审后发：只自动通过低风险评论', () => {
    const low = { score: 0, level: 'low' as const, reasons: [] };
    const medium = { score: 4, level: 'medium' as const, reasons: [] };
    expect(aiCommentDecision(BASE, true, low)).toBe('approve');
    expect(aiCommentDecision(BASE, true, medium)).toBeNull();
  });

  it('未开启先审后发：只自动删除高风险评论', () => {
    const medium = { score: 4, level: 'medium' as const, reasons: [] };
    const high = { score: 8, level: 'high' as const, reasons: [] };
    expect(aiCommentDecision(BASE, false, high)).toBe('delete');
    expect(aiCommentDecision(BASE, false, medium)).toBeNull();
  });

  it('AI 权限关闭时评论与文章都不处理', () => {
    const low = { score: 0, level: 'low' as const, reasons: [] };
    const off = { ...BASE, auto: false };
    expect(aiCommentDecision(off, true, low)).toBeNull();
    expect(aiArticleDecision(off, low)).toBeNull();
  });

  it('文章只自动发布低风险稿件，且受文章范围约束', () => {
    const low = { score: 0, level: 'low' as const, reasons: [] };
    const medium = { score: 4, level: 'medium' as const, reasons: [] };
    expect(aiArticleDecision(BASE, low)).toBe('publish');
    expect(aiArticleDecision(BASE, medium)).toBeNull();
    expect(
      aiArticleDecision({ ...BASE, scopes: { article: false, comment: true } }, low),
    ).toBeNull();
  });
});
