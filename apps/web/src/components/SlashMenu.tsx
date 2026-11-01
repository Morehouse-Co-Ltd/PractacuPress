import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorDialogKind } from './RichTextEditor';

/**
 * 斜杠指令面板。
 *
 * 在空段落里输入 `/` 后弹出，固定定位在光标下方。简单指令直接操作当前块
 * （标题 / 列表 / 引用 / 代码 / 分割线 / 提示框），需要参数的指令转交工具栏
 * 现有弹窗（图片 / 视频 / 表格 / 分栏 / 公式 / 链接），不重写这些弹窗。
 *
 * 键盘事件挂在 document 捕获阶段：这样 ↑↓ / Enter / Esc 在编辑器自己处理之前
 * 就被面板接管，不会把回车变成换行。
 */

export type SlashCommand =
  | {
      type: 'command';
      command:
        | 'h2'
        | 'h3'
        | 'h4'
        | 'ul'
        | 'ol'
        | 'quote'
        | 'code'
        | 'divider'
        | 'note';
    }
  | { type: 'dialog'; dialog: EditorDialogKind };

export interface SlashItem {
  id: string;
  label: string;
  /** 面板里的次要说明，也参与过滤。 */
  hint: string;
  glyph: string;
  /** 英文 / 拼音关键词，方便用 /h2、/biaoti 这类输入过滤。 */
  keywords: string[];
  action: SlashCommand;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h2',
    label: '标题 2',
    hint: '二级标题',
    glyph: 'H2',
    keywords: ['title', 'heading', 'biaoti', 'h2'],
    action: { type: 'command', command: 'h2' },
  },
  {
    id: 'h3',
    label: '标题 3',
    hint: '三级标题',
    glyph: 'H3',
    keywords: ['title', 'heading', 'biaoti', 'h3'],
    action: { type: 'command', command: 'h3' },
  },
  {
    id: 'h4',
    label: '标题 4',
    hint: '四级标题',
    glyph: 'H4',
    keywords: ['title', 'heading', 'biaoti', 'h4'],
    action: { type: 'command', command: 'h4' },
  },
  {
    id: 'ul',
    label: '无序列表',
    hint: '项目符号列表',
    glyph: '•',
    keywords: ['list', 'bullet', 'wuxu', 'ul', 'liebiao'],
    action: { type: 'command', command: 'ul' },
  },
  {
    id: 'ol',
    label: '有序列表',
    hint: '带编号的列表',
    glyph: '1.',
    keywords: ['list', 'ordered', 'youxu', 'ol', 'liebiao'],
    action: { type: 'command', command: 'ol' },
  },
  {
    id: 'quote',
    label: '引用',
    hint: '引用一段话',
    glyph: '❝',
    keywords: ['quote', 'blockquote', 'yinyong'],
    action: { type: 'command', command: 'quote' },
  },
  {
    id: 'code',
    label: '代码块',
    hint: '等宽字体代码段',
    glyph: '</>',
    keywords: ['code', 'pre', 'daima'],
    action: { type: 'command', command: 'code' },
  },
  {
    id: 'divider',
    label: '分割线',
    hint: '一条水平分隔线',
    glyph: '—',
    keywords: ['divider', 'hr', 'separator', 'fengexian'],
    action: { type: 'command', command: 'divider' },
  },
  {
    id: 'note',
    label: '提示框',
    hint: '带强调边的说明块',
    glyph: '!',
    keywords: ['note', 'callout', 'tishi', 'tishiikuang'],
    action: { type: 'command', command: 'note' },
  },
  {
    id: 'image',
    label: '图片',
    hint: '从素材库选择或填地址',
    glyph: '▣',
    keywords: ['image', 'picture', 'tupian'],
    action: { type: 'dialog', dialog: 'image' },
  },
  {
    id: 'video',
    label: '视频',
    hint: '生成封面卡片',
    glyph: '▶',
    keywords: ['video', 'shipin'],
    action: { type: 'dialog', dialog: 'video' },
  },
  {
    id: 'table',
    label: '表格',
    hint: '插入行列表格',
    glyph: '▦',
    keywords: ['table', 'biaoge'],
    action: { type: 'dialog', dialog: 'table' },
  },
  {
    id: 'columns',
    label: '分栏',
    hint: '两栏或三栏布局',
    glyph: '◫',
    keywords: ['columns', 'layout', 'fenlan'],
    action: { type: 'dialog', dialog: 'columns' },
  },
  {
    id: 'formula',
    label: '公式',
    hint: '行内或块级公式',
    glyph: '∑',
    keywords: ['formula', 'math', 'gongshi'],
    action: { type: 'dialog', dialog: 'formula' },
  },
  {
    id: 'link',
    label: '链接',
    hint: '文字链接或链接卡片',
    glyph: '↗',
    keywords: ['link', 'url', 'lianjie'],
    action: { type: 'dialog', dialog: 'link' },
  },
];

