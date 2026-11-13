import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CustomExtension,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
} from '../types';
import {
  EXTENSION_LIMITS,
  EXTENSION_PAGE_SCOPES,
  EXTENSION_PERMISSIONS,
  EXTENSION_SLOTS,
} from '../lib/customize';
import {
  applyTemplateToDraft,
  buildExtensionForSave,
  emptyExtensionDraft,
  extensionCodeOverLimit,
  extensionCodeUsage,
  extensionDraftDirty,
  extensionDraftFrom,
  extensionHasContent,
  extensionPreviewPageKind,
  toggleDraftPage,
  toggleDraftPermission,
  toggleDraftSlot,
  validateExtensionDraft,
} from '../lib/extensionDraft';
import { EXTENSION_TEMPLATES, type ExtensionTemplate } from '../lib/extensionTemplates';
import {
  PERMISSION_HINTS,
  buildExtensionFile,
  downloadJson,
  extensionFileName,
  pageScopeLabel,
  permissionLabel,
  slotLabel,
  type ExtensionDocumentContext,
  type ExtensionPageKind,
} from '../lib/extensions';
import { useT } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { ExtensionHost } from './ExtensionHost';
import { Badge, Button, Callout, Field, Input, Modal, Select, Textarea, Toggle, cx } from './ui';

/**
 * 扩展工坊：在管理页里就地编辑一份创作者扩展。
 *
 * 不刷新的关键约定：
 * - 草稿只存在于本组件 state，输入代码不会写站点设计、不会导航；
 * - 保存时父组件只替换 `custom_extensions` 里的同一条清单，本组件保持挂载，
 *   所以编辑区的焦点、光标、两栏各自的滚动位置都不会被重置；
 * - 保存后父组件把新清单回传给 `saved`，这里只把草稿收敛成同一份（值没变时
 *   React 不会碰 textarea 的 DOM，光标原地不动）；
 * - 预览 iframe 的失败被 ErrorBoundary 与加载兜底隔离：只回退预览内容，表单与
 *   保存完全不受影响。
 */

/** 输入停顿多久后重建预览 iframe（太短会在每个按键上重载沙箱）。 */
const PREVIEW_DEBOUNCE_MS = 320;
/** iframe 迟迟不 load 时的兜底：超时也不算表单失败，只回退预览。 */
const PREVIEW_LOAD_TIMEOUT_MS = 8000;

/** 预览可以切成这几种页面；`other`（登录页 / 自定义页）没有槽位，不提供预览。 */
type PreviewPage = Exclude<ExtensionPageKind, 'other'>;

const PREVIEW_PAGES: PreviewPage[] = ['article', 'home', 'list', 'search'];

export interface ExtensionStudioProps {
  /** 已保存的清单；null 表示这是新建。 */
  saved: CustomExtension | null;
  /** 站点主题：预览 iframe 与前台看到的一致。 */
  theme: ExtensionDocumentContext['theme'];
  /** 关闭工坊；未保存的草稿随之丢弃（列表与站点设计不受影响）。 */
  onClose: () => void;
  /**
   * 就地保存草稿。
   *
   * 返回真正写进站点设计的清单（可能已被截断 / trim），本组件用它收敛草稿；
   * 父组件必须保持本组件挂载（不要换 key），否则光标与滚动会丢。
   */
  onSave: (draft: CustomExtension) => CustomExtension | void;
}

