import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Content } from '../types';
import { useBackend } from '../lib/backend';
import { useClickOutside } from '../lib/hooks';
import { KIND_LABEL, formatDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';

/**
 * 站点头部搜索框。
 *
 * 输入即搜（防抖 220ms，取前 6 条），回车进入完整搜索结果页。
 * `/` 在页面任意位置按下都会聚焦这里，除非焦点已经在输入控件里。
 */
export function SiteSearch({ placeholder }: { placeholder?: string }) {
  const t = useT();
  const hint = placeholder ?? t('搜索文章与帖子');
  const backend = useBackend();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Content[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useClickOutside(boxRef, () => setOpen(false), open);

  useEffect(() => {
    const keyword = term.trim();
    if (keyword.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      backend
        .search(keyword, undefined, 6)
        .then((page) => {
          if (cancelled) return;
          setHits(page.items);
          setActive(-1);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term, backend]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submit = (value: string) => {
    const keyword = value.trim();
    if (keyword.length < 2) return;
    setOpen(false);
    inputRef.current?.blur();
    navigate(`/search?q=${encodeURIComponent(keyword)}`);
  };

  const openHit = (item: Content) => {
    setOpen(false);
    setTerm('');
    navigate(`/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`);
  };

  const showPop = open && term.trim().length >= 2;

  return (
    <div className="site-search" ref={boxRef}>
      <div className={`site-search-field${open ? ' is-open' : ''}`}>
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              event.currentTarget.blur();
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!hits.length) return;
              setActive((prev) => {
                const next = event.key === 'ArrowDown' ? prev + 1 : prev - 1;
                if (next < -1) return hits.length - 1;
                if (next >= hits.length) return -1;
                return next;
              });
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (active >= 0 && hits[active]) openHit(hits[active]);
              else submit(term);
            }
          }}
          placeholder={hint}
          aria-label={t('站内搜索')}
          aria-expanded={showPop}
          autoComplete="off"
        />
        <kbd aria-hidden>/</kbd>
      </div>

      {showPop ? (
        <div className="site-search-pop" role="listbox" aria-label={t('搜索结果')}>
          {loading && !hits.length ? (
            <p className="site-search-empty">{t('正在搜索…')}</p>
          ) : hits.length === 0 ? (
            <p className="site-search-empty">
              {t('没有找到「{query}」', { query: term.trim() })}
              <span>{t('换一个更短的词试试。')}</span>
            </p>
          ) : (
            hits.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`site-search-hit${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => openHit(item)}
              >
                <span className="site-search-kind">{KIND_LABEL[item.kind]}</span>
                <span className="site-search-title">{item.title}</span>
                <span className="site-search-date">
                  {formatDate(item.published_at ?? item.created_at)}
                </span>
              </button>
            ))
          )}
          <div className="site-search-foot">
            <Link to={`/search?q=${encodeURIComponent(term.trim())}`} onClick={() => setOpen(false)}>
              {t('查看全部结果')} <Icon name="arrow-right" size={12} />
            </Link>
            <span className="tiny faint">{t('Enter 搜索 · Esc 关闭')}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
