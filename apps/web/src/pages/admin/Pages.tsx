import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SitePage } from '../../types';
import { useCustomization } from '../../lib/customize';
import { PAGE_TEMPLATES } from '../../lib/templates';
import { useTitle } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import { Badge, Button, Callout, EmptyState, Modal } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

export function PagesPage() {
  const t = useT();
  useTitle(t('页面'));
  const { customization, update } = useCustomization();
  const navigate = useNavigate();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState<SitePage | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  const pages = [...customization.pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const remove = () => {
    if (!pendingDelete) return;
    update({ pages: customization.pages.filter((page) => page.id !== pendingDelete.id) });
    toast.push('ok', t('页面已删除'), t('/{slug} 不再可访问。', { slug: pendingDelete.slug }));
    setPendingDelete(null);
  };


  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('页面')}</h1>
          <p>
            {t('建立“关于”“留言箱”这类独立页面，并把它们放进站点导航。页面内容由组件编排而成。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            {t('预览站点')}
          </Button>
          <Button size="sm" icon="plus" onClick={() => setTemplateOpen(true)}>
            {t('新建页面')}
          </Button>
        </div>
      </div>

      <div className="panel mt-20">
        {pages.length === 0 ? (
          <div className="panel-body">
            <EmptyState
              icon="layers"
              title={t('还没有自定义页面')}
              body={t('从「留言箱」或「关于页」开始：保存后就能访问，也可以放进页头导航。')}
              action={
                <Button size="sm" icon="plus" onClick={() => setTemplateOpen(true)}>
                  {t('选择模板')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('页面')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('导航')}</th>
                  <th>{t('更新时间')}</th>
                  <th style={{ textAlign: 'right' }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.id}>
                    <td className="cell-title" style={{ maxWidth: 380 }}>
                      <div className="page-list-title">
                        <span>{page.title}</span>
                        <code>/{page.slug}</code>
                      </div>
                      {page.summary ? <div className="tiny faint">{page.summary}</div> : null}
                    </td>
                    <td>
                      <Badge tone={page.status === 'published' ? 'ok' : 'muted'}>
                        {page.status === 'published' ? t('已发布') : t('草稿')}
                      </Badge>
                    </td>
                    <td>
                      {page.show_in_nav && page.status === 'published' ? (
                        <Badge tone="accent">{t('已加入')}</Badge>
                      ) : (
                        <span className="tiny faint">—</span>
                      )}
                    </td>
                    <td className="cell-num">{formatDateTime(page.updated_at)}</td>
                    <td className="cell-actions">
                      <a
                        href={`/${page.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-ghost btn-sm"
                      >
                        {t('查看')}
                      </a>
                      <Link to={`/admin/pages/${page.id}`} className="btn btn-secondary btn-sm">
                        {t('编辑')}
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setPendingDelete(page)}
                      >
                        {t('删除')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={templateOpen}
        title={t('从哪个模板开始？')}
        description={t('模板只生成标题、摘要与组件编排；保存前都可以改，也可以之后在页面编排里继续调整。')}
        onClose={() => setTemplateOpen(false)}
        width={760}
        footer={
          <Button variant="ghost" onClick={() => setTemplateOpen(false)}>
            {t('取消')}
          </Button>
        }
      >
        <div className="page-template-grid">
          {PAGE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="page-template-card"
              onClick={() => {
                setTemplateOpen(false);
                navigate(`/admin/pages/new?template=${template.id}`);
              }}
            >
              <strong>{template.name}</strong>
              <p>{template.note}</p>
              <span className="page-template-go">
                {t('使用模板')} <Icon name="arrow-right" size={13} />
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={!!pendingDelete}
        title={t('删除这个页面？')}
        description={
          pendingDelete ? t('/{slug} 会立即失效。', { slug: pendingDelete.slug }) : undefined
        }
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" onClick={remove}>
              {t('删除页面')}
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert">
          {t('页面内容会从本地配置里移除，无法撤销。已经发给读者的链接会变成 404。')}
        </Callout>
      </Modal>
    </RoleGate>
  );
}
