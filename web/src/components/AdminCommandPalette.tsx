import { Fragment, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { moveActiveIndex, searchAdminEntries, type AdminSearchEntry } from '../lib/adminSearch';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';
import '../styles/adminSearch.css';

/**
 * 后台命令面板：顶栏「搜索功能」按钮与 Ctrl/Cmd+K 打开的模态搜索。
 *
 * - 数据由 AdminShell 组装后传进来：它已经按权限过滤、按分组排好，并且带上了
 *   中文原文关键词，所以这里只负责过滤、键盘与渲染；
 * - 选择后走 `useNavigate`，扩展页（`/admin/ext/:pageId`）与普通后台页走同一条路径；
 * - 关闭时把焦点还给顶栏的触发按钮，键盘用户不会掉到页面开头。
 *
 * 组件只在打开时挂载：每次打开都是全新的输入与高亮状态，不需要额外的复位逻辑。
 */
export function AdminCommandPalette({
  onClose,
  entries,
  returnFocusTo,
}: {
  /** 关闭面板（Esc、点遮罩、选中条目都会调用）。 */
  onClose: () => void;
  /** 可搜索的全部条目，来自 AdminShell 现有导航。 */
  entries: AdminSearchEntry[];
  /** 关闭后焦点回到哪里：顶栏的搜索按钮（ref 由 AdminShell 持有）。 */
  returnFocusTo?: { readonly current: HTMLElement | null };
}) {
  const t = useT();
  const navigate = useNavigate();
  const baseId = useId().replace(/:/g, '');
  const listboxId = `admin-cmd-listbox-${baseId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // 这两个通过 ref 读取：调用方传的是内联箭头函数 / 稳定 ref，写进 effect 依赖会让
  // 「打开时聚焦输入框」的 effect 在后台任意一次重渲染后重复执行，焦点来回闪。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocusTo);
  returnFocusRef.current = returnFocusTo;

  const results = useMemo(() => searchAdminEntries(entries, query), [entries, query]);
  // 过滤后高亮可能落在越界下标上：统一夹紧后再给到键盘与 aria。
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const grouped = query.trim() === '';

  const choose = (entry: AdminSearchEntry | undefined) => {
    if (!entry) return;
    onClose();
    // 把标签带过去：AdminShell 跳转后会按它在页面里定位到对应功能区并高亮。
    navigate(entry.to, { state: { adminSearchFocus: { label: entry.label } } });
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus({ preventScroll: true });
    // Esc 挂在 document 上：鼠标点过结果列表后焦点可能在别处，面板仍要能关。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // 关闭后回到触发按钮，键盘用户接着按 Enter 就能再次打开。
      returnFocusRef.current?.current?.focus({ preventScroll: true });
    };
  }, []);

  // 高亮项滚进视口：结果过多时列表内部滚动，但当前项必须始终可见。
  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  };

  return createPortal(
    <div className="admin-cmd-overlay" role="presentation" onMouseDown={onOverlayMouseDown}>
      <div className="admin-cmd" role="dialog" aria-modal="true" aria-label={t('搜索功能')}>
        <div className="admin-cmd-field">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="admin-cmd-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // 查询变化就回到第一项，否则过滤后高亮可能停在越界项上。
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive(moveActiveIndex(activeIndex, results.length, 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(moveActiveIndex(activeIndex, results.length, -1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(results[activeIndex]);
              }
            }}
            placeholder={t('搜索功能…')}
            aria-label={t('搜索功能')}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0 ? `admin-cmd-option-${baseId}-${activeIndex}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {results.length === 0 ? (
          <p className="admin-cmd-empty" role="status">
            {t('没有找到与「{query}」匹配的功能。', { query: query.trim() })}
          </p>
        ) : (
          <div className="admin-cmd-results">
            <div className="admin-cmd-listbox" id={listboxId} role="listbox" aria-label={t('功能与页面')}>
              {results.map((entry, index) => (
                <Fragment key={entry.id}>
                  {grouped && (index === 0 || results[index - 1].group !== entry.group) ? (
                    <div className="admin-cmd-group" role="presentation">
                      {entry.group}
                    </div>
                  ) : null}
                  <div
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={`admin-cmd-option-${baseId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`admin-cmd-option${index === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      // 保住输入框焦点：点击结果时不要先让 input 失焦再关闭面板。
                      event.preventDefault();
                    }}
                    onClick={() => choose(entry)}
                  >
                    <Icon name={entry.icon ?? 'grid'} size={15} />
                    <span className="admin-cmd-option-label">{entry.label}</span>
                    {/* 搜索状态下结果按命中等级排序，分组标题不再连续，改用行尾小字标出来。 */}
                    {grouped ? null : <span className="admin-cmd-option-group">{entry.group}</span>}
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        )}

        <div className="admin-cmd-foot" aria-hidden="true">
          {t('↑/↓ 选择 · Enter 打开 · Esc 关闭')}
        </div>
      </div>
    </div>,
    document.body,
  );
}