export function ExtensionStudio({ saved, theme, onClose, onSave }: ExtensionStudioProps) {
  const t = useT();
  const toast = useToast();

  const [draft, setDraft] = useState<CustomExtension>(() =>
    saved ? extensionDraftFrom(saved) : emptyExtensionDraft(),
  );
  const [nameError, setNameError] = useState('');
  const [pendingTemplate, setPendingTemplate] = useState<ExtensionTemplate | null>(null);
  const [previewPage, setPreviewPage] = useState<PreviewPage>(() =>
    extensionPreviewPageKind(draft.pages) as PreviewPage,
  );

  /* ---------------- 预览：防抖 + 失败隔离 ---------------- */

  const [previewDraft, setPreviewDraft] = useState<CustomExtension>(draft);
  const [previewToken, setPreviewToken] = useState(0);
  const [previewOverride, setPreviewOverride] = useState<CustomExtension | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const loadedRef = useRef(false);
  // 同一次预览里错误边界与加载兜底可能先后报错：只提示一次，避免刷屏。
  const failureRef = useRef(false);

  const markPreviewLoaded = useCallback(() => {
    loadedRef.current = true;
  }, []);

  const handlePreviewFailure = useCallback(() => {
    if (failureRef.current) return;
    failureRef.current = true;
    loadedRef.current = true;
    setPreviewFailed(true);
    const fallback = saved ? extensionDraftFrom(saved) : null;
    if (fallback) {
      // 回滚的是「预览」：表单里没保存的内容仍然在，随时可以继续改、继续保存。
      setPreviewOverride(fallback);
      setPreviewToken((token) => token + 1);
    }
    toast.push(
      'error',
      t('扩展预览失败'),
      fallback
        ? t('预览已回退到上次保存的版本；表单内容不受影响，仍然可以保存。')
        : t('预览脚本没有跑起来；表单内容不受影响，仍然可以保存。'),
    );
  }, [saved, t, toast]);

  const retryPreview = useCallback(() => {
    loadedRef.current = false;
    failureRef.current = false;
    setPreviewFailed(false);
    setPreviewOverride(null);
    setPreviewToken((token) => token + 1);
  }, []);

  // 预览页类型跟着「适用页面」走：改成只在首页生效后，预览也切到首页，
  // 否则用户会看到一篇文章里永远不会出现的槽位。
  useEffect(() => {
    setPreviewPage(extensionPreviewPageKind(draft.pages) as PreviewPage);
  }, [draft.pages]);

  // 草稿变化后重建预览；失败状态与回退内容也随之复位。
  // 用对象身份判断「草稿是否已经进入预览」：首帧与保存后的收敛都不会白重建一次
  // iframe，StrictMode 下重复执行这个 effect 也不会。
  useEffect(() => {
    if (previewDraft === draft) return undefined;
    const timer = window.setTimeout(() => {
      loadedRef.current = false;
      failureRef.current = false;
      setPreviewDraft(draft);
      setPreviewOverride(null);
      setPreviewFailed(false);
      setPreviewToken((token) => token + 1);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, previewDraft]);

  // 预览迟迟没有 load：只影响预览区，不挡保存。
  useEffect(() => {
    if (previewFailed) return undefined;
    const timer = window.setTimeout(() => {
      if (loadedRef.current) return;
      handlePreviewFailure();
    }, PREVIEW_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [previewToken, previewFailed, handlePreviewFailure]);

  const previewSubject = previewOverride ?? previewDraft;
  const previewContext = useMemo<ExtensionDocumentContext>(
    () => ({
      theme: {
        background: theme.background,
        ink: theme.ink,
        accent: theme.accent,
        font: theme.font,
      },
      page: previewPage,
      title: previewPage === 'article' ? t('一篇文章的标题') : '',
      extensionId: previewSubject.id,
    }),
    [theme.background, theme.ink, theme.accent, theme.font, previewPage, previewSubject.id, t],
  );

  /* ---------------- 保存 / 导出 / 模板 ---------------- */

  const patchDraft = (patch: Partial<CustomExtension>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  };

  const saveDraft = () => {
    const error = validateExtensionDraft(draft);
    if (error) {
      setNameError(error);
      toast.push('error', t('请先填写扩展名称'));
      return;
    }
    setNameError('');
    const usage = extensionCodeUsage(draft);
    const truncated =
      extensionCodeOverLimit('html', usage.html) ||
      extensionCodeOverLimit('css', usage.css) ||
      extensionCodeOverLimit('js', usage.js);
    const persisted = onSave(buildExtensionForSave(draft, saved));
    // 收敛成落盘后的清单：截断与 trim 之后，草稿与「已保存」保持一致，不会一直
    // 显示「有未保存修改」。值没变化时 textarea 的 DOM 不动，光标与滚动都保留。
    if (persisted) setDraft(extensionDraftFrom(persisted));
    if (truncated) toast.push('info', t('内容超出上限，已按限制截断。'));
  };

  const exportDraft = () => {
    const manifest = buildExtensionForSave(draft, saved);
    const fileName = extensionFileName(manifest);
    downloadJson(fileName, buildExtensionFile(manifest));
    toast.push('ok', t('已导出草稿清单'), fileName);
  };

  const insertTemplate = (template: ExtensionTemplate) => {
    setDraft((previous) => applyTemplateToDraft(previous, template));
    setPendingTemplate(null);
    toast.push('ok', t('已载入示例模板'), template.name);
  };

  /** 已经有内容时先问一句：套模板会整体覆盖 HTML / CSS / JS，不能悄悄丢掉。 */
  const requestTemplate = (template: ExtensionTemplate) => {
    if (extensionHasContent(draft)) {
      setPendingTemplate(template);
      return;
    }
    insertTemplate(template);
  };

  const dirty = useMemo(() => extensionDraftDirty(draft, saved), [draft, saved]);
  const hasContent = extensionHasContent(previewSubject);
  const failed = previewFailed && !previewOverride;

  const previewFallback = (
    <Callout tone="danger" icon="alert" title={t('预览失败')}>
      <span>{t('预览脚本没有跑起来；表单内容不受影响，仍然可以保存。')}</span>
      <Button variant="ghost" size="sm" icon="refresh" onClick={retryPreview}>
        {t('重试')}
      </Button>
    </Callout>
  );

  return (
    <Modal
      open
      width={1180}
      title={saved ? t('编辑：{name}', { name: saved.name }) : t('新建扩展')}
      description={t('清单决定它出现在哪里、能做什么；内容与脚本在右侧沙箱里实时预览。')}
      onClose={onClose}
      footer={
        <>
          <span className="ppe-studio-dirty" aria-live="polite">
            {dirty ? t('未保存的修改') : null}
          </span>
          <div className="ppe-studio-foot-actions">
            {saved && dirty ? (
              <Button variant="ghost" onClick={() => setDraft(extensionDraftFrom(saved))}>
                {t('放弃修改')}
              </Button>
            ) : null}
            <Button variant="ghost" icon="download" onClick={exportDraft}>
              {t('导出草稿清单')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" icon="check" onClick={saveDraft}>
              {saved ? t('更新') : t('保存为我的扩展')}
            </Button>
          </div>
        </>
      }
    >
      {/* Ctrl/Cmd+S 就地保存：不移动焦点，光标与滚动都留在原处。 */}
      <div
        className="ppe-studio"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveDraft();
          }
        }}
      >
        <div className="ppe-studio-form">
          <Toggle
            checked={draft.enabled}
            onChange={(enabled) => patchDraft({ enabled })}
            label={t('启用')}
            description={t('启用后会出现在站点前台对应的槽位；清单保存在本地安装配置里，可随站点一起迁移。')}
          />

          <div className="ppe-studio-basics">
            <Field label={t('名称')} error={nameError} htmlFor="ppe-ext-name">
              <Input
                id="ppe-ext-name"
                value={draft.name}
                maxLength={EXTENSION_LIMITS.name}
                placeholder={t('例如：文末作者卡')}
                onChange={(event) => {
                  setNameError('');
                  patchDraft({ name: event.target.value });
                }}
              />
            </Field>
            <Field label={t('版本')} hint={t('自由填写，例如 1.0.0。')}>
              <Input
                value={draft.version}
                maxLength={EXTENSION_LIMITS.version}
                onChange={(event) => patchDraft({ version: event.target.value })}
              />
            </Field>
            <Field label={t('作者')} hint={t('署名')}>
              <Input
                value={draft.author}
                maxLength={EXTENSION_LIMITS.author}
                onChange={(event) => patchDraft({ author: event.target.value })}
              />
            </Field>
            <Field label={t('图标')} hint={t('显示在卡片左侧的单字；留空取名称首字。')}>
              <Input
                value={draft.icon ?? ''}
                maxLength={4}
                placeholder={t('例：作')}
                onChange={(event) => patchDraft({ icon: event.target.value })}
              />
            </Field>
          </div>

          <Field label={t('说明')}>
            <Textarea
              rows={2}
              value={draft.description}
              maxLength={EXTENSION_LIMITS.description}
              placeholder={t('一句话说明这个扩展做什么')}
              onChange={(event) => patchDraft({ description: event.target.value })}
            />
          </Field>

          <Field label={t('挂载位置')} hint={t('至少选一个；全部不选会回退到「文章底部」。')}>
            <div className="ppe-chip-row">
              {EXTENSION_SLOTS.map((slot: ExtensionSlot) => (
                <CheckChip
                  key={slot}
                  checked={draft.slots.includes(slot)}
                  label={slotLabel(slot)}
                  onChange={() => setDraft((previous) => toggleDraftSlot(previous, slot))}
                />
              ))}
            </div>
          </Field>

          <Field
            label={t('适用页面')}
            hint={t('「全部页面」会忽略其它选项；登录页、自定义页只命中「全部页面」。')}
          >
            <div className="ppe-chip-row">
              {EXTENSION_PAGE_SCOPES.map((page: ExtensionPageScope) => (
                <CheckChip
                  key={page}
                  checked={draft.pages.includes(page)}
                  label={pageScopeLabel(page)}
                  onChange={() => setDraft((previous) => toggleDraftPage(previous, page))}
                />
              ))}
            </div>
          </Field>

          <Field
            label={t('申请权限')}
            hint={t('没勾选的能力在沙箱桥里会被直接忽略。')}
          >
            <div className="ppe-chip-row">
              {EXTENSION_PERMISSIONS.map((permission: ExtensionPermission) => (
                <CheckChip
                  key={permission}
                  checked={draft.permissions.includes(permission)}
                  label={permissionLabel(permission)}
                  title={PERMISSION_HINTS[permission]}
                  onChange={() =>
                    setDraft((previous) => toggleDraftPermission(previous, permission))
                  }
                />
              ))}
            </div>
          </Field>

          <div className="ppe-studio-template">
            {pendingTemplate ? (
              <>
                <span className="ppe-studio-template-warn">
                  {t('示例模板会覆盖当前的 HTML / CSS / JS，继续吗？')}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="check"
                  onClick={() => insertTemplate(pendingTemplate)}
                >
                  {t('继续')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPendingTemplate(null)}>
                  {t('取消')}
                </Button>
              </>
            ) : (
              <>
                <span className="ppe-studio-template-label">{t('插入示例模板')}</span>
                {EXTENSION_TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    variant="ghost"
                    size="sm"
                    icon="sparkle"
                    onClick={() => requestTemplate(template)}
                  >
                    {template.name}
                  </Button>
                ))}
              </>
            )}
          </div>

          <CodeField
            label={t('HTML 正文')}
            hint={t('放进 iframe 的 body')}
            rows={8}
            limit={EXTENSION_LIMITS.html}
            value={draft.html}
            onChange={(html) => patchDraft({ html })}
          />
          <CodeField
            label={t('CSS 样式')}
            hint={t('自动注入，可用 --pp-bg / --pp-ink / --pp-accent')}
            rows={5}
            limit={EXTENSION_LIMITS.css}
            value={draft.css}
            onChange={(css) => patchDraft({ css })}
          />
          <CodeField
            label={t('JS 脚本')}
            hint={t('可用 window.PP 桥读取上下文与上报高度')}
            rows={8}
            limit={EXTENSION_LIMITS.js}
            value={draft.js}
            onChange={(js) => patchDraft({ js })}
          />
        </div>

        <aside className="ppe-studio-preview" aria-label={t('实时预览')}>
          <div className="ppe-studio-preview-head">
            <strong>{t('实时预览')}</strong>
            <Badge tone={draft.enabled ? 'ok' : 'muted'} dot={draft.enabled}>
              {draft.enabled ? t('前台启用中') : t('未启用')}
            </Badge>
          </div>
          <p className="ppe-studio-preview-hint">
            {t('与前台相同的 sandbox iframe（allow-scripts，无同源权限）。')}
          </p>
          <div className="ppe-studio-preview-pager">
            <span>{t('预览页类型')}</span>
            <Select
              value={previewPage}
              aria-label={t('预览页类型')}
              onChange={(event) => setPreviewPage(event.target.value as PreviewPage)}
            >
              {PREVIEW_PAGES.map((page) => (
                <option key={page} value={page}>
                  {pageScopeLabel(page)}
                </option>
              ))}
            </Select>
          </div>

          <div className="ppe-studio-preview-stage">
            {!hasContent ? (
              <p className="ppe-studio-preview-empty">{t('还没有 HTML / CSS / JS 内容')}</p>
            ) : failed ? (
              previewFallback
            ) : (
              <PreviewBoundary
                key={previewToken}
                onError={handlePreviewFailure}
                fallback={previewFallback}
              >
                <ExtensionHost
                  extension={previewSubject}
                  context={previewContext}
                  preview
                  maxHeight={420}
                  onLoad={markPreviewLoaded}
                  onError={handlePreviewFailure}
                />
              </PreviewBoundary>
            )}
          </div>

          {previewOverride && !failed ? (
            <Callout tone="warn" icon="info" title={t('已回退到上次保存的版本。')}>
              {t('未保存的改动仍然在左侧表单里，修好之后会自动重新预览。')}
            </Callout>
          ) : null}

          <p className="ppe-studio-preview-note">
            {t(
              '预览页类型：{page}；标题使用占位内容。扩展未启用时不会出现在前台，但这里始终可以预览。',
              { page: pageScopeLabel(previewPage) },
            )}
          </p>
        </aside>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 局部组件
 * ------------------------------------------------------------------ */

/** 勾选式胶囊：挂载位置 / 适用页面 / 权限共用。 */
function CheckChip({
  checked,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  label: string;
  title?: string;
  onChange: () => void;
}) {
  return (
    <label className={cx('ppe-chip', checked && 'is-on')} title={title}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

/** 代码字段：等宽字体、字符计数与「超出上限」提醒。 */
function CodeField({
  label,
  hint,
  rows,
  limit,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  rows: number;
  limit: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const over = value.length > limit;
  return (
    <Field
      label={label}
      hint={hint}
      aside={
        <span className={cx('ppe-code-count', over && 'is-over')}>
          {value.length} / {limit}
        </span>
      }
    >
      <Textarea
        className="ppe-code"
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {over ? <p className="ppe-code-over">{t(' · 超出上限，保存时会截断')}</p> : null}
    </Field>
  );
}

/**
 * 预览错误边界。
 *
 * 扩展文档由 `buildExtensionDocument` 在渲染期拼装；万一拼装或宿主渲染抛错，
 * 只有这一块退回 `fallback`，工坊的表单、保存按钮与页面其它部分都不受影响。
 * 重试时父组件换 `key`，边界重新挂载。
 */
class PreviewBoundary extends Component<
  { onError: () => void; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[扩展预览] 渲染失败，已隔离到预览区。', error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
