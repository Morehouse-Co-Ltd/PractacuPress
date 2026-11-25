import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigateWithTransition } from '../lib/themeTransition';
import { resolvePjaxTarget } from '../lib/pjax';

/**
 * App-wide PJAX bridge.
 *
 * React Router already swaps pages without a reload, but raw anchors rendered
 * from Markdown, custom pages, themes and plugins still trigger a full document
 * navigation. One bubble-phase listener sends those same-origin page links
 * through the router instead, with a thin progress line and the existing View
 * Transition fade.
 *
 * The listener must run after React Router's own handlers: router links already
 * prevent the default click and navigate. Intercepting them in the capture phase
 * would wrap every admin sidebar click in a whole-page View Transition, which
 * reads as a flicker. Bubble phase plus the defaultPrevented check leaves those
 * links to the router and only takes over anchors nothing else handled.
 */
export function PjaxBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const [active, setActive] = useState(false);
  const pendingHash = useRef('');
  const resetTimer = useRef(0);

  // A completed route transition clears the progress line. The timeout is only a
  // safeguard for a navigation that never commits (for example a guard).
  useEffect(() => {
    setActive(false);
    window.clearTimeout(resetTimer.current);
    if (pendingHash.current) {
      const hash = pendingHash.current;
      pendingHash.current = '';
      requestAnimationFrame(() => {
        const target = document.getElementById(decodeURIComponent(hash.slice(1)));
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
  }, [location.key]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const node = event.target;
      if (!(node instanceof Element)) return;
      const anchor = node.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const target = resolvePjaxTarget(anchor, window.location.href);
      if (!target) return;

      event.preventDefault();
      setActive(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setActive(false), 8000);
      pendingHash.current = target.hash;

      const next = `${target.pathname}${target.search}${target.hash}`;
      navigateWithTransition(() => navigate(next));
    };

    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      window.clearTimeout(resetTimer.current);
    };
  }, [navigate]);

  return <div className="pp-pjax-progress" data-active={active ? 'true' : 'false'} aria-hidden="true" />;
}