/** 按 `/` 后面的文字过滤指令；空查询显示全部。 */
export function filterSlashItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => {
    return (
      item.label.toLowerCase().includes(needle) ||
      item.hint.toLowerCase().includes(needle) ||
      item.id.includes(needle) ||
      item.keywords.some((keyword) => keyword.toLowerCase().includes(needle))
    );
  });
}

export interface SlashMenuProps {
  open: boolean;
  /** `/` 之后已经输入的文字，用来过滤。 */
  query: string;
  /** 相对视口的固定定位坐标（来自光标 getBoundingClientRect）。 */
  position: { left: number; top: number } | null;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  /** 把当前高亮项 id 回传编辑器，用于 aria-activedescendant。 */
  onActiveItemChange?: (id: string | null) => void;
}

export function SlashMenu({
  open,
  query,
  position,
  onSelect,
  onClose,
  onActiveItemChange,
}: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const items = useMemo(() => filterSlashItems(query), [query]);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const activeItem = items[activeIndex];

  // 键盘 / 鼠标监听里要读到最新的候选与高亮，用 ref 避免频繁重挂监听。
  const stateRef = useRef({ items, activeIndex });
  stateRef.current = { items, activeIndex };
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 换了查询条件就把高亮收回第一项。
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    onActiveItemChange?.(activeItem ? `pp-slash-${activeItem.id}` : null);
  }, [activeItem, onActiveItemChange]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const { items: currentItems, activeIndex: currentActive } = stateRef.current;
      const handled =
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === 'Escape' ||
        event.key === 'Tab';
      if (!handled) return;
      // 面板打开时这些键归面板所有：不然回车会换行、方向键会移动光标。
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key === 'ArrowDown') {
        if (currentItems.length) setActive((currentActive + 1) % currentItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        if (currentItems.length) {
          setActive((currentActive - 1 + currentItems.length) % currentItems.length);
        }
        return;
      }
      // Enter / Tab：插入当前高亮项；没有候选时交给浏览器默认行为。
      if (!currentItems.length) return;
      const item = currentItems[currentActive];
      if (item) selectRef.current(item);
    };

    const onPointerDown = (event: MouseEvent) => {
      if (listRef.current?.contains(event.target as Node)) return;
      closeRef.current();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={listRef}
      id="pp-slash-menu"
      className="slash-menu"
      role="listbox"
      aria-label="插入指令"
      aria-activedescendant={activeItem ? `pp-slash-${activeItem.id}` : undefined}
      style={{ left: position?.left ?? 12, top: position?.top ?? 12 }}
    >
      <p className="slash-menu-head">插入</p>
      {items.length === 0 ? (
        <p className="slash-menu-empty">没有匹配的指令</p>
      ) : (
        <div className="slash-menu-list">
          {items.map((item, index) => (
            <button
              key={item.id}
              id={`pp-slash-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`slash-menu-item${index === activeIndex ? ' is-active' : ''}`}
              onMouseDown={(event) => {
                // 保持编辑器选区：不 preventDefault 的话焦点会先跑到按钮上。
                event.preventDefault();
                selectRef.current(item);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="slash-menu-glyph" aria-hidden>
                {item.glyph}
              </span>
              <span className="slash-menu-text">
                <span className="slash-menu-label">{item.label}</span>
                <span className="slash-menu-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="slash-menu-foot">↑↓ 选择 · Enter 插入 · Esc 关闭</p>
    </div>
  );
}
