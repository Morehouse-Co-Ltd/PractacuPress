import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { placeMenu } from '../lib/caretRect';
import type { CaretAnchor } from '../lib/caretRect';
import type { EditorDialogKind } from './RichTextEditor';

/**
 * 斜杠指令面板。
 *
 * 在空段落里输入 `/` 后弹出，贴在光标处。简单指令直接操作当前块
 * （标题 / 列表 / 引用 / 代码 / 分割线 / 提示框），需要参数的指令转交工具栏
 * 现有弹窗（图片 / 视频 / 表格 / 分栏 / 公式 / 链接 / 图表），不重写这些弹窗。
 *
 * 落点由面板自己算：父组件只给光标锚点，面板按自身尺寸决定放光标下方还是翻到上方，
 * 这样"面板多高"只有这里知道，不用在编辑器和面板之间来回传尺寸。
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

/** 取文案的函数；组件里传 `useT()` 的返回值。 */
type Translate = ReturnType<typeof useT>;

/**
 * 斜杠指令表。
 *
 * 文案在取值时才翻译：中文原文作 i18n 键，传进来的 `t` 决定显示哪种语言。
 * 所以这里是一个工厂而不是常量表——常量表在模块加载时就固定了语言。
 */
export function slashItems(t: Translate): SlashItem[] {
  return [
    {
      id: 'h2',
      label: t('标题 2'),
      hint: t('二级标题'),
      glyph: 'H2',
      keywords: ['title', 'heading', 'biaoti', 'h2'],
      action: { type: 'command', command: 'h2' },
    },
    {
      id: 'h3',
      label: t('标题 3'),
      hint: t('三级标题'),
      glyph: 'H3',
      keywords: ['title', 'heading', 'biaoti', 'h3'],
      action: { type: 'command', command: 'h3' },
    },
    {
      id: 'h4',
      label: t('标题 4'),
      hint: t('四级标题'),
      glyph: 'H4',
      keywords: ['title', 'heading', 'biaoti', 'h4'],
      action: { type: 'command', command: 'h4' },
    },
    {
      id: 'ul',
      label: t('无序列表'),
      hint: t('项目符号列表'),
      glyph: '•',
      keywords: ['list', 'bullet', 'wuxu', 'ul', 'liebiao'],
      action: { type: 'command', command: 'ul' },
    },
    {
      id: 'ol',
      label: t('有序列表'),
      hint: t('带编号的列表'),
      glyph: '1.',
      keywords: ['list', 'ordered', 'youxu', 'ol', 'liebiao'],
      action: { type: 'command', command: 'ol' },
    },
    {
      id: 'quote',
      label: t('引用'),
      hint: t('引用一段话'),
      glyph: '❝',
      keywords: ['quote', 'blockquote', 'yinyong'],
      action: { type: 'command', command: 'quote' },
    },
    {
      id: 'code',
      label: t('代码块'),
      hint: t('等宽字体代码段'),
      glyph: '</>',
      keywords: ['code', 'pre', 'daima'],
      action: { type: 'command', command: 'code' },
    },
    {
      id: 'divider',
      label: t('分割线'),
      hint: t('一条水平分隔线'),
      glyph: '—',
      keywords: ['divider', 'hr', 'separator', 'fengexian'],
      action: { type: 'command', command: 'divider' },
    },
    {
      id: 'note',
      label: t('提示框'),
      hint: t('带强调边的说明块'),
      glyph: '!',
      keywords: ['note', 'callout', 'tishi', 'tishiikuang'],
      action: { type: 'command', command: 'note' },
    },
    {
      id: 'image',
      label: t('图片'),
      hint: t('从素材库选择或填地址'),
      glyph: '▣',
      keywords: ['image', 'picture', 'tupian'],
      action: { type: 'dialog', dialog: 'image' },
    },
    {
      id: 'video',
      label: t('视频'),
      hint: t('生成封面卡片'),
      glyph: '▶',
      keywords: ['video', 'shipin'],
      action: { type: 'dialog', dialog: 'video' },
    },
    {
      id: 'table',
      label: t('表格'),
      hint: t('插入行列表格'),
      glyph: '▦',
      keywords: ['table', 'biaoge'],
      action: { type: 'dialog', dialog: 'table' },
    },
    {
      id: 'columns',
      label: t('分栏'),
      hint: t('两栏或三栏布局'),
      glyph: '◫',
      keywords: ['columns', 'layout', 'fenlan'],
      action: { type: 'dialog', dialog: 'columns' },
    },
    {
      id: 'formula',
      label: t('公式'),
      hint: t('行内或块级公式'),
      glyph: '∑',
      keywords: ['formula', 'math', 'gongshi'],
      action: { type: 'dialog', dialog: 'formula' },
    },
    {
      id: 'diagram',
      label: t('图表'),
      hint: t('思维导图、逻辑图、统计图、鱼骨图'),
      glyph: '▤',
      keywords: ['diagram', 'chart', 'mindmap', 'tupu', 'siwei', 'yugu', 'tongji'],
      action: { type: 'dialog', dialog: 'diagram' },
    },
    {
      id: 'link',
      label: t('链接'),
      hint: t('文字链接或链接卡片'),
      glyph: '↗',
      keywords: ['link', 'url', 'lianjie'],
      action: { type: 'dialog', dialog: 'link' },
    },
  ];
}

