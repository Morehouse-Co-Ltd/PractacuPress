import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../types';
import { useBackend } from '../lib/backend';
import { useAsync } from '../lib/hooks';
import {
  RICH_ICONS,
  columnsBlock,
  embedBlock,
  galleryBlock,
  iconBlock,
  imageBlock,
  linkCardBlock,
  noteBlock,
  tableBlock,
  videoBlock,
} from '../lib/richBlocks';
import { Badge, Button, Callout, Field, Input, Modal, Select, Textarea } from './ui';
import { Icon } from './Icon';
import type { EditorCommands, EditorDialogKind } from './RichTextEditor';

/**
 * 富文本工具栏。
 *
 * 所有按钮都作用于 contenteditable 的当前选区：格式类走 execCommand，区块类插入
 * 白名单内的 HTML（见 lib/richBlocks）。打开弹窗之前先记住选区，否则输入框一聚焦，
 * 插入位置就丢了。
 */

type Dialog = 'image' | 'video' | 'embed' | 'table' | 'columns' | 'icon' | 'gallery' | 'formula' | null;

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
    <div className="rich-toolbar" role="toolbar" aria-label="写作工具">
      <div className="rich-toolbar-row">
        <div className="tool-group" aria-label="标题">
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="二级标题"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(2)}
          >
            <span className="tool-glyph">H2</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="三级标题"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(3)}
          >
            <span className="tool-glyph">H3</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="四级标题"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.heading(4)}
          >
            <span className="tool-glyph">H4</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="正文段落"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.paragraph()}
          >
            <span className="tool-glyph">P</span>
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label="文字样式">
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="粗体（⌘/Ctrl+B）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.bold()}
          >
            <span className="tool-glyph is-bold">B</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="斜体（⌘/Ctrl+I）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.italic()}
          >
            <span className="tool-glyph is-italic">I</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="删除线"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.strike()}
          >
            <span className="tool-glyph is-strike">S</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="行内代码"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.inlineCode()}
          >
            <Icon name="code" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="链接（⌘/Ctrl+K）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLink}
          >
            <Icon name="link" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="清除格式"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.clear()}
          >
            <span className="tool-glyph">Tx</span>
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label="列表与引用">
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="无序列表"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.list('ul')}
          >
            <Icon name="list" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="有序列表"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.list('ol')}
          >
            <span className="tool-glyph">1.</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="引用"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.quote()}
          >
            <Icon name="quote" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="分割线"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.divider()}
          >
            <Icon name="minus" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="代码块"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.codeBlock()}
          >
            <Icon name="file" size={15} />
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label="插入区块">
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="图片"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('image')}
          >
            <Icon name="image" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="视频"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('video')}
          >
            <Icon name="video" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="嵌入网址"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('embed')}
          >
            <Icon name="external" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="表格"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('table')}
          >
            <Icon name="table" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="分栏"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('columns')}
          >
            <Icon name="columns" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="图标"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('icon')}
          >
            <Icon name="bulb" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="图集"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open('gallery')}
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="提示框"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commands.insert(noteBlock('info'))}
          >
            <Icon name="info" size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="数学公式"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openFormula}
          >
            <span className="tool-glyph">∑</span>
          </button>
        </div>

        <span className="tool-sep" />

        <div className="tool-group" aria-label="撤销">
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="撤销（⌘/Ctrl+Z）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.undo()}
          >
            <span className="tool-glyph">↶</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={disabled}
            title="重做"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commands.redo()}
          >
            <span className="tool-glyph">↷</span>
          </button>
        </div>
      </div>

      <p className="rich-toolbar-hint">
        选中文字后再点格式按钮；也可以直接输入 Markdown（`# ` 标题、`- ` 列表、`&gt; ` 引用、`**粗体**`），
        或在新段落输入 / 打开指令面板。
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
  const card = mode === 'card';
  const valid = /^https?:\/\/.+/.test(href.trim());
  const submit = () => {
    if (valid) onConfirm();
  };

  return (
    <Modal
      open={open}
      title={card ? '插入链接卡片' : '插入链接'}
      description={
        card
          ? '卡片链接会显示封面、标题与说明，适合推荐站外文章。'
          : '有选中文字时直接包住它们；没有选中就用下面的文字。'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={!valid}>
            {card ? '插入卡片' : '插入链接'}
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
        <div className="link-mode-switch" role="group" aria-label="链接形态">
          <button
            type="button"
            className={`link-mode-btn${card ? '' : ' is-on'}`}
            aria-pressed={!card}
            onClick={() => onMode('text')}
          >
            文字链接
          </button>
          <button
            type="button"
            className={`link-mode-btn${card ? ' is-on' : ''}`}
            aria-pressed={card}
            onClick={() => onMode('card')}
          >
            卡片链接
          </button>
        </div>

        <Field label="网址" htmlFor="rich-link-href" hint="只接受 http / https。">
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
            <Field label="标题" htmlFor="rich-link-title" hint="留空时显示网址域名。">
              <Input
                id="rich-link-title"
                value={title}
                onChange={(event) => onTitle(event.target.value)}
                placeholder="文章标题"
              />
            </Field>
            <Field label="说明" htmlFor="rich-link-desc" hint="可选，显示在域名后面。">
              <Input
                id="rich-link-desc"
                value={description}
                onChange={(event) => onDescription(event.target.value)}
                placeholder="一句话说明"
              />
            </Field>
            <Field label="封面地址（可选）" htmlFor="rich-link-cover" hint="留空时用域名占位图。">
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
              <p className="field-hint">填写网址后会在这里显示卡片预览。</p>
            )}
          </>
        ) : (
          <Field
            label="显示文字"
            htmlFor="rich-link-text"
            hint="没有选中文字时使用；留空则显示网址。"
          >
            <Input
              id="rich-link-text"
              value={text}
              onChange={(event) => onText(event.target.value)}
              placeholder="链接文字"
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
  const value = source.trim();
  return (
    <Modal
      open={open}
      title="插入数学公式"
      description="使用纯文本输入公式；保存时会保留为 $...$ 或 $$...$$ Markdown 语法。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!value} onClick={onInsert}>
            插入公式
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="公式类型" htmlFor="rich-formula-mode">
          <Select
            id="rich-formula-mode"
            value={mode}
            onChange={(event) => onMode(event.target.value === 'block' ? 'block' : 'inline')}
          >
            <option value="inline">行内公式（$...$）</option>
            <option value="block">块级公式（$$...$$）</option>
          </Select>
        </Field>
        <Field
          label="公式内容"
          htmlFor="rich-formula-source"
          hint="当前版本保留公式原文，不加载额外公式渲染库。"
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
          <Badge tone="muted">预览</Badge>
          {value ? (
            mode === 'block' ? (
              <p className="pp-math-block mt-8">{value}</p>
            ) : (
              <p className="mt-8">
                公式：<span className="pp-math-inline">{value}</span>
              </p>
            )
          ) : (
            <p className="field-hint mt-8">输入公式后会在这里显示安全文本预览。</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MediaPicker({ onPick }: { onPick: (url: string) => void }) {
  const backend = useBackend();
  const assets = useAsync(async () => backend.listAssets(), [backend]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [fileRef, setFileRef] = useState<HTMLInputElement | null>(null);

  const upload = async (file: File) => {
    setError('');
    setProgress(0);
    try {
      const asset = await backend.upload(file, 'content', (percent) => setProgress(percent));
      assets.reload();
      if (asset.url) onPick(asset.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败。');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="media-picker">
      {assets.error ? (
        <Callout tone="warn" icon="alert" title="素材列表没能载入">
          仍然可以直接填写图片地址。
        </Callout>
      ) : null}
      <div className="media-grid">
        {(assets.data ?? []).map((asset: Asset) => (
          <button
            key={asset.id}
            type="button"
            className="media-cell"
            onClick={() => asset.url && onPick(asset.url)}
            title={asset.file_name ?? asset.id}
          >
            {asset.url ? <img src={asset.url} alt={asset.file_name ?? ''} /> : <Icon name="file" size={18} />}
            <span>{asset.file_name ?? asset.storage_key}</span>
          </button>
        ))}
        {(assets.data ?? []).length === 0 && !assets.loading ? (
          <p className="tiny faint">还没有上传过素材。</p>
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
          {progress === null ? '上传图片' : `上传中 ${progress}%`}
        </Button>
        <span className="tiny faint">支持 PNG / JPEG / WebP / GIF，单张不超过 10 MB。</span>
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
      title="插入图片"
      description="从素材库选一张，或者直接填写图片地址。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!/^https?:\/\/|^data:image\//.test(src)}
            onClick={() => onInsert(imageBlock({ src, alt, caption, href }))}
          >
            插入图片
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <MediaPicker onPick={setSrc} />
        <Field label="图片地址" htmlFor="rich-image-src" hint="也可以粘贴外链。">
          <Input
            id="rich-image-src"
            value={src}
            onChange={(event) => setSrc(event.target.value)}
            placeholder="https://example.com/photo.jpg"
          />
        </Field>
        {src ? <img className="media-preview" src={src} alt="" /> : null}
        <div className="form-grid">
          <Field label="替代文字" htmlFor="rich-image-alt" hint="读屏软件与图片加载失败时显示。">
            <Input id="rich-image-alt" value={alt} onChange={(event) => setAlt(event.target.value)} />
          </Field>
          <Field label="图注" htmlFor="rich-image-caption">
            <Input
              id="rich-image-caption"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="可选"
            />
          </Field>
        </div>
        <Field label="点击跳转（可选）" htmlFor="rich-image-href">
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
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);

  return (
    <Modal
      open={open}
      title="插入图集"
      description="按顺序选择三张图片，插成一行三列。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={picked.length === 0} onClick={() => onInsert(picked)}>
            插入 {picked.length || ''} 张
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
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [poster, setPoster] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setTitle('');
      setPoster('');
      setProvider('');
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title="插入视频"
      description="视频以封面卡片呈现，点击到原站播放。正文不允许 iframe，这是有意的安全取舍。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!/^https?:\/\/.+/.test(url.trim())}
            onClick={() => onInsert(videoBlock({ url: url.trim(), title, poster, provider }))}
          >
            插入视频
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="视频地址" htmlFor="rich-video-url" hint="YouTube / Bilibili / Vimeo 或任意页面。">
          <Input
            id="rich-video-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.bilibili.com/video/BV..."
            autoFocus
          />
        </Field>
        <Field label="标题" htmlFor="rich-video-title">
          <Input id="rich-video-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="封面地址（可选）" htmlFor="rich-video-poster" hint="YouTube 会自动推导。">
            <Input id="rich-video-poster" value={poster} onChange={(event) => setPoster(event.target.value)} />
          </Field>
          <Field label="平台名称（可选）" htmlFor="rich-video-provider">
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
      title="嵌入网址"
      description="生成一张链接卡片：标题 + 来源域名，点击跳转。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!/^https?:\/\/.+/.test(url.trim())}
            onClick={() => onInsert(embedBlock({ url: url.trim(), title, description }))}
          >
            插入卡片
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="网址" htmlFor="rich-embed-url">
          <Input
            id="rich-embed-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/article"
            autoFocus
          />
        </Field>
        <Field label="标题" htmlFor="rich-embed-title">
          <Input id="rich-embed-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="说明" htmlFor="rich-embed-desc" hint="留空时显示域名。">
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
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);

  return (
    <Modal
      open={open}
      title="插入表格"
      description="插入后可以直接点单元格改文字，Tab 跳到下一格。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onInsert(tableBlock({ rows, cols, header }))}>插入表格</Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="列数" htmlFor="rich-table-cols">
          <Input
            id="rich-table-cols"
            type="number"
            min={1}
            max={8}
            value={cols}
            onChange={(event) => setCols(Number(event.target.value))}
          />
        </Field>
        <Field label="行数" htmlFor="rich-table-rows">
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
        <span>第一行作为表头</span>
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
  const [count, setCount] = useState<2 | 3>(2);
  const [texts, setTexts] = useState<string[]>(['', '', '']);

  return (
    <Modal
      open={open}
      title="插入分栏"
      description="两栏或三栏并排，每栏可以继续写标题、图片与列表。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onInsert(columnsBlock(count, texts.filter(Boolean)))}>插入分栏</Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="栏数" htmlFor="rich-columns-count">
          <Select
            id="rich-columns-count"
            value={String(count)}
            onChange={(event) => setCount(Number(event.target.value) === 3 ? 3 : 2)}
          >
            <option value="2">两栏</option>
            <option value="3">三栏</option>
          </Select>
        </Field>
        {Array.from({ length: count }, (_, index) => (
          <Field key={index} label={`第 ${index + 1} 栏`} htmlFor={`rich-column-${index}`}>
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
              placeholder={`第 ${index + 1} 栏的内容`}
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
  const [id, setId] = useState(RICH_ICONS[0].id);
  const [label, setLabel] = useState('');

  return (
    <Modal
      open={open}
      title="插入图标"
      description="图标用字符 + CSS 呈现，不额外加载图标字体。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onInsert(iconBlock(id, label))}>插入图标</Button>
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
      <Field label="图标后的文字（可选）" htmlFor="rich-icon-label">
        <Input
          id="rich-icon-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="例如：每周更新"
        />
      </Field>
      <div className="mt-12">
        <Badge tone="muted">预览</Badge>
        <p className="pp-icon-line mt-8">
          <i className={`pp-icon pp-icon-${id}`} /> {label || RICH_ICONS.find((item) => item.id === id)?.label}
        </p>
      </div>
    </Modal>
  );
}
