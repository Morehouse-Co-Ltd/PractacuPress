import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content, TaxonomyTerm } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { formatDate } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  Textarea,
  Tabs,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

type TermKind = 'categories' | 'tags';

interface TermDraft {
  id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
}

const EMPTY: TermDraft = { id: '', name: '', slug: '', description: '', color: '#2f6b4f' };

function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function TaxonomyPage() {
  const t = useT();
  useTitle(t('分类与标签'));
  const backend = useBackend();
  const toast = useToast();
  const {
    taxonomy,
    source: taxonomySource,
    saveTerm: persistTerm,
    deleteTerm: removeTerm,
  } = useTaxonomy();
  const [tab, setTab] = useState<TermKind>('categories');
  const [draft, setDraft] = useState<TermDraft | null>(null);
  const [editingId, setEditingId] = useState('');
  const [deleting, setDeleting] = useState<TaxonomyTerm | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const contents = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return [...articles.items, ...posts.items] as Content[];
  }, [backend]);

  const list = taxonomy[tab];
  const all = contents.data ?? [];
  const kind = tab === 'categories' ? 'category' : 'tag';

  const categoryCount = (term: TaxonomyTerm) => all.filter((item) => item.category_id === term.id).length;
  const tagCount = (term: TaxonomyTerm) => all.filter((item) => item.tags?.includes(term.name)).length;

  const counts = {
    categories: taxonomy.categories.length,
    tags: taxonomy.tags.length,
  };

  /** 「分类 / 标签」在当前标签页下的说法，集中一处，避免 JSX 里到处写三目。 */
  const kindWord = tab === 'categories' ? t('分类') : t('标签');
  const createLabel = tab === 'categories' ? t('新增分类') : t('新增标签');
  const editLabel = tab === 'categories' ? t('编辑分类') : t('编辑标签');

  const openCreate = () => {
    setEditingId('');
    setDraft({ ...EMPTY });
    setError('');
  };

  const openEdit = (term: TaxonomyTerm) => {
    setEditingId(term.id);
    setDraft({
      id: term.id,
      name: term.name,
      slug: term.slug,
      description: term.description ?? '',
      color: term.color ?? '#2f6b4f',
    });
    setError('');
  };

  const saveTerm = async () => {
    if (!draft || saving) return;
    const name = draft.name.trim();
    if (!name) {
      setError(t('名称不能为空。'));
      return;
    }
    let slug = slugOf(draft.slug || name);
    if (!slug) slug = `term-${Date.now().toString(36)}`;
    if (list.some((term) => term.id !== editingId && term.name === name)) {
      setError(t('这个名称已经存在。'));
      return;
    }
    if (list.some((term) => term.id !== editingId && term.slug === slug)) {
      setError(t('这个路径已经被使用。'));
      return;
    }
    setSaving(true);
    try {
      await persistTerm(
        kind,
        {
          kind,
          name,
          slug,
          description: draft.description.trim() || undefined,
          color: tab === 'categories' ? draft.color : undefined,
        },
        editingId || undefined,
      );
      toast.push(
        'ok',
        editingId ? t('已更新') : t('已新增'),
        t('{kind}「{name}」', { kind: kindWord, name }),
      );
      setDraft(null);
      setEditingId('');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('保存失败。');
      setError(message);
      toast.push('error', t('保存失败'), message);
    } finally {
      setSaving(false);
    }
  };

  const deleteTerm = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await removeTerm(kind, deleting.id);
      toast.push('ok', t('已删除'), t('内容中的引用会保留为纯文本。'));
      setDeleting(null);
    } catch (err) {
      toast.push('error', t('删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <RoleGate capability="manage_site" need={t('管理站点')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('分类与标签')}</h1>
          <p>{t('分类用于归档文章，标签用于跨分类关联主题。两者会出现在文章编辑器的侧栏里。')}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/content" className="btn btn-ghost btn-sm">
            {t('内容库')}
          </Link>
          <Button size="sm" icon="plus" onClick={openCreate}>
            {createLabel}
          </Button>
        </div>
      </div>

      <div className="taxonomy-summary">
        <button
          type="button"
          className={`taxonomy-stat${tab === 'categories' ? ' is-on' : ''}`}
          onClick={() => setTab('categories')}
        >
          <span className="taxonomy-stat-icon">
            <Icon name="layers" size={18} />
          </span>
          <span>
            <strong>{counts.categories}</strong>
            <em>{t('分类')}</em>
          </span>
        </button>
        <button
          type="button"
          className={`taxonomy-stat${tab === 'tags' ? ' is-on' : ''}`}
          onClick={() => setTab('tags')}
        >
          <span className="taxonomy-stat-icon">
            <Icon name="tag" size={18} />
          </span>
          <span>
            <strong>{counts.tags}</strong>
            <em>{t('标签')}</em>
          </span>
        </button>
        <div className="taxonomy-note">
          <Icon name="info" size={14} />
          {taxonomySource === 'backend'
            ? t('分类与标签已保存到真实后端。')
            : t('当前使用本地安装配置；连接带分类端点的真实后端后会自动切换为服务端存储。')}
        </div>
      </div>

      <div className="toolbar mt-20">
        <Tabs
          value={tab}
          onChange={(next) => {
            setTab(next as TermKind);
            setDraft(null);
          }}
          items={[
            { key: 'categories', label: t('分类'), count: counts.categories },
            { key: 'tags', label: t('标签'), count: counts.tags },
          ]}
        />
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('共 {count} 项', { count: list.length })}</span>
      </div>

      {error && !draft ? (
        <div className="mt-12">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      <div className="panel mt-16">
        {list.length === 0 ? (
          <div className="panel-body">
            <EmptyState
              icon="tag"
              title={tab === 'categories' ? t('还没有分类') : t('还没有标签')}
              body={t('创建后可以在文章编辑器里选择，也会出现在前台内容卡片上。')}
              action={
                <Button size="sm" icon="plus" onClick={openCreate}>
                  {createLabel}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('名称')}</th>
                  <th>{t('路径')}</th>
                  <th>{t('说明')}</th>
                  <th>{tab === 'categories' ? t('文章数') : t('使用次数')}</th>
                  <th style={{ textAlign: 'right' }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((term) => {
                  const count = tab === 'categories' ? categoryCount(term) : tagCount(term);
                  return (
                    <tr key={term.id}>
                      <td>
                        <div className="taxonomy-name">
                          {tab === 'categories' ? (
                            <span className="taxonomy-dot" style={{ background: term.color ?? 'var(--accent)' }} />
                          ) : (
                            <span className="taxonomy-hash">#</span>
                          )}
                          <strong>{term.name}</strong>
                        </div>
                      </td>
                      <td className="tiny mono muted">{term.slug}</td>
                      <td className="small muted">{term.description || '—'}</td>
                      <td>
                        <Badge tone={count ? 'accent' : 'muted'}>{count}</Badge>
                      </td>
                      <td className="cell-actions">
                        <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                          <Button variant="quiet" size="sm" icon="edit" onClick={() => openEdit(term)}>
                            {t('编辑')}
                          </Button>
                          <Button variant="quiet" size="sm" icon="trash" onClick={() => setDeleting(term)}>
                            {t('删除')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tiny faint mt-12">
        {t('列表最多载入每种内容类型 100 条；文章数与使用次数在浏览器内统计。')}
        {contents.data?.length
          ? ` ${t('最后更新：{time}', { time: formatDate(new Date().toISOString()) })}`
          : ''}
      </p>

      <Modal
        open={!!draft}
        title={editingId ? editLabel : createLabel}
        description={t('名称显示在前台；英文路径用于筛选链接与导出。')}
        onClose={() => setDraft(null)}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('取消')}
            </Button>
            <Button icon="check" loading={saving} onClick={() => void saveTerm()}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="form-stack">
            <div className="form-grid">
              <Field label={t('名称')} htmlFor="taxonomy-name">
                <Input
                  id="taxonomy-name"
                  value={draft.name}
                  maxLength={40}
                  autoFocus
                  placeholder={tab === 'categories' ? t('例如：写作') : t('例如：独立出版')}
                  onChange={(event) =>
                    setDraft((prev) =>
                      prev ? { ...prev, name: event.target.value, slug: editingId ? prev.slug : slugOf(event.target.value) } : prev,
                    )
                  }
                />
              </Field>
              <Field label={t('英文路径')} htmlFor="taxonomy-slug" hint={t('小写字母、数字与连字符。')}>
                <Input
                  id="taxonomy-slug"
                  value={draft.slug}
                  maxLength={60}
                  placeholder="writing"
                  onChange={(event) => setDraft((prev) => (prev ? { ...prev, slug: event.target.value } : prev))}
                />
              </Field>
            </div>
            {tab === 'categories' ? (
              <Field label={t('颜色')} htmlFor="taxonomy-color" hint={t('用于分类标记与内容卡片。')}>
                <div className="row gap-8">
                  <input
                    id="taxonomy-color"
                    type="color"
                    value={draft.color}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, color: event.target.value } : prev))}
                  />
                  <code className="mono tiny">{draft.color}</code>
                </div>
              </Field>
            ) : null}
            <Field label={t('说明')} htmlFor="taxonomy-description" aside={`${draft.description.length}/160`}>
              <Textarea
                id="taxonomy-description"
                value={draft.description}
                maxLength={160}
                style={{ minHeight: 74 }}
                placeholder={t('可选：这个分类收录什么内容。')}
                onChange={(event) =>
                  setDraft((prev) => (prev ? { ...prev, description: event.target.value } : prev))
                }
              />
            </Field>
            {error ? (
              <Callout tone="danger" icon="alert">
                {error}
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!deleting}
        title={t('删除{kind}「{name}」？', { kind: kindWord, name: deleting?.name ?? '' })}
        description={t('内容不会删除，已有引用会保留为纯文本。这个操作不能撤销。')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" icon="trash" loading={saving} onClick={() => void deleteTerm()}>
              {t('删除')}
            </Button>
          </>
        }
      >
        <p className="small muted">
          {tab === 'categories'
            ? t('有 {count} 篇内容使用这个分类。', { count: deleting ? categoryCount(deleting) : 0 })
            : t('有 {count} 篇内容使用这个标签。', { count: deleting ? tagCount(deleting) : 0 })}
        </p>
      </Modal>
    </RoleGate>
  );
}
