import { describe, expect, it } from 'vitest';
import { enhanceVideoCards, videoEmbedUrl } from './videoEmbed';

describe('videoEmbedUrl', () => {
  it('maps YouTube watch, short and embed links to the privacy embed', () => {
    expect(videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(videoEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(videoEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('maps Bilibili video and player links', () => {
    expect(videoEmbedUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(
      'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0',
    );
    expect(videoEmbedUrl('https://player.bilibili.com/player.html?aid=12345')).toBe(
      'https://player.bilibili.com/player.html?aid=12345&autoplay=0',
    );
  });

  it('leaves unknown hosts and malformed links as cards', () => {
    expect(videoEmbedUrl('https://vimeo.com/123456')).toBeNull();
    expect(videoEmbedUrl('https://www.youtube.com/watch?v=')).toBeNull();
    expect(videoEmbedUrl('not a url')).toBeNull();
    expect(videoEmbedUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('enhanceVideoCards', () => {
  it('upgrades provider cards and uploaded files, but not unknown hosts', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<a class="pp-video" href="https://youtu.be/dQw4w9WgXcQ"><strong>Talk</strong></a>',
      '<a class="pp-video pp-video-file" href="/api/v1/media/ast_1"><strong>Clip</strong></a>',
      '<a class="pp-video" href="https://vimeo.com/1"><strong>Other</strong></a>',
    ].join('');

    enhanceVideoCards(root);

    const iframe = root.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(iframe?.getAttribute('title')).toBe('Talk');
    expect(root.querySelector('video')?.getAttribute('src')).toBe('/api/v1/media/ast_1');
    expect(root.querySelectorAll('a.pp-video')).toHaveLength(1);
    expect(root.querySelector('a.pp-video')?.getAttribute('href')).toBe('https://vimeo.com/1');
  });
});
