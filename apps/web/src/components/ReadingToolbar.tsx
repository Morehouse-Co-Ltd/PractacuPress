import { useEffect, useState } from 'react';
import type { TocItem } from './ArticleTools';
import { Icon } from './Icon';
import { copyText } from '../lib/clipboard';
import { useThemeMode } from '../lib/customize';
import { useT } from '../lib/i18n';
import { useToast } from '../lib/toast';
import {
  clampReadFontLevel,
  readFontScale,
  readReadFontLevel,
  READ_FONT_SCALES,
  saveReadFontLevel,
} from '../pages/site/readExperience';

/**
 * 文章页悬浮阅读工具栏（FSD A-20）。
 *
 * 回顶、字号、目录、明暗切换、分享五件事。桌面是右侧竖条，窄屏收成底部横条；
 * 字号档位存 localStorage，跟随主题默认字号按比例缩放正文。
 */
export function ReadingToolbar({ toc, title }: { toc: TocItem[]; title?: string }) {
  const t = useT();
  const toast = useToast();
  const { mode, toggle } = useThemeMode();
  const [level, setLevel] = useState(readReadFontLevel);
  const [tocOpen, setTocOpen] = useState(false);
  const scale = readFontScale(level);

  useEffect(() => {
    const stage = document.querySelector<HTMLElement>('.article-stage');
    if (!stage) return;
    stage.style.setProperty('--pp-read-scale', String(scale));
    stage.dataset.readFont = String(Math.round(scale * 100));
    return () => {
      stage.style.removeProperty('--pp-read-scale');
      delete stage.dataset.readFont;
    };
  }, [scale]);

  useEffect(() => {
    saveReadFontLevel(level);
  }, [level]);

  const stepFont = (delta: number) => {
    setLevel((current) => saveReadFontLevel(clampReadFontLevel(current + delta)));
  };

  const backToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: title ?? document.title, url });
        return;
      } catch {
        /* 用户取消或系统不支持，退回复制链接 */
      }
    }
    const copied = await copyText(url);
    if (copied) toast.push('ok', t('链接已复制'));
    else toast.push('error', t('无法复制链接'), t('请从地址栏手动复制。'));
  };

  return (
    <aside className="read-tools" aria-label={t('阅读工具')} data-pp-read-toolbar="on">
      <button type="button" className="read-tool" onClick={backToTop} aria-label={t('回到顶部')} title={t('回到顶部')}>
        <Icon name="arrow-up" size={17} />
      </button>

      <div className="read-tool-font" role="group" aria-label={t('正文字号')}>
        <button
          type="button"
          className="read-tool"
          onClick={() => stepFont(-1)}
          disabled={level <= 0}
          aria-label={t('缩小字号')}
          title={t('缩小字号')}
        >
          <Icon name="minus" size={15} />
        </button>
        <span className="read-tool-value" aria-live="polite">
          {Math.round((READ_FONT_SCALES[level] ?? 1) * 100)}%
        </span>
        <button
          type="button"
          className="read-tool"
          onClick={() => stepFont(1)}
          disabled={level >= READ_FONT_SCALES.length - 1}
          aria-label={t('放大字号')}
          title={t('放大字号')}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>

      <button
        type="button"
        className={`read-tool${tocOpen ? ' is-on' : ''}`}
        onClick={() => setTocOpen((open) => !open)}
        aria-label={t('本文目录')}
        aria-expanded={tocOpen}
        title={t('本文目录')}
        disabled={toc.length < 1}
      >
        <Icon name="list" size={17} />
      </button>

      <button
        type="button"
        className="read-tool"
        onClick={toggle}
        aria-label={mode === 'dark' ? t('切换到浅色模式') : t('切换到深色模式')}
        title={mode === 'dark' ? t('切换到浅色模式') : t('切换到深色模式')}
      >
        <Icon name={mode === 'dark' ? 'sun' : 'moon'} size={17} />
      </button>

      <button type="button" className="read-tool" onClick={() => void share()} aria-label={t('分享')} title={t('分享')}>
        <Icon name="arrow-up-right" size={17} />
      </button>

      {tocOpen && toc.length ? (
        <nav className="read-tool-panel" aria-label={t('本文目录')}>
          <p className="read-tool-panel-title">{t('本文目录')}</p>
          <ol>
            {toc.map((item) => (
              <li key={item.id} className={item.level === 3 ? 'is-sub' : undefined}>
                <a href={`#${item.id}`} onClick={() => setTocOpen(false)}>
                  {item.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
    </aside>
  );
}
