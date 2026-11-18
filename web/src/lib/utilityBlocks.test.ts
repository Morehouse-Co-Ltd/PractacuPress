import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BlockInstance, BlockProps } from '../types';
import utilityCss from '../styles.css?raw';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

/**
 * P2 工具型区块三件套：对比表 / 倒计时 / 音频。
 *
 * 数据侧依旧只在 `blocks.ts` 里多三条定义，渲染侧只多一个 `UTILITY_RENDERERS`
 * 映射文件。三个组件各自钉住一条硬规则：
 * 1. 对比表：必须是真表格（`<table>` + `<th scope>`），窄屏横向滚动而不是塌成纯文本；
 * 2. 倒计时：`setInterval(1000)` + 卸载清理；首帧显示占位（不能闪 `NaN`）；
 *    日期不可解析时显示「结束」文案而不是崩掉；
 * 3. 音频：原生 `<audio controls preload="metadata">`，**绝不自动播放**；
 *    `src` / `cover` 是用户填的地址，一律先过 `safeUrl`。
 *
 * 另外照例钉住四件通用的事：三条定义存在、`defaults ⊆ schema`、`defaults` 读→写幂等、
 * 渲染器注册进了生产用的 `RENDERERS`（不是只活在测试里）。
 */

vi.mock('./session', () => ({
  useAuth: () => ({
    me: null,
    config: {},
    status: 'anonymous',
    session: null,
    site: null,
    unread: 0,
  }),
}));

import { BLOCK_RENDERERS } from '../components/blocks/index';
import {
  UTILITY_RENDERERS,
  countdownParts,
  parseTargetDate,
} from '../components/blocks/UtilityBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPES = ['comparison', 'countdown', 'audio'] as const;

function field(type: string, key: string) {
  return blockDef(type)?.schema.find((item) => item.key === key);
}

