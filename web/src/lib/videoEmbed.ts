/**
 * Inline video embeds for article bodies.
 *
 * The server sanitizer never allows `<iframe>` or `<video>` in published HTML, so
 * the editor stores a safe `<a class="pp-video">` card. After the sanitized HTML is
 * mounted this module upgrades only the cards that point at a known provider (or a
 * same-site uploaded video) into a real player. The transformation reads an
 * already-sanitized href, never raw author HTML, so it does not widen the security
 * boundary: an unknown host simply stays a card.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,}$/;
const BILIBILI_BVID = /^BV[0-9A-Za-z]+$/;
const BILIBILI_AID = /^(?:av)?\d+$/i;

function youtubeEmbed(id: string): string | null {
  if (!YOUTUBE_ID.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

function bilibiliEmbed(id: string): string | null {
  if (BILIBILI_BVID.test(id)) {
    return `https://player.bilibili.com/player.html?bvid=${id}&autoplay=0`;
  }
  if (BILIBILI_AID.test(id)) {
    return `https://player.bilibili.com/player.html?aid=${id.replace(/^av/i, '')}&autoplay=0`;
  }
  return null;
}

/** Return the embed URL for a YouTube/Bilibili watch link, or null. */
export function videoEmbedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, typeof window === 'undefined' ? 'https://placeholder.invalid' : window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return youtubeEmbed(id);
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = url.searchParams.get('v') ?? '';
    if (!id) {
      const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
      id = match?.[1] ?? '';
    }
    return youtubeEmbed(id);
  }
  if (host === 'bilibili.com') {
    const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    return match ? bilibiliEmbed(match[1]) : null;
  }
  if (host === 'player.bilibili.com') {
    const bvid = url.searchParams.get('bvid') ?? '';
    if (bvid) return bilibiliEmbed(bvid);
    const aid = url.searchParams.get('aid') ?? '';
    return aid ? bilibiliEmbed(aid.replace(/^av/i, '')) : null;
  }
  return null;
}

function playerTitle(anchor: HTMLAnchorElement): string {
  const strong = anchor.querySelector('strong');
  const text = (strong?.textContent ?? anchor.textContent ?? '').trim();
  return text || 'Video';
}

/**
 * Replace playable video cards inside root with a real player.
 *
 * Cards pointing at any other host are left untouched: they remain the safe
 * "open the original page" card the sanitizer produced.
 */
export function enhanceVideoCards(root: ParentNode | null): void {
  if (!root) return;
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a.pp-video[href]');
  anchors.forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (!href) return;
    const embed = videoEmbedUrl(href);
    const uploaded = anchor.classList.contains('pp-video-file');
    if (!embed && !uploaded) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'pp-video-embed';
    if (embed) {
      const iframe = document.createElement('iframe');
      iframe.src = embed;
      iframe.title = playerTitle(anchor);
      iframe.loading = 'lazy';
      iframe.allow =
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      wrapper.append(iframe);
    } else {
      const video = document.createElement('video');
      video.src = href;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      wrapper.append(video);
    }
    anchor.replaceWith(wrapper);
  });
}
