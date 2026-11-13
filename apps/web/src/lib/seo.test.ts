import { describe, expect, it } from 'vitest';
import { feedLinks } from './seo';

const base = {
  origin: 'https://press.example.com',
  siteName: 'Press',
  enabled: true,
  indexable: true,
  membersOnly: false,
};

describe('订阅源 autodiscovery', () => {
  it('同时声明 RSS 与 Atom，并使用站点根地址', () => {
    expect(feedLinks(base)).toEqual([
      {
        href: 'https://press.example.com/rss.xml',
        title: 'Press RSS',
        type: 'application/rss+xml',
      },
      {
        href: 'https://press.example.com/atom.xml',
        title: 'Press Atom',
        type: 'application/atom+xml',
      },
    ]);
  });

  it('关闭订阅、禁止收录或成员限定站点时不声明', () => {
    expect(feedLinks({ ...base, enabled: false })).toEqual([]);
    expect(feedLinks({ ...base, indexable: false })).toEqual([]);
    expect(feedLinks({ ...base, membersOnly: true })).toEqual([]);
  });

  it('站点名为空时仍有可读标题', () => {
    const links = feedLinks({ ...base, siteName: '  ' });
    expect(links[0]?.title).toBe('Practacu Press RSS');
  });
});
