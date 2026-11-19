import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'file'
  | 'message'
  | 'search'
  | 'bell'
  | 'mail'
  | 'user'
  | 'users'
  | 'settings'
  | 'shield'
  | 'image'
  | 'clock'
  | 'logout'
  | 'plus'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-up-right'
  | 'check'
  | 'check-circle'
  | 'close'
  | 'alert'
  | 'info'
  | 'x-circle'
  | 'eye'
  | 'edit'
  | 'bookmark'
  | 'heart'
  | 'reply'
  | 'send'
  | 'trash'
  | 'refresh'
  | 'upload'
  | 'download'
  | 'copy'
  | 'external'
  | 'menu'
  | 'sparkle'
  | 'database'
  | 'server'
  | 'lock'
  | 'globe'
  | 'grid'
  | 'list'
  | 'filter'
  | 'more'
  | 'code'
  | 'thumb'
  | 'minus'
  | 'arrow-up'
  | 'palette'
  | 'layers'
  | 'sun'
  | 'moon'
  | 'tag'
  | 'chart'
  | 'activity'
  | 'command'
  | 'video'
  | 'link'
  | 'table'
  | 'columns'
  | 'quote'
  | 'bulb'
  | 'github'
  | 'x'
  | 'mastodon'
  | 'rss';