/** 按 `/` 后面的文字过滤指令；空查询显示全部。 */
export function filterSlashItems(query: string, t: Translate): SlashItem[] {
  const items = slashItems(t);
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
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
  /** 光标锚点（视口坐标）；null 时退到视口左上角，属于兜底。 */
  anchor: CaretAnchor | null;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  /** 把当前高亮项 id 回传编辑器，用于 aria-activedescendant。 */
  onActiveItemChange?: (id: string | null) => void;
}

/** 挂载后一帧内会被真实尺寸纠正，先用估计值兜底免得首帧跳到屏幕上沿。 */
const ESTIMATED_SIZE = { width: 276, height: 330 };

export function SlashMenu({
  open,
  query,
  anchor,
  onSelect,
  onClose,
  onActiveItemChange,
}: SlashMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [size, setSize] = useState(ESTIMATED_SIZE);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // 指令表按当前语言生成：语言切换时 `t` 会让本组件重渲染，文案随之更新。
  const items = filterSlashItems(query, t);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const activeItem = items[activeIndex];
  const activeItemId = activeItem ? activeItem.id : null;

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

  // 只依赖 id：每次渲染都会重建指令表，用 id 比较才不会每帧都通知父组件。
  useEffect(() => {
    onActiveItemChange?.(activeItemId ? `pp-slash-${activeItemId}` : null);
  }, [activeItemId, onActiveItemChange]);

  // 面板高度随过滤结果与语言变化，落点却依赖它：挂载后量一次真实尺寸再定位。
  // 用 layout effect 是为了在绘制前纠正，避免首帧按估计高度放错位置。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (!width && !height) return;
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [open, items.length]);

  // 视口变化后要重新夹边 / 翻屏；父组件同时会把新锚点传下来。
  // 打开时先量一次：组件一直挂着，窗口在上次打开之后变过的话初值已经过期。
  useEffect(() => {
    if (!open) return;
    const syncViewport = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, [open]);

  // ↑↓ / hover 换高亮时把该项滚进列表可视区。
  // 不用 scrollIntoView：它会把整个页面一起滚走，面板反而从光标处跑掉。
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const item = list?.children[activeIndex] as HTMLElement | undefined;
    if (!list || !item) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [open, activeIndex, query]);

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
      if (menuRef.current?.contains(event.target as Node)) return;
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

  const placed = anchor
    ? placeMenu(anchor, size, viewport)
    : { left: 12, top: 12, placement: 'below' as const };

  const menu = (
    <div
      ref={menuRef}
      id="pp-slash-menu"
      className="slash-menu"
      role="listbox"
      aria-label={t('插入指令')}
      aria-activedescendant={activeItem ? `pp-slash-${activeItem.id}` : undefined}
      data-placement={placed.placement}
      style={{ left: placed.left, top: placed.top }}
    >
      <p className="slash-menu-head">{t('插入')}</p>
      {items.length === 0 ? (
        <p className="slash-menu-empty">{t('没有匹配的指令')}</p>
      ) : (
        <div className="slash-menu-list" ref={listRef}>
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
      <p className="slash-menu-foot">{t('↑↓ 选择 · Enter 插入 · Esc 关闭')}</p>
    </div>
  );

  // 面板必须按视口定位：编辑器所在的内容区带 transform 过渡动画，那会让
  // position: fixed 改用它当包含块——面板会整体偏移一个侧栏宽度，页面滚动时
  // 还会跟着漂。挂到 body 下面才拿回真正的视口坐标系。
  if (typeof document === 'undefined') return null;
  return createPortal(menu, document.body);
}
