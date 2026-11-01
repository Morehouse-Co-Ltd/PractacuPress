import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Content } from '../types';
import { useAuth } from '../lib/session';
import { useBackend } from '../lib/backend';
import { usePermissions } from '../lib/usePermissions';
import { pageSearchText, useCustomization, useThemeMode } from '../lib/customize';
import { onInterfaceCommand } from '../lib/interfaceCommands';
import { Icon, type IconName } from './Icon';

/**
 * 全局键盘层：Shift+K 命令面板、Shift+S 搜索、Shift+D 深浅切换、Shift+H 回首页。
 *
 * - 只挂一个 window 级监听，不做轮询；
 * - 输入框聚焦时不抢快捷键；
 * - 面板打开时锁 body 滚动，关闭后恢复；
 * - 思维链的 open_search / open_command 动作与区块按钮都通过
 *   pp:interface-command 事件进来，命令源与命令目标互不引用。
 */

type Layer = 'none' | 'command' | 'search';

interface CommandItem {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
  run: () => void;
}

function isTyping(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

export function CommandLayer() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const { can } = usePermissions();
  const backend = useBackend();
  const { customization } = useCustomization();
  const { toggle } = useThemeMode();
  const [layer, setLayer] = useState<Layer>('none');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Content[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setLayer('none');
    setQuery('');
    setActive(0);
    setHits([]);
  }, []);

  /* ---------- 命令面板条目 ---------- */
  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      { key: 'home', label: '回首页', hint: 'Shift+H', icon: 'home', run: () => navigate('/') },
      { key: 'articles', label: '全部文章', hint: '/articles', icon: 'file', run: () => navigate('/articles') },
      { key: 'posts', label: '全部帖子', hint: '/posts', icon: 'message', run: () => navigate('/posts') },
      { key: 'search', label: '搜索内容', hint: 'Shift+S', icon: 'search', run: () => setLayer('search') },
      { key: 'mode', label: '切换深浅色', hint: 'Shift+D', icon: 'palette', run: toggle },
    ];
    if (me && can('write_content')) {
      items.push({
        key: 'write',
        label: '写新文章',
        hint: '/admin/content/new/article',
        icon: 'edit',
        run: () => navigate('/admin/content/new/article'),
      });
    }
    if (can('moderate_content') || can('manage_site')) {
      items.push({ key: 'admin', label: '管理后台', hint: '/admin', icon: 'grid', run: () => navigate('/admin') });
    }
    if (can('manage_site')) {
      items.push({
        key: 'theme',
        label: '页面编排',
        hint: '/admin/theme',
        icon: 'layers',
        run: () => navigate('/admin/theme'),
      });
    }
    for (const page of customization.pages) {
      if (page.status !== 'published') continue;
      items.push({
        key: `page-${page.id}`,
        label: page.title,
        hint: `/${page.slug}`,
        icon: 'file',
        run: () => navigate(`/${page.slug}`),
      });
    }
    return items;
  }, [can, customization.pages, me, navigate, toggle]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(q));
  }, [commands, query]);

  /* ---------- 打开时聚焦 + 锁滚动 ---------- */
  useEffect(() => {
    if (layer === 'none') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.body.style.overflow = previous;
      window.clearTimeout(timer);
    };
  }, [layer]);

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping()) {
        if (event.key === 'Escape' && layer !== 'none') close();
        return;
      }
      if (!event.shiftKey) {
        if (event.key === 'Escape' && layer !== 'none') close();
        return;
      }
      const key = event.key;
      if (key === 'K' || key === 'k') {
        event.preventDefault();
        setLayer((current) => (current === 'command' ? 'none' : 'command'));
      } else if (key === 'S' || key === 's') {
        event.preventDefault();
        setLayer((current) => (current === 'search' ? 'none' : 'search'));
      } else if (key === 'D' || key === 'd') {
        event.preventDefault();
        toggle();
      } else if (key === 'H' || key === 'h') {
        event.preventDefault();
        navigate('/');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, layer, navigate, toggle]);

  /* ---------- 界面命令（区块按钮 / 思维链） ---------- */
  useEffect(
    () =>
      onInterfaceCommand((command) => {
        if (command === 'search') setLayer('search');
        else if (command === 'command') setLayer('command');
        else if (command === 'mode') toggle();
        else if (command === 'home') navigate('/');
      }),
    [navigate, toggle],
  );

  /* ---------- 搜索：防抖 300ms ---------- */
  useEffect(() => {
    if (layer !== 'search') return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const timer = window.setTimeout(() => {
      backend
        .search(q, undefined, 12)
        .then((result) => {
          if (alive) setHits(result.items ?? []);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [backend, layer, query]);

  const pageHits = useMemo(() => {
    if (layer !== 'search') return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return customization.pages
      .filter((page) => page.status === 'published')
      .filter((page) => pageSearchText(page).toLowerCase().includes(q))
      .slice(0, 5);
  }, [customization.pages, layer, query]);

  if (layer === 'none') return null;

  const onOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) close();
  };

  return (
    <div className="pp-overlay" onClick={onOverlayClick} role="presentation">
      {layer === 'command' ? (
        <div className="pp-command" role="dialog" aria-label="命令面板">
          <input
            ref={inputRef}
            className="pp-command-input"
            value={query}
            placeholder="输入命令，回车执行"
            aria-label="命令"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((i) => Math.min(filtered.length - 1, i + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                filtered[active]?.run();
                close();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />
          {filtered.length ? (
            <div className="pp-command-list">
              {filtered.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  className={`pp-command-item${index === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    item.run();
                    close();
                  }}
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                  <span className="pp-command-key">{item.hint}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="pp-command-empty">没有匹配的命令。</p>
          )}
        </div>
      ) : (
        <div className="pp-search" role="dialog" aria-label="搜索">
          <input
            ref={inputRef}
            className="pp-search-input"
            value={query}
            placeholder="搜索标题、摘要与页面，回车打开第一个结果"
            aria-label="搜索词"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const first = pageHits[0];
                if (first) navigate(`/${first.slug}`);
                else if (hits[0]) navigate(contentUrl(hits[0]));
                else if (query.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
                close();
              }
            }}
          />
          <div className="pp-search-results">
            {query.trim().length < 2 ? (
              <p className="pp-search-empty">至少输入 2 个字符。</p>
            ) : searching ? (
              <p className="pp-search-empty">正在搜索…</p>
            ) : pageHits.length === 0 && hits.length === 0 ? (
              <p className="pp-search-empty">
                没有找到「{query.trim()}」。
                <Link to={`/search?q=${encodeURIComponent(query.trim())}`} onClick={close}>
                  去搜索页看看
                </Link>
              </p>
            ) : (
              <>
                {pageHits.map((page) => (
                  <Link key={page.id} to={`/${page.slug}`} className="pp-search-item" onClick={close}>
                    <strong>{page.title}</strong>
                    <span>自定义页面 · {page.summary || `/${page.slug}`}</span>
                  </Link>
                ))}
                {hits.map((item) => (
                  <Link key={item.id} to={contentUrl(item)} className="pp-search-item" onClick={close}>
                    <strong>{item.title}</strong>
                    <span>
                      {item.kind === 'article' ? '文章' : '帖子'}
                      {item.summary ? ` · ${item.summary.slice(0, 60)}` : ''}
                    </span>
                  </Link>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