function mk(type: string, props: BlockProps): BlockInstance {
  return { id: type, type, title: type, props, animation: 'none', hidden: false };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** 直接把渲染器挂到一个真实 DOM 上：只有渲染器自己，不经过编排外壳。 */
function mount(type: string, props: BlockProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const Renderer = UTILITY_RENDERERS[type];
  act(() => {
    root?.render(createElement(Renderer, { block: mk(type, props) }));
  });
  return host;
}

function remount(type: string, props: BlockProps): HTMLDivElement {
  act(() => root?.unmount());
  host?.remove();
  return mount(type, props);
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('三条注册表定义', () => {
  it('三个 type 都在区块目录里，且是内容组、经典与夜航都能用', () => {
    for (const type of TYPES) {
      const def = blockDef(type);
      expect(def, type).toBeTruthy();
      expect(def?.name.trim()).not.toBe('');
      expect(def?.description.trim()).not.toBe('');
      expect(def?.group).toBe('content');
      expect(def?.variants).toEqual(['classic', 'bento']);
    }
  });

  it('defaults 是约定的初始内容', () => {
    expect(blockDef('comparison')?.defaults).toEqual({
      heading: '',
      left_label: '',
      right_label: '',
      rows: [],
    });
    expect(blockDef('countdown')?.defaults).toEqual({
      title: '',
      target: '',
      expired_text: '',
      show_seconds: true,
    });
    expect(blockDef('audio')?.defaults).toEqual({ src: '', title: '', artist: '', cover: '' });
  });

  it('defaults 的每个键都声明在 schema 里', () => {
    const missing: string[] = [];
    for (const type of TYPES) {
      const declared = new Set((blockDef(type)?.schema ?? []).map((item) => item.key));
      for (const key of Object.keys(blockDef(type)?.defaults ?? {})) {
        if (!declared.has(key)) missing.push(`${type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('defaults 经过归一化后原样保留', () => {
    for (const type of TYPES) {
      const created = createBlock(type).props;
      expect(normalizeBlockProps(type, created), type).toEqual(created);
    }
  });

  it('对比表的条目是 repeater：三列文本，最多 12 行', () => {
    const rows = field('comparison', 'rows');
    expect(rows?.type).toBe('repeater');
    expect(rows?.maxItems).toBe(12);
    expect(rows?.itemSchema?.map((item) => item.key)).toEqual(['label', 'left', 'right']);
    expect(rows?.itemSchema?.map((item) => item.type)).toEqual(['text', 'text', 'text']);
    expect(field('comparison', 'heading')?.type).toBe('text');
    expect(field('comparison', 'left_label')?.type).toBe('text');
    expect(field('comparison', 'right_label')?.type).toBe('text');
  });

  it('倒计时的目标是日期文本 + 「显示秒」开关；音频的 src / cover 是 media', () => {
    expect(field('countdown', 'title')?.type).toBe('text');
    expect(field('countdown', 'target')?.type).toBe('text');
    expect(field('countdown', 'expired_text')?.type).toBe('text');
    expect(field('countdown', 'show_seconds')?.type).toBe('toggle');
    expect(field('audio', 'src')?.type).toBe('media');
    expect(field('audio', 'cover')?.type).toBe('media');
    expect(field('audio', 'title')?.type).toBe('text');
    expect(field('audio', 'artist')?.type).toBe('text');
  });

  it('repeater 值按 itemSchema 清洗：超出 12 行截掉、多余键丢掉、缺的键补空串', () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      label: `项目 ${index}`,
      left: '有',
      right: '无',
      evil: '<script>',
    }));
    const props = normalizeBlockProps('comparison', { rows });
    const kept = props.rows as Record<string, unknown>[];
    expect(kept.length).toBe(12);
    expect(kept[0]).toEqual({ label: '项目 0', left: '有', right: '无' });
  });
});

describe('渲染器注册', () => {
  it('三个 type 都能在生产 RENDERERS 里找到', () => {
    for (const type of TYPES) {
      expect(typeof BLOCK_RENDERERS[type], type).toBe('function');
    }
  });

  it('UTILITY_RENDERERS 只有这三条', () => {
    expect(Object.keys(UTILITY_RENDERERS).sort()).toEqual([...TYPES].sort());
  });
});

describe('parseTargetDate（日期文本）', () => {
  it('YYYY-MM-DD 按本地零点解析', () => {
    const date = parseTargetDate('2026-12-31');
    expect(date).toBeInstanceOf(Date);
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(11);
    expect(date?.getDate()).toBe(31);
    expect(date?.getHours()).toBe(0);
    expect(date?.getMinutes()).toBe(0);
  });

  it('前后空白不算错', () => {
    expect(parseTargetDate('  2026-12-31  ')?.getTime()).toBe(
      parseTargetDate('2026-12-31')?.getTime(),
    );
  });

  it('完整 ISO（带时间与时区）原样交给 Date', () => {
    const iso = '2026-12-31T20:00:00+08:00';
    expect(parseTargetDate(iso)?.getTime()).toBe(new Date(iso).getTime());
  });

  it('空值与只有空白返回 null', () => {
    expect(parseTargetDate('')).toBeNull();
    expect(parseTargetDate('   ')).toBeNull();
    expect(parseTargetDate(undefined)).toBeNull();
    expect(parseTargetDate(42)).toBeNull();
  });

  it('认不出的文本返回 null，而不是一个随手编出来的日期', () => {
    expect(parseTargetDate('tomorrow')).toBeNull();
    expect(parseTargetDate('2026-1-1')).toBeNull();
    expect(parseTargetDate('12/31/2026')).toBeNull();
    expect(parseTargetDate('2026-12-31T')).toBeNull();
  });

  it('不存在的日期返回 null（不会静默滚到下个月）', () => {
    expect(parseTargetDate('2026-02-31')).toBeNull();
    expect(parseTargetDate('2026-13-01')).toBeNull();
    expect(parseTargetDate('2026-12-32')).toBeNull();
  });
});

describe('countdownParts（剩余时间拆段）', () => {
  it('已结束（0 或负数）返回 null', () => {
    expect(countdownParts(0)).toBeNull();
    expect(countdownParts(-1)).toBeNull();
    expect(countdownParts(Number.NaN)).toBeNull();
  });

  it('按天 / 小时 / 分 / 秒拆开，不足一秒向下取整', () => {
    expect(countdownParts(90_000)).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 30 });
    expect(countdownParts(90_999)).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 30 });
    const twoDays = ((2 * 24 + 3) * 60 + 4) * 60_000 + 5_000;
    expect(countdownParts(twoDays)).toEqual({ days: 2, hours: 3, minutes: 4, seconds: 5 });
  });

  it('超过一天时天数不封顶', () => {
    expect(countdownParts(400 * 86_400_000)?.days).toBe(400);
  });
});

describe('对比表', () => {
  const row = { label: '并发发布', left: '1 人', right: '10 人' };

  it('是真表格：三个列表头 + 行首是行表头', () => {
    const el = mount('comparison', {
      heading: '选哪个',
      left_label: '个人版',
      right_label: '团队版',
      rows: [row, { label: '导出', left: 'PDF', right: 'PDF + EPUB' }],
    });
    expect(el.querySelector('.pp-comparison-heading')?.textContent).toBe('选哪个');
    const table = el.querySelector('table.pp-comparison-table');
    expect(table).not.toBeNull();
    const colHeads = [...el.querySelectorAll('table.pp-comparison-table thead th')];
    expect(colHeads.length).toBe(3);
    expect(colHeads.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    // 左上角那格没有文案，靠 sr-only 给读屏一个名字。
    expect(colHeads[0].querySelector('.sr-only')?.textContent).toBe('项目');
    expect(colHeads[1].textContent).toBe('个人版');
    expect(colHeads[2].textContent).toBe('团队版');
    const rowHeads = [...el.querySelectorAll('table.pp-comparison-table tbody th')];
    expect(rowHeads.map((th) => th.textContent)).toEqual(['并发发布', '导出']);
    expect(rowHeads.every((th) => th.getAttribute('scope') === 'row')).toBe(true);
    const cells = [...el.querySelectorAll('table.pp-comparison-table tbody td')];
    expect(cells.map((td) => td.textContent)).toEqual(['1 人', '10 人', 'PDF', 'PDF + EPUB']);
  });

  it('两个表头都没填时不画表头行（不留一排空标题）', () => {
    const el = mount('comparison', { rows: [row] });
    expect(el.querySelector('table.pp-comparison-table')).not.toBeNull();
    expect(el.querySelector('thead')).toBeNull();
  });

  it('窄屏靠横向滚动容器，不塌成纯文本：容器可聚焦、有 aria-label', () => {
    const el = mount('comparison', { heading: '对比', rows: [row] });
    const scroller = el.querySelector('.pp-comparison-scroll');
    expect(scroller?.contains(el.querySelector('table.pp-comparison-table'))).toBe(true);
    expect(scroller?.getAttribute('tabindex')).toBe('0');
    expect(scroller?.getAttribute('role')).toBe('region');
    expect(scroller?.getAttribute('aria-label')).toBe('对比');
  });

  it('三列全空的行跳过；超过 12 行只画前 12 行', () => {
    const skipped = mount('comparison', {
      rows: [{ label: '', left: '', right: '' }, row],
    });
    expect(skipped.querySelectorAll('tbody tr').length).toBe(1);

    const many = Array.from({ length: 15 }, (_, index) => ({
      label: `项目 ${index}`,
      left: 'a',
      right: 'b',
    }));
    const el = remount('comparison', { rows: many });
    expect(el.querySelectorAll('tbody tr').length).toBe(12);
  });

  it('一行都没有时给作者一句引导文案', () => {
    const el = mount('comparison', { rows: [] });
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('在右侧添加条目。');
  });
});

describe('倒计时', () => {
  it('首帧是占位而不是 NaN（服务端渲染时效果还没跑）', () => {
    const Renderer = UTILITY_RENDERERS.countdown;
    const html = renderToStaticMarkup(
      createElement(Renderer, { block: mk('countdown', { title: '上线倒计时', target: '2099-12-31' }) }),
    );
    expect(html).not.toContain('NaN');
    const values = [...html.matchAll(/pp-countdown-value[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(values).toEqual(['--', '--', '--', '--']);
  });

  it('挂载后按天 / 小时 / 分 / 秒画四格，且没有 NaN', () => {
    const el = mount('countdown', { title: '上线倒计时', target: '2099-12-31' });
    expect(el.querySelector('.pp-countdown-title')?.textContent).toBe('上线倒计时');
    const values = [...el.querySelectorAll('.pp-countdown-value')].map((node) => node.textContent);
    expect(values.length).toBe(4);
    for (const value of values) expect(value).toMatch(/^\d{2,}$/);
    expect(el.textContent).not.toContain('NaN');
    expect(el.querySelector('.pp-countdown-clock')?.getAttribute('role')).toBe('timer');
    expect(el.querySelector('.pp-countdown-clock')?.getAttribute('aria-label')).toBe('上线倒计时');
  });

  it('关掉「显示秒」就只剩三格', () => {
    const el = mount('countdown', { target: '2099-12-31', show_seconds: false });
    expect(el.querySelectorAll('.pp-countdown-value').length).toBe(3);
    expect(el.textContent).not.toContain('秒');
  });

  it('每秒走一格，卸载时清掉定时器', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const el = mount('countdown', { target: '2026-11-03T12:01:00Z' });
    const readSeconds = () =>
      [...el.querySelectorAll('.pp-countdown-value')].map((node) => node.textContent).join(':');
    expect(readSeconds()).toBe('00:00:01:00');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(readSeconds()).toBe('00:00:00:59');
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    // 到点了：切到结束文案，定时器已经没有用了。
    expect(el.querySelector('.pp-countdown-expired')?.textContent).toBe('已结束');
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('结束文案按填写的显示；留空回退「已结束」', () => {
    const el = mount('countdown', {
      target: '2020-01-01',
      expired_text: '活动已结束',
    });
    expect(el.querySelector('.pp-countdown-expired')?.textContent).toBe('活动已结束');
    expect(el.querySelector('.pp-countdown-clock')).toBeNull();

    const fallback = remount('countdown', { target: '2020-01-01' });
    expect(fallback.querySelector('.pp-countdown-expired')?.textContent).toBe('已结束');
  });

  it('日期认不出来时显示结束文案，而不是崩掉或留下空的计时器', () => {
    const el = mount('countdown', { title: '倒计时', target: 'tomorrow', expired_text: '已结束' });
    expect(el.querySelector('.pp-countdown-expired')?.textContent).toBe('已结束');
    expect(el.querySelectorAll('.pp-countdown-value').length).toBe(0);
    expect(el.textContent).not.toContain('NaN');
  });

  it('三样都空时什么都不画（空区块不占版面）', () => {
    const el = mount('countdown', {});
    expect(el.innerHTML).toBe('');
  });
});

describe('音频', () => {
  it('原生播放器：controls + preload=metadata，且不自动播放', () => {
    const el = mount('audio', { src: '/media/track.mp3', title: '第一期', artist: '编辑部' });
    const audio = el.querySelector<HTMLAudioElement>('audio.pp-audio-player');
    expect(audio).not.toBeNull();
    expect(audio?.hasAttribute('controls')).toBe(true);
    expect(audio?.getAttribute('preload')).toBe('metadata');
    expect(audio?.hasAttribute('autoplay')).toBe(false);
    expect(audio?.getAttribute('src')).toBe('/media/track.mp3');
    expect(audio?.getAttribute('aria-label')).toBe('第一期');
    expect(el.querySelector('.pp-audio-title')?.textContent).toBe('第一期');
    expect(el.querySelector('.pp-audio-artist')?.textContent).toBe('编辑部');
  });

  it('封面过白名单，alt 为空串（标题就在旁边）', () => {
    const el = mount('audio', { src: '/media/a.mp3', title: 'x', cover: '/media/a.jpg' });
    const img = el.querySelector<HTMLImageElement>('.pp-audio-cover');
    expect(img?.getAttribute('src')).toBe('/media/a.jpg');
    expect(img?.getAttribute('alt')).toBe('');

    const unsafe = remount('audio', { src: '/media/a.mp3', title: 'x', cover: 'javascript:alert(1)' });
    expect(unsafe.querySelector('img')).toBeNull();
  });

  it('src 没过白名单或没填时不画播放器（不留一个空壳）', () => {
    for (const src of ['', 'javascript:alert(1)', 'file:///c:/secret.mp3']) {
      const el = remount('audio', { src, title: '标题', cover: '/media/a.jpg' });
      expect(el.innerHTML, src).toBe('');
    }
  });

  it('外链音频照样能播（http/https 在名单里）', () => {
    const el = mount('audio', { src: 'https://cdn.example.com/a.mp3' });
    expect(el.querySelector('audio.pp-audio-player')?.getAttribute('src')).toBe(
      'https://cdn.example.com/a.mp3',
    );
    expect(el.querySelector('.pp-audio-title')).toBeNull();
  });
});

describe('样式', () => {
  it('窄屏是横向滚动容器，不塌成纯文本', () => {
    const rule = /\.pp-comparison-scroll\s*\{([^}]*)\}/.exec(utilityCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/overflow-x:\s*auto/);
    expect(utilityCss).toMatch(/\.pp-comparison-table\s*\{[^}]*min-width:\s*\d+px/);
    expect(utilityCss).toMatch(/\.pp-comparison-scroll:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  });

  it('倒计时的数字等宽，秒跳动时格子不抖', () => {
    expect(utilityCss).toMatch(/\.pp-countdown-value\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it('音频播放器铺满内容宽，窄屏不溢出', () => {
    expect(utilityCss).toMatch(/\.pp-audio-player\s*\{[^}]*width:\s*100%/);
    expect(utilityCss).toMatch(
      /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]{0,240}?\.pp-countdown-unit\s*\{[^}]*min-width:\s*\d+px/,
    );
  });
});
