import { Link } from 'react-router-dom';
import type { AiModerationSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { usePermissions } from '../../lib/usePermissions';
import { PUBLISH_LABEL } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Callout,
  Field,
  Input,
  Select,
  Textarea,
  Toggle,
} from '../../components/ui';
import { useToast } from '../../lib/toast';
import { ContentSafetyPanel } from './ContentSafetyPanel';

type ScopeKey = 'article' | 'comment';

/**
 * 审核设置。
 *
 * 「评论审核」只处理队列，这里放所有会改变策略的开关：评论开关与先审后发、
 * 文章发布模式概览、AI 审核范围与自动权限、内容安全规则。拆开之后，审核员在
 * 队列页不会误触策略开关，站长也能在一个地方看清「AI 到底会怎么处理」。
 */
export function ModerationSettingsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const { me, site, applySite } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { customization, update } = useCustomization();
  const { can, personal } = usePermissions();
  const comments = customization.comments;
  const ai = comments.ai;

  const canManageSite = can('manage_site');
  const canModerateContent = can('moderate_content');
  const canModerateComment = can('moderate_comment');
  const canEditPolicy = demo || canManageSite;

  // 真实后端的评论策略在站点设置里，必须交给服务端执行；演示模式仍用本地配置。
  const commentsEnabled = demo ? comments.enabled : (site?.comments_enabled ?? true);
  const commentsRequireReview = demo ? comments.require_review : (site?.comments_require_review ?? false);
  const publishMode = site?.publish_mode ?? 'review';

  useTitle(embedded ? t('信息安全') : t('审核设置'));

  const saveComments = (patch: Partial<typeof comments>) => {
    update({ comments: { ...comments, ...patch } });
  };

  const saveAi = (patch: Partial<AiModerationSettings>) => {
    saveComments({ ai: { ...ai, ...patch } });
  };

  const setScope = (scope: ScopeKey, next: boolean) => {
    saveAi({ scopes: { ...ai.scopes, [scope]: next } });
  };

  /** 首次启用时至少选一个范围，避免打开总开关却什么都不审核。 */
  const toggleAi = (enabled: boolean) => {
    const scopes =
      enabled && !ai.scopes.article && !ai.scopes.comment
        ? { ...ai.scopes, comment: true }
        : ai.scopes;
    saveComments({ ai: { ...ai, enabled, scopes } });
  };

  // 真实后端：评论开关是站点级字段，保存后由 API 强制执行（关闭时 POST /comments 返回 403）。
  const saveServerPolicy = async (patch: {
    comments_enabled?: boolean;
    comments_require_review?: boolean;
  }) => {
    if (!me || !canManageSite) return;
    try {
      await backend.updateSite(me.site_id, patch);
      if (site) applySite({ ...site, ...patch });
      toast.push('ok', t('评论策略已保存'));
    } catch (err) {
      toast.push('error', t('保存失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const articleAvailable = !personal && canModerateContent;
  const scopeCount = (ai.scopes.comment ? 1 : 0) + (ai.scopes.article && articleAvailable ? 1 : 0);

  const autoDescription = (() => {
    if (!ai.enabled) return t('先启用 AI 审核。');
    const parts: string[] = [];
    if (ai.scopes.comment) {
      parts.push(
        commentsRequireReview
          ? t('低风险待审评论自动通过并公开，中高风险留给人工。')
          : t('高风险公开评论由 AI 直接删除，其余保持不变。'),
      );
    }
    if (ai.scopes.article && articleAvailable) {
      parts.push(t('低风险待审稿件自动发布，中高风险留给人工。'));
    }
    return parts.length ? parts.join(' ') : t('先选择 AI 审核范围。');
  })();

  const commentBehavior =
    !ai.enabled || !ai.scopes.comment
      ? t('不参与')
      : ai.auto
        ? commentsRequireReview
          ? t('自动通过低风险待审评论')
          : t('自动删除高风险公开评论')
        : t('只打风险分');

  const articleBehavior = personal
    ? t('个人博客没有待审稿件')
    : !ai.enabled || !ai.scopes.article
      ? t('不参与')
      : ai.auto
        ? t('自动发布低风险待审稿件')
        : t('只打风险分');

  return (
    <>
      {embedded ? null : (
        <div className="admin-page-head">
          <div>
            <h1>{t('审核设置')}</h1>
            <p>
              {t('评论策略、文章发布策略概览、AI 审核权限与内容安全规则集中在这里。')}
            </p>
          </div>
        </div>
      )}

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('评论设置')}</h3>
              <p>{t(demo ? '立即生效，保存在本地安装配置。' : '立即生效，由服务端强制执行。')}</p>
            </div>
            <Badge tone={commentsEnabled ? 'ok' : 'muted'}>
              {commentsEnabled ? t('已开启') : t('已关闭')}
            </Badge>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              <Toggle
                checked={commentsEnabled}
                disabled={!canEditPolicy}
                onChange={(next) =>
                  demo
                    ? saveComments({ enabled: next })
                    : void saveServerPolicy({ comments_enabled: next })
                }
                label={t('允许评论')}
                description={t('关闭后文章与帖子底部不再显示评论框，已有评论仍然保留。')}
              />
              <Toggle
                checked={commentsRequireReview}
                disabled={!canEditPolicy}
                onChange={(next) =>
                  demo
                    ? saveComments({ require_review: next })
                    : void saveServerPolicy({ comments_require_review: next })
                }
                label={t('先审后发')}
                description={t('新评论进入待审核队列，通过后才会公开显示。')}
              />
              <Field
                label={t('评论须知')}
                htmlFor="comment-notice"
                aside={`${comments.notice.length}/400`}
                hint={t('显示在评论框上方，留空则不显示。')}
              >
                <Textarea
                  id="comment-notice"
                  value={comments.notice}
                  maxLength={400}
                  style={{ minHeight: 72 }}
                  placeholder={t('例如：请就事论事，尊重其他读者；广告与人身攻击会被删除。')}
                  onChange={(event) => saveComments({ notice: event.target.value })}
                />
              </Field>
              {!canEditPolicy ? (
                <Callout tone="warn" icon="lock" title={t('只有站点管理员可以修改评论策略')}>
                  {t('当前值仍然生效；需要调整时请让站点管理员操作。')}
                </Callout>
              ) : !demo ? (
                <Callout tone="info" icon="shield" title={t('评论策略由服务端执行')}>
                  {t('关闭评论后，即使直接调用接口也会被拒绝；先审后发时新评论进入待审核队列。')}
                </Callout>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('文章审核')}</h3>
                <p>{t('成员投稿是否需要另一位编辑审核；AI 只处理进入待审队列的稿件。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="row gap-8 mb-10" style={{ flexWrap: 'wrap' }}>
                <Badge tone={publishMode === 'open' ? 'muted' : 'warn'}>
                  {PUBLISH_LABEL[publishMode]}
                </Badge>
              </div>
              <p className="small muted" style={{ lineHeight: 1.75 }}>
                {publishMode === 'open'
                  ? t('成员可以从草稿直接发布，不再进入审核队列。')
                  : publishMode === 'review'
                    ? t('所有成员（包括编辑）的稿件都需要另一位编辑审核。')
                    : t('普通成员需要审核；编辑与管理员可以直接发布。')}
              </p>
              {personal ? (
                <p className="tiny faint mt-12" style={{ lineHeight: 1.75 }}>
                  {t('个人博客固定为公开阅读与直接发布：没有其他成员，也没有需要审核的稿件。')}
                </p>
              ) : canManageSite ? (
                <Link to="/admin/settings" className="text-link tiny mt-12" style={{ display: 'inline-block' }}>
                  {t('在站点设置中修改发布模式')}
                </Link>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('审核规则')}</h3>
                <p>{t('评论状态与内容状态是两条独立的流水线。')}</p>
              </div>
            </div>
            <div className="panel-body" style={{ paddingTop: 4 }}>
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('已发布')}</span>
                  <span className="mini-value">{t('所有人可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('待审核')}</span>
                  <span className="mini-value">{t('作者与审核员可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('已隐藏')}</span>
                  <span className="mini-value">{t('仅审核员可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('已删除')}</span>
                  <span className="mini-value">{t('保留占位，回复仍在')}</span>
                </div>
              </div>
              <p className="tiny faint mt-12" style={{ lineHeight: 1.75 }}>
                {t(
                  '审核员与管理员可以隐藏任何评论；作者可以删除自己的评论。删除是软删除，不会抹掉上下文。',
                )}
              </p>
            </div>
          </section>
        </aside>
      </div>

      <section className="panel mt-24">
        <div className="panel-head">
          <div>
            <h3>{t('AI 审核')}</h3>
            <p>{t('本地启发式打分，不把文章或评论正文发送到外部服务。')}</p>
          </div>
          <Badge tone={ai.enabled ? 'ok' : 'muted'}>
            {ai.enabled ? t('已开启') : t('已关闭')}
          </Badge>
        </div>
        <div className="panel-body">
          <div className="settings-grid">
            <div className="form-stack">
              <Toggle
                checked={ai.enabled}
                disabled={!canModerateComment && !canModerateContent}
                onChange={toggleAi}
                label={t('启用 AI 审核')}
                description={t('用本地规则给评论和/或文章打分；是否自动处置由下面的权限决定。')}
              />
              <Toggle
                checked={ai.scopes.comment}
                disabled={!ai.enabled || !canModerateComment}
                onChange={(next) => setScope('comment', next)}
                label={t('AI 审核评论')}
                description={t('在评论列表标出风险分；开启自动权限后按当前评论策略处置。')}
              />
              {!personal ? (
                <Toggle
                  checked={ai.scopes.article}
                  disabled={!ai.enabled || !canModerateContent}
                  onChange={(next) => setScope('article', next)}
                  label={t('AI 审核文章')}
                  description={t('给待审稿件打分；开启自动权限后自动发布低风险稿件。')}
                />
              ) : null}
              <Toggle
                checked={ai.auto}
                disabled={!ai.enabled || scopeCount === 0}
                onChange={(auto) => saveAi({ auto })}
                label={t('自动审核自动发送')}
                description={autoDescription}
              />
              <p className="tiny faint" style={{ lineHeight: 1.75 }}>
                {t(
                  '默认跟随先审后发：开启先审后发时自动通过低风险评论，关闭时自动删除高风险评论；文章只自动发布低风险稿件。',
                )}
              </p>
              <Field
                label={t('敏感度')}
                htmlFor="ai-sensitivity"
                hint={t('敏感度越高，同样的正文越容易被判为中高风险。')}
              >
                <Select
                  id="ai-sensitivity"
                  value={ai.sensitivity}
                  disabled={!ai.enabled}
                  onChange={(event) =>
                    saveAi({ sensitivity: event.target.value as AiModerationSettings['sensitivity'] })
                  }
                >
                  <option value="low">{t('低（只报明显风险）')}</option>
                  <option value="medium">{t('中（默认）')}</option>
                  <option value="high">{t('高（宁可多报）')}</option>
                </Select>
              </Field>
              <Field
                label={t('自定义风险词')}
                htmlFor="ai-blocked-terms"
                hint={t('用逗号分隔；命中一次加 5 分。')}
              >
                <Input
                  id="ai-blocked-terms"
                  value={ai.blocked_terms.join(', ')}
                  disabled={!ai.enabled}
                  placeholder={t('例如：竞品名、引流词')}
                  onChange={(event) =>
                    saveAi({
                      blocked_terms: event.target.value
                        .split(/[,，\n]/)
                        .map((term) => term.trim().toLowerCase())
                        .filter(Boolean)
                        .slice(0, 50),
                    })
                  }
                />
              </Field>
            </div>

            <aside className="settings-side">
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{t('当前 AI 权限')}</h3>
                    <p>{t('保存后立即按这张表处理队列。')}</p>
                  </div>
                </div>
                <div className="panel-body" style={{ paddingTop: 4 }}>
                  <div className="mini-list">
                    <div className="mini-row">
                      <span className="mini-label">{t('评论策略')}</span>
                      <span className="mini-value">
                        {commentsRequireReview ? t('先审后发') : t('直接发布')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('文章策略')}</span>
                      <span className="mini-value">{PUBLISH_LABEL[publishMode]}</span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('评论')}</span>
                      <span className="mini-value">{commentBehavior}</span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('文章')}</span>
                      <span className="mini-value">{articleBehavior}</span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('权限')}</span>
                      <span className="mini-value">
                        {!ai.enabled
                          ? t('未启用')
                          : ai.auto
                            ? t('自动审核自动发送')
                            : t('只给建议')}
                      </span>
                    </div>
                  </div>
                  <Callout tone="info" icon="bulb">
                    {t(
                      '自动处置只在打开队列页时执行一轮：评论最多扫描最近 100 条，文章最多扫描最近 100 篇待审稿件。',
                    )}
                  </Callout>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </section>

      <ContentSafetyPanel />
    </>
  );
}
