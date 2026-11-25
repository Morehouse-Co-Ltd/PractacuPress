import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../types';
import { useBackend } from '../lib/backend';
import { useMediaSrc } from '../lib/assetUrl';
import { useAsync } from '../lib/hooks';
import { useT } from '../lib/i18n';
import {
  RICH_ICONS,
  collapseBlock,
  columnsBlock,
  embedBlock,
  galleryBlock,
  iconBlock,
  imageBlock,
  linkCardBlock,
  tableBlock,
  tipBlock,
  videoBlock,
  warningBlock,
} from '../lib/richBlocks';
import { Badge, Button, Callout, Field, Input, Modal, Progress, Select, Textarea } from './ui';
import { Icon } from './Icon';
import type { EditorCommands, EditorDialogKind } from './RichTextEditor';
import type { DiagramSpec } from '../lib/diagramSpec';
import { DiagramDialog } from './DiagramDialog';

/**
 * 富文本工具栏。
 *
 * 所有按钮都作用于 contenteditable 的当前选区：格式类走 execCommand，区块类插入
 * 白名单内的 HTML（见 lib/richBlocks）。打开弹窗之前先记住选区，否则输入框一聚焦，
 * 插入位置就丢了。
 */

type Dialog = 'image' | 'video' | 'embed' | 'table' | 'columns' | 'icon' | 'gallery' | 'formula' | 'diagram' | null;

