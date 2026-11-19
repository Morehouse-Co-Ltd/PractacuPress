import type { BlockInstance, ScreenLayout } from '../types';
import { createBlock } from './blocks';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 页面模板：把「关于页 / 友链墙 / 大事记 / 空白页」做成可一键套用的区块编排。
 * 模板只是起点，套用后可以在页面编排里继续改。
 *
 * 页面内容全部由区块承载：模板不再生成 Markdown 正文，说明文字也放进「文本」区块。
 */

export interface PageTemplate {
  id: string;
  name: string;
  note: string;
  build: () => { summary: string; template: string; layout: ScreenLayout };
}

/** 把一段 Markdown 说明包成「文本」区块，供模板作为开场白。 */
function textBlock(markdown: string, title = ''): BlockInstance {
  const block = createBlock('text');
  block.title = title || '正文';
  block.props = { ...block.props, eyebrow: '', title: '', body: markdown };
  return block;
}

const RAW_PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: 'about',
    name: t('关于页'),
    note: t('一句发刊词 + 作者卡 + 时间线，适合「关于本站」。'),
    build: () => ({
      summary: '这间房子是谁的，为什么在这里写作。',
      template: 'about',
      layout: {
        blocks: [
          textBlock(
            [
              '这是一个独立站点：内容自己保存，稿子属于作者，读者被当作邻居。',
              '',
              '模板只是起点，套用后可以继续改区块与文字。',
            ].join('\n'),
            '关于这间房子',
          ),
          createBlock('quote-card'),
          createBlock('author-card'),
          createBlock('timeline'),
          createBlock('tag-cloud'),
        ],
      },
    }),
  },
  {
    id: 'links',
    name: t('友链墙'),
    note: t('用标签云放邻居们的链接，字号可以区分分量。'),
    build: () => ({
      summary: '一些互相读稿子的站点。',
      template: 'links',
      layout: {
        blocks: [
          textBlock(
            [
              '把下面的链接当作门牌：点进去，就是另一间房子。',
              '',
              '想交换友链，先写一封信过来。',
            ].join('\n'),
            '邻居们',
          ),
          createBlock('tag-cloud'),
          createBlock('quote-card'),
          createBlock('search-launcher'),
        ],
      },
    }),
  },
  {
    id: 'timeline',
    name: t('大事记'),
    note: t('站点统计 + 时间线，把“我们走到哪儿了”讲清楚。'),
    build: () => ({
      summary: '这个站点发生过的事。',
      template: 'timeline',
      layout: {
        blocks: [
          textBlock('每一条都可以在页面编排里改。', '一路记下来'),
          createBlock('stat-list'),
          createBlock('timeline'),
        ],
      },
    }),
  },
  {
    id: 'guestbook',
    name: t('留言箱'),
    note: t('一句邀请 + 留言表单 + 最新留言，适合留言板、树洞或读者来信。'),
    build: () => ({
      summary: '留下一句话，或者只是打个招呼。',
      template: 'guestbook',
      layout: {
        blocks: [
          textBlock(
            [
              '这里不需要主题，也不要求完整。',
              '',
              '留言会按站点设置里的评论策略显示：如果站长开了先审后发，需要审核通过后才会公开。',
            ].join('\n'),
            '留言箱',
          ),
          createBlock('guestbook'),
          createBlock('quote-card'),
        ],
      },
    }),
  },
  {
    id: 'blank',
    name: t('空白页'),
    note: t('从一张白纸开始，在页面编排里添加组件。'),
    build: () => ({
      summary: '',
      template: 'blank',
      layout: { blocks: [] },
    }),
  },
];

/**
 * 模板名称与说明是界面文案，读取时翻译；模板里的区块内容会复制进页面，
 * 属于持久化数据，用 skip 排除。
 */
export const PAGE_TEMPLATES = liveCatalog(RAW_PAGE_TEMPLATES, { skip: ['blocks'] });

export function templateById(id: string): PageTemplate | undefined {
  return PAGE_TEMPLATES.find((item) => item.id === id);
}
