import type { AiModerationSettings } from '../types';
import { t } from './i18n';

/**
 * AI 审核辅助的本地启发式评分与自动处理决策。
 *
 * 不把文章或评论正文发送到外部服务：用常见的垃圾内容特征（引流词、外链数量、
 * 促销词、异常大写/标点）算一个风险分。真正的拦截仍由服务端的敏感词、先审后发与
 * IP 规则执行；这里决定的是审核队列里的标记，以及 AI 被授予自动权限时对低风险
 * 内容的放行、对高风险评论的删除。
 */

export type AiRiskLevel = 'low' | 'medium' | 'high';

export interface AiRisk {
  score: number;
  level: AiRiskLevel;
  /**
   * 风险原因代码，而不是成品文案：界面按当前语言翻译。
   * 自定义词命中时使用 `custom:<term>`，由 `aiRiskReasonText` 取回词条。
   */
  reasons: string[];
}

/** AI 看哪一类内容；与 `AiModerationSettings.scopes` 的键一一对应。 */
export type AiModerationScope = 'article' | 'comment';

/** AI 评分使用的规则：命中一次累加权重，权重越高越接近垃圾内容。 */
const AI_RISK_PATTERNS: { pattern: RegExp; weight: number; reason: string }[] = [
  { pattern: /加(微信|vx|v信|qq)|联系方式|扫码/i, weight: 4, reason: 'contact' },
  { pattern: /代购|刷单|返利|兼职|赚钱|贷款|博彩|赌博|色情|发票|办证/i, weight: 4, reason: 'promotion' },
  { pattern: /免费领取|限时优惠|点击链接|立即购买|全网最低/i, weight: 3, reason: 'sales' },
  { pattern: /telegram|whatsapp|t\.me|wa\.me/i, weight: 3, reason: 'offsite' },
  { pattern: /(https?:\/\/\S+){2,}/i, weight: 2, reason: 'links' },
  { pattern: /!{3,}|！{3,}|[A-Z]{10,}/, weight: 1, reason: 'emphasis' },
];

/** 风险原因代码 → 中文文案（也是 i18n 键）。 */
const AI_RISK_REASON_LABEL: Record<string, string> = {
  contact: '引导私下联系',
  promotion: '商业推广',
  sales: '促销话术',
  offsite: '站外引流',
  links: '多条外链',
  emphasis: '异常强调',
  length: '篇幅异常',
};

/** 评论正文过长会额外加一分；文章本来就是长文，不做这项判断。 */
const COMMENT_LENGTH_LIMIT = 600;

const SENSITIVITY_THRESHOLDS = {
  low: { medium: 6, high: 10 },
  medium: { medium: 4, high: 7 },
  high: { medium: 2, high: 4 },
} as const;

type RiskSettings = Pick<AiModerationSettings, 'sensitivity' | 'blocked_terms'>;

/** 去掉 HTML 标签，避免文章正文里的链接属性被误当成外链堆砌。 */
export function plainTextOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function assess(text: string, settings: RiskSettings, longForm: boolean): AiRisk {
  const trimmed = text.trim();
  let score = 0;
  const reasons: string[] = [];
  for (const rule of AI_RISK_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      score += rule.weight;
      reasons.push(rule.reason);
    }
  }
  const lower = trimmed.toLowerCase();
  for (const term of settings.blocked_terms) {
    if (term && lower.includes(term)) {
      score += 5;
      reasons.push(`custom:${term}`);
    }
  }
  if (!longForm && trimmed.length > COMMENT_LENGTH_LIMIT) {
    score += 1;
    reasons.push('length');
  }
  const thresholds = SENSITIVITY_THRESHOLDS[settings.sensitivity];
  const level: AiRiskLevel =
    score >= thresholds.high ? 'high' : score >= thresholds.medium ? 'medium' : 'low';
  return { score, level, reasons: Array.from(new Set(reasons)).slice(0, 4) };
}

/** 评论风险评分。保持与旧版注释一致：只做本地判断。 */
export function assessCommentRisk(body: string, settings: RiskSettings): AiRisk {
  return assess(body, settings, false);
}

/**
 * 文章风险评分。
 *
 * 标题、摘要与正文一起看；HTML 先转纯文本，避免标签属性里的 URL 被算成外链。
 * 文章不做「篇幅异常」判断，长文本身不是风险信号。
 */
export function assessArticleRisk(
  article: { title: string; summary?: string; rendered_html?: string; body?: string; source_body?: string },
  settings: RiskSettings,
): AiRisk {
  const body = article.rendered_html || article.body || article.source_body || '';
  const text = [article.title, article.summary ?? '', plainTextOf(body)].filter(Boolean).join('\n');
  return assess(text, settings, true);
}

/** 把风险原因代码翻成当前语言的说明；未知代码原样返回。 */
export function aiRiskReasonText(reason: string): string {
  if (reason.startsWith('custom:')) {
    return t('自定义词：{term}', { term: reason.slice('custom:'.length) });
  }
  const label = AI_RISK_REASON_LABEL[reason];
  return label ? t(label) : reason;
}

/** AI 是否被允许自动处理某一类内容（总开关 + 范围 + 权限三者都开）。 */
export function aiAutoEnabled(ai: AiModerationSettings, scope: AiModerationScope): boolean {
  return ai.enabled && ai.auto && ai.scopes?.[scope] === true;
}

/**
 * 评论的自动处理决策。
 *
 * - 开启「先审后发」：低风险评论自动通过（自动发送），中高风险留给人工；
 * - 未开启「先审后发」：高风险评论直接删除，其余保持公开。
 *
 * 返回 null 表示 AI 不处理，这条评论按原状态保留。
 */
export function aiCommentDecision(
  ai: AiModerationSettings,
  requireReview: boolean,
  risk: AiRisk,
): 'approve' | 'delete' | null {
  if (!aiAutoEnabled(ai, 'comment')) return null;
  if (requireReview) return risk.level === 'low' ? 'approve' : null;
  return risk.level === 'high' ? 'delete' : null;
}

/**
 * 文章的自动处理决策：只自动发布低风险稿件。
 *
 * 中高风险留给审核员，与「自动审核自动发送」的承诺一致：AI 不替人做退回决定。
 */
export function aiArticleDecision(ai: AiModerationSettings, risk: AiRisk): 'publish' | null {
  if (!aiAutoEnabled(ai, 'article')) return null;
  return risk.level === 'low' ? 'publish' : null;
}
