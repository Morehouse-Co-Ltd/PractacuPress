import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SitePage } from '../../types';
import {
  normalizePageSlug,
  pageSlugError,
  useCustomization,
} from '../../lib/customize';
import { templateById } from '../../lib/templates';
import { blockDef } from '../../lib/blocks';
import { useTitle } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Button,
  Callout,
  Field,
  Input,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

function newId(): string {
  return `page_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function PageEditorPage() {
  const t = useT();
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [params] = useSearchParams();
  const { customization, update } = useCustomization();
  const navigate = useNavigate();
  const toast = useToast();
  const existing = isNew ? null : customization.pages.find((page) => page.id === id);
  // 从模板新建：/admin/pages/new?template=about
  const template = isNew ? templateById(params.get('template') ?? '') : undefined;
  const seeded = template ? template.build() : null;

  const [title, setTitle] = useState(existing?.title ?? template?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [summary, setSummary] = useState(existing?.summary ?? seeded?.summary ?? '');
  const [status, setStatus] = useState<'draft' | 'published'>(existing?.status ?? 'draft');
  const [showInNav, setShowInNav] = useState(existing?.show_in_nav ?? true);
  // 页面内容只由页面编排的区块组成；这里只带上已有（或模板生成的）编排一起保存。
  const layout = existing?.layout ?? seeded?.layout;
  const [error, setError] = useState('');

  useTitle(isNew ? t('新建页面') : t('编辑页面'));

  if (!isNew && !existing) {
    return (
      <RoleGate capability="manage_site" need={t('站点管理员')}>
        <div className="panel">
          <div className="panel-body">
            <Callout tone="danger" icon="alert" title={t('页面不存在')}>
              {t('它可能已经被删除。回到页面列表重新选择。')}
            </Callout>
            <Link to="/admin/pages" className="btn btn-secondary btn-sm mt-16">
              {t('返回页面列表')}
            </Link>
          </div>
        </div>
      </RoleGate>
    );
  }

  const cleanSlug = normalizePageSlug(slug);

  const save = () => {
    setError('');
    if (!title.trim()) {
      setError(t('页面标题不能为空。'));
      return;
    }
    if (title.length > 160) {
      setError(t('标题不能超过 160 个字符。'));
      return;
    }
    const slugProblem = pageSlugError(cleanSlug, customization.pages, existing?.id);
    if (slugProblem) {
      setError(slugProblem);
      return;
    }
    if (summary.length > 400) {
      setError(t('摘要不能超过 400 个字符。'));
      return;
    }
    const now = new Date().toISOString();
    const next: SitePage = existing
      ? {
          ...existing,
          title: title.trim(),
          slug: cleanSlug,
          summary: summary.trim(),
          body: '',
          status,
          show_in_nav: showInNav,
          layout,
          updated_at: now,
        }
      : {
          id: newId(),
          title: title.trim(),
          slug: cleanSlug,
          summary: summary.trim(),
          body: '',
          status,
          show_in_nav: showInNav,
          layout,
          template: seeded?.template,
          created_at: now,
          updated_at: now,
        };
    const pages = existing
      ? customization.pages.map((page) => (page.id === existing.id ? next : page))
      : [...customization.pages, next];
    update({ pages });
    toast.push(
      'ok',
      isNew ? t('页面已创建') : t('页面已保存'),
      t('路径 /{slug}', { slug: next.slug }),
    );
    navigate(isNew ? `/admin/theme?page=${next.id}` : '/admin/pages');
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{isNew ? t('新建页面') : t('编辑页面')}</h1>
          <p>{t('页面是独立于文章的内容单元。保存后可以放进站点导航。')}</p>
        </div>
        <div className="admin-page-actions">
          {existing ? (
            <Link to={`/admin/theme?page=${existing.id}`} className="btn btn-secondary btn-sm">
              <Icon name="layers" size={14} /> {t('进入页面编排')}
            </Link>
          ) : null}
          <Button size="sm" icon="check" onClick={save}>
            {t('保存页面')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mb-20">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {template ? (
        <div className="mb-20">
          <Callout
            tone="info"
            icon="layers"
            title={t('已套用模板「{name}」', { name: template.name })}
          >
            {template.note}{' '}
            {t('标题与路径还需要你自己填；区块顺序随时可以在页面编排里改。')}
          </Callout>
        </div>
      ) : null}

      {layout && layout.blocks.length ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('页面区块')}</h3>
              <p>
                {t('这个页面用 {count} 个区块排版，保存后按顺序渲染；内容全部在页面编排里维护。', {
                  count: layout.blocks.length,
                })}
              </p>
            </div>
            <Link to="/admin/theme" className="link-btn">
              {t('去编排')}
            </Link>
          </div>
          <div className="panel-body">
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              {layout.blocks.map((block, index) => (
                <span className="chip" key={block.id}>
                  {index + 1}. {block.title || blockDef(block.type)?.name || block.type}
                  {block.hidden ? t('（隐藏）') : ''}
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <div className="form-stack">
        <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('基本信息')}</h3>
                <p>{t('标题显示在页面与导航里，路径决定访问地址。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Field label={t('页面标题')} htmlFor="page-title" aside={`${title.length}/160`}>
                  <Input
                    id="page-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={160}
                    placeholder={t('关于本站')}
                  />
                </Field>

                <Field
                  label={t('页面路径')}
                  htmlFor="page-slug"
                  hint={t('访问地址是 /路径。只能使用小写字母、数字与连字符；中文标题请手动填写英文路径。')}
                  aside={
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setSlug(normalizePageSlug(title))}
                    >
                      {t('从标题生成')}
                    </button>
                  }
                >
                  <div className="row gap-6">
                    <span className="mono faint" style={{ fontSize: 13 }}>
                      /
                    </span>
                    <Input
                      id="page-slug"
                      value={slug}
                      onChange={(event) => setSlug(event.target.value)}
                      placeholder="about"
                      maxLength={60}
                    />
                  </div>
                </Field>

                <Field
                  label={t('摘要')}
                  htmlFor="page-summary"
                  aside={`${summary.length}/400`}
                  hint={t('可选。显示在标题下方，也会用于搜索描述。')}
                >
                  <Textarea
                    id="page-summary"
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    maxLength={400}
                    style={{ minHeight: 72 }}
                  />
                </Field>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('页面内容')}</h3>
                <p>{t('正文、分栏、图片、图表等全部在页面编排里用组件完成，不再单独编辑正文。')}</p>
              </div>
            </div>
            <div className="panel-body">
              {existing ? (
                <Link to={`/admin/theme?page=${existing.id}`} className="page-builder-entry">
                  <span className="page-builder-entry-icon"><Icon name="layers" size={22} /></span>
                  <span>
                    <strong>{t('进入页面编排')}</strong>
                    <em>{t('拖拽组件、实时预览并调整这个页面的布局。')}</em>
                  </span>
                  <Icon name="arrow-right" size={16} />
                </Link>
              ) : (
                <Callout tone="info" icon="layers" title={t('先保存基本信息')}>
                  {t('保存后会自动进入页面编排，为这个页面添加区块。正文和预览不再在基本信息页编辑。')}
                </Callout>
              )}
              {layout && layout.blocks.length ? (
                <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
                  {layout.blocks.map((block, index) => (
                    <span className="chip" key={block.id}>
                      {index + 1}. {block.title || blockDef(block.type)?.name || block.type}
                      {block.hidden ? t('（隐藏）') : ''}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('发布')}</h3>
                <p>{t('草稿只有站点管理员能预览，不会出现在导航里。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="option-grid two">
                {(['draft', 'published'] as const).map((value) => (
                  <label
                    key={value}
                    className={`setting-option${status === value ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="page-status"
                      checked={status === value}
                      onChange={() => setStatus(value)}
                    />
                    <span>
                      <strong>{value === 'draft' ? t('草稿') : t('已发布')}</strong>
                      <p>
                        {value === 'draft'
                          ? t('可以继续修改，读者看不到。')
                          : t('立即可以通过路径访问。')}
                      </p>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-16">
                <Toggle
                  checked={showInNav}
                  onChange={setShowInNav}
                  label={t('加入站点导航')}
                  description={t('已发布的页面会出现在页头，最多显示 3 个。')}
                />
              </div>
              {existing ? (
                <p className="tiny faint mt-12">
                  {t('上次更新：{time}', { time: formatDateTime(existing.updated_at) })}
                </p>
              ) : null}
            </div>
          </section>
      </div>
    </RoleGate>
  );
}
