import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlockInstance } from '../../types';
import { blockItems, blockProp } from '../../lib/blocks';
import { imageRadiusCss, normalizeImageRadius } from '../../lib/imageRadius';
import { styleDeclarations } from '../../lib/blockStyles';
import { renderMarkdown, sanitizeHtml } from '../../lib/markdown';
import { useAuth } from '../../lib/session';
import { readPerformance } from '../../lib/performance';
import { useT } from '../../lib/i18n';

/**
 * 页面编排器的新媒体/文本区块。
 *
 * 所有 URL 都在渲染前过滤：只允许 http(s) 或站内绝对路径。文本正文按纯文本
 * 渲染，用户写的 CSS 只作为内联声明应用，不能生成全局样式。
 */

/** 媒体懒加载由性能设置统一控制；默认开启。 */
function useLazyMedia(): boolean {
  const { config } = useAuth();
  return readPerformance(config).lazy_media;
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text) || text.startsWith('/')) return text;
  return '';
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function TextBlock({ block }: { block: BlockInstance }) {
  const eyebrow = blockProp(block, 'eyebrow', '');
  const title = blockProp(block, 'title', '');
  const body = blockProp<string>(block, 'body', '');
  const align = blockProp(block, 'align', 'left');
  const maxWidth = Math.min(1100, Math.max(320, Number(blockProp(block, 'max_width', 680))));
  const style = styleDeclarations(blockProp(block, 'style_css', ''));
  if (!eyebrow && !title && !body) return null;
  return (
    <div
      className="pp-text-block"
      style={{ textAlign: align as 'left' | 'center' | 'right', maxWidth, marginInline: 'auto', ...style }}
    >
      {eyebrow ? <p className="pp-text-eyebrow">{eyebrow}</p> : null}
      {title ? <h2>{title}</h2> : null}
      {body ? (
        <div
          className="pp-text-body article-body"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(body)) }}
        />
      ) : null}
    </div>
  );
}

function ImageBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const lazy = useLazyMedia();
  const source = blockProp<string>(block, 'source', 'url');
  const src = safeUrl(blockProp(block, 'src', ''));
  const alt = blockProp(block, 'alt', '');
  const caption = blockProp(block, 'caption', '');
  const link = safeUrl(blockProp(block, 'link', ''));
  const ratio = blockProp(block, 'ratio', '16:9').replace(':', ' / ');
  const fit = blockProp(block, 'fit', 'cover') as 'cover' | 'contain';
  const color = blockProp(block, 'color', '#e8e4d9');
  // 圆角：theme 交给 CSS 按布局变体决定，其余档位内联像素值。
  const radius = normalizeImageRadius(blockProp(block, 'radius', 'theme'));
  const radiusCss = imageRadiusCss(radius);

  if (source === 'color') {
    const swatch = (
      <div
        className="pp-media-image pp-solid-image"
        data-radius={radius}
        role="img"
        aria-label={alt || t('纯色装饰块')}
        style={{ aspectRatio: ratio, background: color, borderRadius: radiusCss }}
      />
    );
    return (
      <figure className="pp-media-figure">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer noopener">
            {swatch}
          </a>
        ) : (
          swatch
        )}
        {caption ? <figcaption className="pp-media-caption">{caption}</figcaption> : null}
      </figure>
    );
  }

  if (!src) {
    return (
      <div className="pp-media-empty">{t('在右侧填写图片地址，或把图片来源切到「纯色块」。')}</div>
    );
  }
  const image = (
    <img
      className="pp-media-image"
      data-radius={radius}
      src={src}
      alt={alt}
      loading={lazy ? 'lazy' : 'eager'}
      decoding="async"
      style={{ aspectRatio: ratio, objectFit: fit, borderRadius: radiusCss }}
    />
  );
  return (
    <figure className="pp-media-figure">
      {link ? (
        <a href={link} target="_blank" rel="noreferrer noopener">
          {image}
        </a>
      ) : (
        image
      )}
      {caption ? <figcaption className="pp-media-caption">{caption}</figcaption> : null}
    </figure>
  );
}

function VideoBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const lazy = useLazyMedia();
  const src = safeUrl(blockProp(block, 'src', ''));
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  if (!src) return <div className="pp-media-empty">{t('在右侧填写 MP4/WebM 地址后显示。')}</div>;
  const poster = safeUrl(blockProp(block, 'poster', ''));
  const caption = blockProp(block, 'caption', '');
  const showControls = blockProp(block, 'show_controls', true);
  const showPauseButton = blockProp(block, 'show_pause_button', true);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  return (
    <figure className="pp-media-figure">
      <div className="pp-video-wrap">
        <video
          ref={videoRef}
          className="pp-media-video"
          controls={showControls}
          preload={lazy ? 'none' : 'metadata'}
          poster={poster || undefined}
          src={src}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        />
        {showPauseButton ? (
          <button
            type="button"
            className="pp-video-toggle"
            onClick={togglePlay}
            aria-label={paused ? t('播放视频') : t('暂停视频')}
          >
            {paused ? t('▶ 播放') : t('❚❚ 暂停')}
          </button>
        ) : null}
      </div>
      {caption ? <figcaption className="pp-media-caption">{caption}</figcaption> : null}
    </figure>
  );
}

function WebsiteBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const lazy = useLazyMedia();
  const url = safeUrl(blockProp(block, 'url', ''));
  const title = blockProp(block, 'title', '') || domainOf(url);
  const description = blockProp(block, 'description', '');
  const image = safeUrl(blockProp(block, 'image', ''));
  const mode = blockProp<string>(block, 'mode', 'card');
  const height = Math.min(900, Math.max(240, Number(blockProp(block, 'height', 420))));

  if (!url) return <div className="pp-media-empty">{t('在右侧填写网站地址后显示。')}</div>;

  if (mode === 'iframe') {
    return (
      <div className="pp-website pp-website-iframe">
        <iframe
          src={url}
          title={title || t('嵌入网站')}
          loading={lazy ? 'lazy' : 'eager'}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          style={{ height }}
        />
        {description ? <p className="pp-media-caption">{description}</p> : null}
      </div>
    );
  }

  return (
    <a className="pp-website pp-website-card" href={url} target="_blank" rel="noreferrer noopener">
      {image ? (
        <img
          src={image}
          alt=""
          loading={lazy ? 'lazy' : 'eager'}
          decoding="async"
          className="pp-website-cover"
        />
      ) : null}
      <span className="pp-website-copy">
        <span className="pp-website-domain">{domainOf(url)}</span>
        <strong>{title}</strong>
        {description ? <span className="pp-website-desc">{description}</span> : null}
        <span className="pp-website-arrow" aria-hidden>
          ↗
        </span>
      </span>
    </a>
  );
}

function SlideshowBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const lazy = useLazyMedia();
  const slides = useMemo(() => blockItems(block, 'slides'), [block]);
  const interval = Math.min(20, Math.max(2, Number(blockProp(block, 'interval', 5)))) * 1000;
  const autoplay = blockProp(block, 'autoplay', true);
  const height = Math.min(800, Math.max(240, Number(blockProp(block, 'height', 440))));
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (index >= slides.length) setIndex(0);
  }, [index, slides.length]);

  useEffect(() => {
    if (!autoplay || paused || slides.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % slides.length);
    }, interval);
    return () => window.clearInterval(timer);
  }, [autoplay, interval, paused, slides.length]);

  if (!slides.length) return <div className="pp-media-empty">{t('在右侧添加幻灯片后显示。')}</div>;

  const go = (delta: number) => {
    setIndex((current) => (current + delta + slides.length) % slides.length);
  };

  return (
    <div
      className="pp-slideshow"
      style={{ height }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="region"
      aria-label={t('幻灯片')}
    >
      {slides.map((slide, itemIndex) => {
        const image = safeUrl(slide.image);
        const link = safeUrl(slide.link);
        return (
          <div
            key={`${slide.image}-${itemIndex}`}
            className={`pp-slide${itemIndex === index ? ' is-active' : ''}`}
            aria-hidden={itemIndex !== index}
          >
            {image ? (
              <img
                src={image}
                alt={slide.title || ''}
                loading={lazy ? 'lazy' : 'eager'}
                decoding="async"
              />
            ) : (
              <div className="pp-slide-blank" />
            )}
            <div className="pp-slide-copy">
              {slide.title ? <h3>{slide.title}</h3> : null}
              {slide.text ? <p>{slide.text}</p> : null}
              {link ? (
                <a href={link} target="_blank" rel="noreferrer noopener">
                  {t('查看 ↗')}
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
      {slides.length > 1 ? (
        <>
          <button type="button" className="pp-slide-nav pp-slide-prev" onClick={() => go(-1)} aria-label={t('上一张')}>
            ‹
          </button>
          <button type="button" className="pp-slide-nav pp-slide-next" onClick={() => go(1)} aria-label={t('下一张')}>
            ›
          </button>
          <div className="pp-slide-dots">
            {slides.map((_, itemIndex) => (
              <button
                key={itemIndex}
                type="button"
                className={`pp-slide-dot${itemIndex === index ? ' is-active' : ''}`}
                onClick={() => setIndex(itemIndex)}
                aria-label={t('第 {count} 张', { count: itemIndex + 1 })}
                aria-current={itemIndex === index}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const MEDIA_RENDERERS = {
  text: TextBlock,
  image: ImageBlock,
  video: VideoBlock,
  website: WebsiteBlock,
  slideshow: SlideshowBlock,
};