export function EditorToolbar({
  commands,
  disabled = false,
  onReady,
}: {
  commands: EditorCommands;
  disabled?: boolean;
  /** 把「打开插入弹窗」的能力交给父组件，供斜杠面板复用现有弹窗。 */
  onReady?: (open: (kind: EditorDialogKind) => void) => void;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkMode, setLinkMode] = useState<'text' | 'card'>('text');
  const [linkHref, setLinkHref] = useState('https://');
  const [linkText, setLinkText] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [linkDescription, setLinkDescription] = useState('');
  const [linkCover, setLinkCover] = useState('');
  const [formulaMode, setFormulaMode] = useState<'inline' | 'block'>('inline');
  const [formulaSource, setFormulaSource] = useState('');
  /** 「编辑图表」回填的规格；插入时用 replace 整块替换，而不是再插一块。 */
  const [diagramInitial, setDiagramInitial] = useState<DiagramSpec | null>(null);
  const diagramReplace = useRef<((html: string) => void) | null>(null);

  const open = (kind: Exclude<Dialog, null>) => {
    commands.saveSelection();
    setDialog(kind);
  };

  const openLink = () => {
    commands.saveSelection();
    // 每次打开都回到「文字链接」，卡片是更重的选择；卡片字段不残留上一次的值。
    setLinkMode('text');
    setLinkTitle('');
    setLinkDescription('');
    setLinkCover('');
    setLinkOpen(true);
  };

  const openFormula = () => {
    commands.saveSelection();
    setFormulaMode('inline');
    setFormulaSource('');
    setDialog('formula');
  };

  /** 打开图表弹窗：光标在已有图表块内时回填规格，插入时整块替换。 */
  const openDiagram = () => {
    commands.saveSelection();
    const target = commands.diagramTarget();
    diagramReplace.current = target?.replace ?? null;
    setDiagramInitial(target?.spec ?? null);
    setDialog('diagram');
  };

  /** 斜杠面板统一的弹窗入口：把 kind 分发给现有的各个弹窗。 */
  const openDialog = (kind: EditorDialogKind) => {
    if (disabled) return;
    if (kind === 'formula') {
      openFormula();
      return;
    }
    if (kind === 'link') {
      openLink();
      return;
    }
    if (kind === 'diagram') {
      openDiagram();
      return;
    }
    open(kind);
  };

  // 用 ref 保存最新实现，父组件拿到的 opener 永远是最新的。
  const openDialogRef = useRef(openDialog);
  openDialogRef.current = openDialog;

  useEffect(() => {
    onReady?.((kind) => openDialogRef.current(kind));
  }, [onReady]);

  const insert = (html: string) => {
    commands.insert(html);
    setDialog(null);
  };

  return (
    <div className="rich-toolbar" role="toolbar" aria-label={t('写作工具')}>
      <div className="rich-toolbar-row">
        <div className="tool-group" aria-label={t('标题')}>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('二级标题')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(2)}
          >
            <span className="tool-glyph">H2</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('三级标题')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(3)}
          >
            <span className="tool-glyph">H3</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('四级标题')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(4)}
          >
            <span className="tool-glyph">H4</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('正文段落')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.paragraph()}
          >
            <span className="tool-glyph">P</span>
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label={t('文字样式')}>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('粗体（⌘/Ctrl+B）')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.bold()}
          >
            <span className="tool-glyph is-bold">B</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('斜体（⌘/Ctrl+I）')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.italic()}
          >
            <span className="tool-glyph is-italic">I</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('删除线')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.strike()}
          >
            <span className="tool-glyph is-strike">S</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('行内代码')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.inlineCode()}
          >
            <Icon name="code" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('链接（⌘/Ctrl+K）')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLink}
          >
            <Icon name="link" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('清除格式')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.clear()}
          >
            <span className="tool-glyph">Tx</span>
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label={t('列表与引用')}>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('无序列表')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.list('ul')}
          >
            <Icon name="list" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('有序列表')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.list('ol')}
          >
            <span className="tool-glyph">1.</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('引用')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.quote()}
          >
            <Icon name="quote" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('分割线')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.divider()}
          >
            <Icon name="minus" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('代码块')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.codeBlock()}
          >
            <Icon name="file" size={15} />
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label={t('插入区块')}>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('图片')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('image')}
          >
            <Icon name="image" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('视频')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('video')}
          >
            <Icon name="video" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('嵌入网址')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('embed')}
          >
            <Icon name="external" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('表格')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('table')}
          >
            <Icon name="table" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('分栏')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('columns')}
          >
            <Icon name="columns" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('图标')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('icon')}
          >
            <Icon name="bulb" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('图集')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('gallery')}
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('提示卡片')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commands.insert(tipBlock())}
          >
            <Icon name="info" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('警告卡片')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commands.insert(warningBlock())}
          >
            <Icon name="alert" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('折叠文本')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commands.insert(collapseBlock())}
          >
            <Icon name="chevron-down" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('数学公式')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openFormula}
          >
            <span className="tool-glyph">∑</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('图表（思维导图 / 逻辑图 / 统计图 / 鱼骨图）')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openDiagram}
          >
            <Icon name="chart" size={15} />
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label={t('撤销')}>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('撤销（⌘/Ctrl+Z）')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.undo()}
          >
            <span className="tool-glyph">↶</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title={t('重做')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.redo()}
          >
            <span className="tool-glyph">↷</span>
          </button>
        </div>
      </div>

      <p className="rich-toolbar-hint">
        {t(
          '选中文字后再点格式按钮；也可以直接输入 Markdown（`# ` 标题、`- ` 列表、`> ` 引用、`**粗体**`）， 或在新段落输入 / 打开指令面板。',
        )}{' '}
        {t('也可以直接粘贴或拖入图片，上传后插入正文。')}
      </p>

      <LinkDialog
        open={linkOpen}
        mode={linkMode}
        href={linkHref}
        text={linkText}
        title={linkTitle}
        description={linkDescription}
        cover={linkCover}
        onMode={setLinkMode}
        onHref={setLinkHref}
        onText={setLinkText}
        onTitle={setLinkTitle}
        onDescription={setLinkDescription}
        onCover={setLinkCover}
        onClose={() => setLinkOpen(false)}
        onConfirm={() => {
          if (linkMode === 'card') {
            commands.insert(
              linkCardBlock({
                url: linkHref.trim(),
                title: linkTitle.trim(),
                description: linkDescription.trim(),
                cover: linkCover.trim(),
              }),
            );
          } else {
            commands.link(linkHref.trim(), linkText.trim());
          }
          setLinkOpen(false);
          setLinkText('');
        }}
      />

      <ImageDialog
        open={dialog === 'image'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <MediaPickDialog
        open={dialog === 'gallery'}
        onClose={() => setDialog(null)}
        onInsert={(urls) => insert(galleryBlock(3, urls))}
      />

      <VideoDialog
        open={dialog === 'video'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <EmbedDialog
        open={dialog === 'embed'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <TableDialog
        open={dialog === 'table'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <ColumnsDialog
        open={dialog === 'columns'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <IconDialog
        open={dialog === 'icon'}
        onClose={() => setDialog(null)}
        onInsert={(snippet) => insert(snippet)}
      />

      <FormulaDialog
        open={dialog === 'formula'}
        mode={formulaMode}
        source={formulaSource}
        onMode={(mode) => setFormulaMode(mode)}
        onSource={setFormulaSource}
        onClose={() => setDialog(null)}
        onInsert={() => {
          commands.formula(formulaSource, formulaMode === 'block');
          setDialog(null);
          setFormulaSource('');
        }}
      />

      <DiagramDialog
        open={dialog === 'diagram'}
        initial={diagramInitial}
        onClose={() => {
          setDialog(null);
          diagramReplace.current = null;
        }}
        onInsert={(html) => {
          const replace = diagramReplace.current;
          diagramReplace.current = null;
          setDiagramInitial(null);
          setDialog(null);
          if (replace) replace(html);
          else commands.insert(html);
        }}
      />
    </div>
  );
}

/* ------------------------------- 对话框 ------------------------------- */

function LinkDialog({
  open,
  mode,
  href,
  text,
  title,
  description,
  cover,
  onMode,
  onHref,
  onText,
  onTitle,
  onDescription,
  onCover,
  onClose,
  onConfirm,
}: {
  open: boolean;
  mode: 'text' | 'card';
  href: string;
  text: string;
  title: string;
  description: string;
  cover: string;
  onMode: (mode: 'text' | 'card') => void;
  onHref: (value: string) => void;
  onText: (value: string) => void;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onCover: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const card = mode === 'card';
  const valid = /^https?:\/\/.+/.test(href.trim());
  const submit = () => {
    if (valid) onConfirm();
  };

  return (
    <Modal
      open={open}
      title={card ? t('插入链接卡片') : t('插入链接')}
      description={
        card
          ? t('卡片链接会显示封面、标题与说明，适合推荐站外文章。')
          : t('有选中文字时直接包住它们；没有选中就用下面的文字。')
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={submit} disabled={!valid}>
            {card ? t('插入卡片') : t('插入链接')}
          </Button>
        </>
      }
    >
      <div
        className="form-stack"
        onKeyDown={(event) => {
          // 输入框里回车直接提交；焦点在按钮 / 分段选择器上时交给默认行为。
          if (event.key !== 'Enter') return;
          if ((event.target as HTMLElement).tagName !== 'INPUT') return;
          event.preventDefault();
          submit();
        }}
      >
        <div className="link-mode-switch" role="group" aria-label={t('链接形态')}>
          <button
            type="button"
            className={`link-mode-btn${card ? '' : ' is-on'}`}
            aria-pressed={!card}
            onClick={() => onMode('text')}
          >
            {t('文字链接')}
          </button>
          <button
            type="button"
            className={`link-mode-btn${card ? ' is-on' : ''}`}
            aria-pressed={card}
            onClick={() => onMode('card')}
          >
            {t('卡片链接')}
          </button>
        </div>

        <Field label={t('网址')} htmlFor="rich-link-href" hint={t('只接受 http / https。')}>
          <Input
            id="rich-link-href"
            value={href}
            onChange={(event) => onHref(event.target.value)}
            placeholder="https://example.com"
            autoFocus
          />
        </Field>

        {card ? (
          <>
            <Field label={t('标题')} htmlFor="rich-link-title" hint={t('留空时显示网址域名。')}>
              <Input
                id="rich-link-title"
                value={title}
                onChange={(event) => onTitle(event.target.value)}
                placeholder={t('文章标题')}
              />
            </Field>
            <Field label={t('说明')} htmlFor="rich-link-desc" hint={t('可选，显示在域名后面。')}>
              <Input
                id="rich-link-desc"
                value={description}
                onChange={(event) => onDescription(event.target.value)}
                placeholder={t('一句话说明')}
              />
            </Field>
            <Field
              label={t('封面地址（可选）')}
              htmlFor="rich-link-cover"
              hint={t('留空时用域名占位图。')}
            >
              <Input
                id="rich-link-cover"
                value={cover}
                onChange={(event) => onCover(event.target.value)}
                placeholder="https://example.com/cover.jpg"
              />
            </Field>
            {valid ? (
              <div
                className="pp-linkcard-preview"
                onClick={(event) => event.preventDefault()}
                // 卡片 HTML 在 linkCardBlock 里已统一转义，可安全预览。
                dangerouslySetInnerHTML={{
                  __html: linkCardBlock({
                    url: href.trim(),
                    title: title.trim(),
                    description: description.trim(),
                    cover: cover.trim(),
                  }),
                }}
              />
            ) : (
              <p className="field-hint">{t('填写网址后会在这里显示卡片预览。')}</p>
            )}
          </>
        ) : (
          <Field
            label={t('显示文字')}
            htmlFor="rich-link-text"
            hint={t('没有选中文字时使用；留空则显示网址。')}
          >
            <Input
              id="rich-link-text"
              value={text}
              onChange={(event) => onText(event.target.value)}
              placeholder={t('链接文字')}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function FormulaDialog({
  open,
  mode,
  source,
  onMode,
  onSource,
  onClose,
  onInsert,
}: {
  open: boolean;
  mode: 'inline' | 'block';
  source: string;
  onMode: (mode: 'inline' | 'block') => void;
  onSource: (source: string) => void;
  onClose: () => void;
  onInsert: () => void;
}) {
  const t = useT();
  const value = source.trim();
  return (
    <Modal
      open={open}
      title={t('插入数学公式')}
      description={t('使用纯文本输入公式；保存时会保留为 $...$ 或 $$...$$ Markdown 语法。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button disabled={!value} onClick={onInsert}>
            {t('插入公式')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label={t('公式类型')} htmlFor="rich-formula-mode">
          <Select
            id="rich-formula-mode"
            value={mode}
            onChange={(event) => onMode(event.target.value === 'block' ? 'block' : 'inline')}
          >
            <option value="inline">{t('行内公式（$...$）')}</option>
            <option value="block">{t('块级公式（$$...$$）')}</option>
          </Select>
        </Field>
        <Field
          label={t('公式内容')}
          htmlFor="rich-formula-source"
          hint={t('当前版本保留公式原文，不加载额外公式渲染库。')}
        >
          {mode === 'block' ? (
            <Textarea
              id="rich-formula-source"
              value={source}
              onChange={(event) => onSource(event.target.value)}
              placeholder="x^2 + y^2 = z^2"
              autoFocus
              style={{ minHeight: 88, fontFamily: 'var(--mono)' }}
            />
          ) : (
            <Input
              id="rich-formula-source"
              value={source}
              onChange={(event) => onSource(event.target.value)}
              placeholder="v = s/t"
              autoFocus
              style={{ fontFamily: 'var(--mono)' }}
            />
          )}
        </Field>
        <div>
          <Badge tone="muted">{t('预览')}</Badge>
          {value ? (
            mode === 'block' ? (
              <p className="pp-math-block mt-8">{value}</p>
            ) : (
              <p className="mt-8">
                {t('公式：')}
                <span className="pp-math-inline">{value}</span>
              </p>
            )
          ) : (
            <p className="field-hint mt-8">{t('输入公式后会在这里显示安全文本预览。')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 素材缩略图走带鉴权的 blob：content 素材用 `<img src>` 匿名读会被挡成 404。 */
function AssetThumb({ asset }: { asset: Asset }) {
  const { src } = useMediaSrc(asset.url ?? '');
  return <img src={src || undefined} alt={asset.file_name ?? ''} />;
}

function MediaPicker({ onPick }: { onPick: (url: string) => void }) {
  const t = useT();
  const backend = useBackend();
  const assets = useAsync(async () => backend.listAssets(), [backend]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [fileRef, setFileRef] = useState<HTMLInputElement | null>(null);

  // This picker inserts an image URL into an image block, so videos stay out of it;
  // videos are inserted from the video dialog instead.
  const imageAssets = (assets.data ?? []).filter((asset: Asset) => asset.mime_type.startsWith('image/'));

  const upload = async (file: File) => {
    setError('');
    setProgress(0);
    try {
      const asset = await backend.upload(file, 'content', (percent) => setProgress(percent));
      assets.reload();
      if (asset.url) onPick(asset.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('上传失败。'));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="media-picker">
      {assets.error ? (
        <Callout tone="warn" icon="alert" title={t('素材列表没能载入')}>
          {t('仍然可以直接填写图片地址。')}
        </Callout>
      ) : null}
      <div className="media-grid">
        {imageAssets.map((asset: Asset) => (
          <button
            key={asset.id}
            type="button"
            className="media-cell"
            onClick={() => asset.url && onPick(asset.url)}
            title={asset.file_name ?? asset.id}
          >
            {asset.url ? <AssetThumb asset={asset} /> : <Icon name="file" size={18} />}
            <span>{asset.file_name ?? asset.storage_key}</span>
          </button>
        ))}
        {imageAssets.length === 0 && !assets.loading ? (
          <p className="tiny faint">{t('还没有上传过素材。')}</p>
        ) : null}
      </div>
      <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
        <Button
          variant="secondary"
          size="sm"
          icon="upload"
          loading={progress !== null}
          onClick={() => fileRef?.click()}
        >
          {progress === null ? t('上传图片') : t('上传中 {percent}%', { percent: progress })}
        </Button>
        <span className="tiny faint">{t('支持 PNG / JPEG / WebP / GIF，单张不超过 10 MB。')}</span>
      </div>
      <input
        ref={setFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      {error ? (
        <p className="field-hint" style={{ color: 'var(--danger, #b4322b)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ImageDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [href, setHref] = useState('');

  useEffect(() => {
    if (open) {
      setSrc('');
      setAlt('');
      setCaption('');
      setHref('');
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title={t('插入图片')}
      description={t('从素材库选一张，或者直接填写图片地址。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            disabled={!/^https?:\/\/|^data:image\//.test(src)}
            onClick={() => onInsert(imageBlock({ src, alt, caption, href }))}
          >
            {t('插入图片')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <MediaPicker onPick={setSrc} />
        <Field label={t('图片地址')} htmlFor="rich-image-src" hint={t('也可以粘贴外链。')}>
          <Input
            id="rich-image-src"
            value={src}
            onChange={(event) => setSrc(event.target.value)}
            placeholder="https://example.com/photo.jpg"
          />
        </Field>
        {src ? <img className="media-preview" src={src} alt="" /> : null}
        <div className="form-grid">
          <Field
            label={t('替代文字')}
            htmlFor="rich-image-alt"
            hint={t('读屏软件与图片加载失败时显示。')}
          >
            <Input id="rich-image-alt" value={alt} onChange={(event) => setAlt(event.target.value)} />
          </Field>
          <Field label={t('图注')} htmlFor="rich-image-caption">
            <Input
              id="rich-image-caption"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder={t('可选')}
            />
          </Field>
        </div>
        <Field label={t('点击跳转（可选）')} htmlFor="rich-image-href">
          <Input
            id="rich-image-href"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            placeholder="https://example.com"
          />
        </Field>
      </div>
    </Modal>
  );
}

function MediaPickDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (urls: string[]) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);

  return (
    <Modal
      open={open}
      title={t('插入图集')}
      description={t('按顺序选择三张图片，插成一行三列。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button disabled={picked.length === 0} onClick={() => onInsert(picked)}>
            {t('插入 {count} 张', { count: picked.length || '' })}
          </Button>
        </>
      }
    >
      <MediaPicker
        onPick={(url) =>
          setPicked((prev) => (prev.includes(url) || prev.length >= 3 ? prev : [...prev, url]))
        }
      />
      {picked.length ? (
        <div className="media-picked">
          {picked.map((url) => (
            <img key={url} src={url} alt="" />
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function VideoDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [poster, setPoster] = useState('');
  const [provider, setProvider] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setTitle('');
      setPoster('');
      setProvider('');
      setUploading(false);
      setProgress(0);
      setUploadError('');
    }
  }, [open]);

  const uploadVideo = async (file: File) => {
    setUploadError('');
    setUploading(true);
    setProgress(0);
    try {
      const asset = await backend.upload(file, 'content', setProgress);
      const src = asset.url ?? `/api/v1/media/${asset.id}`;
      setUrl(src);
      setProvider(t('站内视频'));
      if (!title.trim()) setTitle(asset.file_name ?? '');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t('上传失败。'));
    } finally {
      setUploading(false);
      setProgress(0);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const canInsert =
    /^https?:\/\/.+/.test(url.trim()) ||
    /^\/api\/v1\/media\//.test(url.trim()) ||
    /^data:video\//.test(url.trim());

  return (
    <Modal
      open={open}
      title={t('插入视频')}
      description={t(
        'YouTube 与 Bilibili 会以内嵌播放器显示；上传到本站的视频直接播放。其他平台保留为封面卡片。',
      )}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            disabled={!canInsert}
            onClick={() => onInsert(videoBlock({ url: url.trim(), title, poster, provider }))}
          >
            {t('插入视频')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field
          label={t('上传本地视频')}
          hint={t('MP4 / WebM；单次上限与用户额度由「储存设置」决定。')}
        >
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="video/mp4,video/webm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadVideo(file);
              }}
            />
            <Button
              variant="secondary"
              icon="upload"
              loading={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {t('选择视频文件')}
            </Button>
            {uploading ? (
              <div style={{ flex: 1 }}>
                <Progress value={progress} />
              </div>
            ) : null}
          </div>
          {uploadError ? <p className="small" style={{ color: 'var(--danger)' }}>{uploadError}</p> : null}
        </Field>
        <Field
          label={t('视频地址')}
          htmlFor="rich-video-url"
          hint={t('YouTube / Bilibili 链接，或上传后填入的站内视频地址。')}
        >
          <Input
            id="rich-video-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.bilibili.com/video/BV..."
            autoFocus
          />
        </Field>
        <Field label={t('标题')} htmlFor="rich-video-title">
          <Input id="rich-video-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <div className="form-grid">
          <Field
            label={t('封面地址（可选）')}
            htmlFor="rich-video-poster"
            hint={t('YouTube 会自动推导。')}
          >
            <Input id="rich-video-poster" value={poster} onChange={(event) => setPoster(event.target.value)} />
          </Field>
          <Field label={t('平台名称（可选）')} htmlFor="rich-video-provider">
            <Input
              id="rich-video-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="Bilibili"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function EmbedDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setTitle('');
      setDescription('');
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title={t('嵌入网址')}
      description={t('生成一张链接卡片：标题 + 来源域名，点击跳转。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            disabled={!/^https?:\/\/.+/.test(url.trim())}
            onClick={() => onInsert(embedBlock({ url: url.trim(), title, description }))}
          >
            {t('插入卡片')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label={t('网址')} htmlFor="rich-embed-url">
          <Input
            id="rich-embed-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/article"
            autoFocus
          />
        </Field>
        <Field label={t('标题')} htmlFor="rich-embed-title">
          <Input id="rich-embed-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t('说明')} htmlFor="rich-embed-desc" hint={t('留空时显示域名。')}>
          <Input id="rich-embed-desc" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function TableDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);

  return (
    <Modal
      open={open}
      title={t('插入表格')}
      description={t('插入后可以直接点单元格改文字，Tab 跳到下一格。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={() => onInsert(tableBlock({ rows, cols, header }))}>{t('插入表格')}</Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('列数')} htmlFor="rich-table-cols">
          <Input
            id="rich-table-cols"
            type="number"
            min={1}
            max={8}
            value={cols}
            onChange={(event) => setCols(Number(event.target.value))}
          />
        </Field>
        <Field label={t('行数')} htmlFor="rich-table-rows">
          <Input
            id="rich-table-rows"
            type="number"
            min={1}
            max={20}
            value={rows}
            onChange={(event) => setRows(Number(event.target.value))}
          />
        </Field>
      </div>
      <label className="check-row mt-12">
        <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />
        <span>{t('第一行作为表头')}</span>
      </label>
    </Modal>
  );
}

function ColumnsDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const [count, setCount] = useState<2 | 3>(2);
  const [texts, setTexts] = useState<string[]>(['', '', '']);

  return (
    <Modal
      open={open}
      title={t('插入分栏')}
      description={t('两栏或三栏并排，每栏可以继续写标题、图片与列表。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={() => onInsert(columnsBlock(count, texts.filter(Boolean)))}>
            {t('插入分栏')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label={t('栏数')} htmlFor="rich-columns-count">
          <Select
            id="rich-columns-count"
            value={String(count)}
            onChange={(event) => setCount(Number(event.target.value) === 3 ? 3 : 2)}
          >
            <option value="2">{t('两栏')}</option>
            <option value="3">{t('三栏')}</option>
          </Select>
        </Field>
        {Array.from({ length: count }, (_, index) => (
          <Field
            key={index}
            label={t('第 {index} 栏', { index: index + 1 })}
            htmlFor={`rich-column-${index}`}
          >
            <Textarea
              id={`rich-column-${index}`}
              value={texts[index] ?? ''}
              onChange={(event) =>
                setTexts((prev) => {
                  const next = [...prev];
                  next[index] = event.target.value;
                  return next;
                })
              }
              style={{ minHeight: 56 }}
              placeholder={t('第 {index} 栏的内容', { index: index + 1 })}
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function IconDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}) {
  const t = useT();
  const [id, setId] = useState(RICH_ICONS[0].id);
  const [label, setLabel] = useState('');

  return (
    <Modal
      open={open}
      title={t('插入图标')}
      description={t('图标用字符 + CSS 呈现，不额外加载图标字体。')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={() => onInsert(iconBlock(id, label))}>{t('插入图标')}</Button>
        </>
      }
    >
      <div className="icon-picker">
        {RICH_ICONS.map((icon) => (
          <button
            key={icon.id}
            type="button"
            className={`icon-cell${id === icon.id ? ' is-on' : ''}`}
            onClick={() => setId(icon.id)}
            title={icon.label}
          >
            <i className={`pp-icon pp-icon-${icon.id}`} />
            <span>{icon.label}</span>
          </button>
        ))}
      </div>
      <Field label={t('图标后的文字（可选）')} htmlFor="rich-icon-label">
        <Input
          id="rich-icon-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t('例如：每周更新')}
        />
      </Field>
      <div className="mt-12">
        <Badge tone="muted">{t('预览')}</Badge>
        <p className="pp-icon-line mt-8">
          <i className={`pp-icon pp-icon-${id}`} /> {label || RICH_ICONS.find((item) => item.id === id)?.label}
        </p>
      </div>
    </Modal>
  );
}