const ICONS: Record<IconName, ReactNode> = {
  tag: (
    <>
      <path d="M4 11.2V4.8c0-.7.5-1.2 1.2-1.2h6.4c.4 0 .8.2 1 .4l7.6 7.6c.4.4.4 1 0 1.4l-6.4 6.4c-.4.4-1 .4-1.4 0L4.4 12c-.3-.2-.4-.5-.4-.8Z" />
      <circle cx="8.4" cy="8.4" r="1.3" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16V9M12 16V5.5M17 16v-4.5" />
    </>
  ),
  activity: (
    <>
      <path d="M3.5 12.5h4l2.2-6 3.4 11 2.3-6.2 2.1 3.2h3" />
    </>
  ),
  command: (
    <>
      <path d="M9 7.5a2.5 2.5 0 1 0-2.5 2.5H17a2.5 2.5 0 1 0-2.5-2.5v9A2.5 2.5 0 1 0 17 14H6.5A2.5 2.5 0 1 0 9 16.5z" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6.5 9.5V20h11V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  file: (
    <>
      <path d="M7 3.5h7l4 4V20.5H7z" />
      <path d="M14 3.5v4h4" />
      <path d="M9.5 12h6M9.5 15.5h6M9.5 8.5h2.5" />
    </>
  ),
  message: (
    <>
      <path d="M4 5.5h16v11H9.5L5.5 20v-3.5H4z" />
      <path d="M8 9.5h8M8 13h5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.2 15.2 4.3 4.3" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.2.8 4.8 1.5 5.8H5c.7-1 1.5-2.6 1.5-5.8Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.4 3.5-5.2 7-5.2s6.2 1.8 7 5.2" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3" />
      <path d="M3.5 19c.7-3 3-4.6 6-4.6s5.3 1.6 6 4.6" />
      <path d="M16 5.8a3 3 0 0 1 0 5.7M17.5 14.6c2 .5 3.2 1.9 3.5 4.4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M19.2 14.2a7.8 7.8 0 0 0 .1-4.4l-1.9-.4-.8-1.9 1.1-1.6a7.8 7.8 0 0 0-3.7-2.1L12.8 5.4h-1.6L10 3.8a7.8 7.8 0 0 0-3.7 2.1l1.1 1.6-.8 1.9-1.9.4a7.8 7.8 0 0 0 .1 4.4l1.8.5.8 1.9-1 1.5a7.8 7.8 0 0 0 3.6 2l1.2-1.6h1.6l1.2 1.6a7.8 7.8 0 0 0 3.6-2l-1-1.5.8-1.9Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6z" />
      <path d="m9 11.8 2.2 2.2 4-4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <circle cx="8.5" cy="9.5" r="1.4" />
      <path d="m4.5 17 4.8-4.8 3.2 3.2 2.6-2.4 4.4 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 4.5H6.5V19.5h8" />
      <path d="m16 8.5 3.5 3.5L16 15.5M10.5 12h9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  'chevron-down': <path d="m6 9.5 6 6 6-6" />,
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  'chevron-left': <path d="m14.5 6-6 6 6 6" />,
  'arrow-right': (
    <>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19.5 12h-15" />
      <path d="m10.5 6-6 6 6 6" />
    </>
  ),
  'arrow-up-right': (
    <>
      <path d="M7 17 17 7" />
      <path d="M8.5 7H17v8.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12.2 2.7 2.7 5.3-5.4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 4 21 20H3z" />
      <path d="M12 10v4.5M12 17.2v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  edit: (
    <>
      <path d="M15.5 4.8 19.2 8.5 8.5 19.2H4.8v-3.7z" />
      <path d="m13.7 6.6 3.7 3.7" />
    </>
  ),
  bookmark: <path d="M6.5 4.5H18v16l-5.8-3.8L6.5 20.5z" />,
  heart: <path d="M12 19.5S4 14.8 4 9.3a4.3 4.3 0 0 1 8-2.2 4.3 4.3 0 0 1 8 2.2c0 5.5-8 10.2-8 10.2Z" />,
  reply: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4.5 12h8.7c3.4 0 6 2.4 6 5.5V19" />
    </>
  ),
  send: (
    <>
      <path d="M20 4 3.5 10.8l6.2 2.8 2.6 6.2z" />
      <path d="m9.7 13.6 4.6-4.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 4.5h5M7 7l.8 12.5h8.4L17 7" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M20 4v5h-5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15.5v4h15v-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5V16" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 15.5v4h15v-4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5V5.5h-11v11h3" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="M19 5 10 14" />
      <path d="M18 13.5V19H5V6h5.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sparkle: (
    <>
      <path d="M12 4v5M12 15v5M4 12h5M15 12h5" />
      <path d="m7.5 7.5 2.6 2.6M13.9 13.9l2.6 2.6M16.5 7.5l-2.6 2.6M10.1 13.9l-2.6 2.6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6.5" rx="1.3" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="1.3" />
      <path d="M7.5 7.2h.2M7.5 16.7h.2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.3 3.8 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.8-5.3-3.8-8.5S9.5 5.9 12 3.5Z" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" />
    </>
  ),
  list: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  filter: <path d="M4 5.5h16l-6.2 7.4v5.6l-3.6 1.8v-7.4z" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18.5" cy="12" r="1" />
    </>
  ),
  code: (
    <>
      <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4" />
    </>
  ),
  thumb: (
    <>
      <path d="M7 10.5v9H4v-9z" />
      <path d="M7 10.5 10.5 4c1.7 0 2.8 1.2 2.4 2.9l-.7 2.6h5.1c1.2 0 2 1 1.8 2.2l-1.2 6.1c-.2 1-1 1.7-2 1.7H7" />
    </>
  ),
  'arrow-up': <path d="M12 20V4m0 0-6 6m6-6 6 6" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1.4a2.1 2.1 0 0 0 0-4.2h-.6a2 2 0 0 1 0-4h3.7A4 4 0 0 0 21 8.8C21 5.6 17 3 12 3Z" />
      <circle cx="7.5" cy="9" r="1" />
      <circle cx="10" cy="6.5" r="1" />
      <circle cx="14" cy="6.8" r="1" />
      <circle cx="17" cy="9.4" r="1" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  video: (
    <>
      <rect x="3" y="6" width="12.5" height="12" rx="2" />
      <path d="m15.5 11 5-3v8l-5-3z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.8a3.8 3.8 0 0 0 5.4 0l2.4-2.4a3.8 3.8 0 0 0-5.4-5.4l-1 1" />
      <path d="M14 10.2a3.8 3.8 0 0 0-5.4 0l-2.4 2.4a3.8 3.8 0 0 0 5.4 5.4l1-1" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
      <path d="M3.5 9.5h17M9.5 9.5v10M15 9.5v10" />
    </>
  ),
  columns: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
      <path d="M12 4.5v15" />
    </>
  ),
  quote: (
    <>
      <path d="M9.5 6.5c-2.6.7-4 2.6-4 5.4 0 1.9 1.1 3.2 2.7 3.2 1.4 0 2.5-1 2.5-2.5 0-1.4-.9-2.4-2.2-2.4-.3 0-.6 0-.8.1.3-1.2 1.2-2 2.5-2.4z" />
      <path d="M18 6.5c-2.6.7-4 2.6-4 5.4 0 1.9 1.1 3.2 2.7 3.2 1.4 0 2.5-1 2.5-2.5 0-1.4-.9-2.4-2.2-2.4-.3 0-.6 0-.8.1.3-1.2 1.2-2 2.5-2.4z" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 17.5h6M10 20.5h4" />
      <path d="M12 3.5a5.5 5.5 0 0 0-3.2 9.9c.5.4.7 1 .7 1.6v.5h5v-.5c0-.6.2-1.2.7-1.6A5.5 5.5 0 0 0 12 3.5Z" />
    </>
  ),
  github: (
    <>
      <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.5" />
      <path d="M15 21v-3.2c0-.9.1-1.3-.4-1.8 2.2-.2 4.6-1.1 4.6-5a3.9 3.9 0 0 0-1.1-2.7 3.6 3.6 0 0 0-.1-2.7s-.9-.3-2.9 1.1a10 10 0 0 0-5.2 0C7.9 5.3 7 5.6 7 5.6a3.6 3.6 0 0 0-.1 2.7A3.9 3.9 0 0 0 5.8 11c0 3.9 2.4 4.8 4.6 5-.3.3-.4.7-.4 1.1V19" />
    </>
  ),
  x: (
    <>
      <path d="M4 4l16 16M20 4L4 20" />
    </>
  ),
  mastodon: (
    <>
      <path d="M7 9.2c0-2.1 2-3.7 5-3.7s5 1.6 5 3.7v4.6c0 2.8-2.4 4.7-5 4.7s-5-1.9-5-4.7V9.2Z" />
      <path d="M7 12h10M10 17.5v1.8M14 17.5v1.8" />
    </>
  ),
  rss: (
    <>
      <circle cx="6" cy="18" r="1.4" />
      <path d="M5.2 11.2A7.6 7.6 0 0 1 12.8 18.8M5.2 5.2A13.6 13.6 0 0 1 18.8 18.8" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 1.6,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {ICONS[name]}
    </svg>
  );
}
