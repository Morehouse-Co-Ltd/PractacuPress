import type { BlockInstance } from '../types';
import { blockProp } from './blocks';

/**
 * 锚点（`BlockInstance.anchor`）的归一化、收集与分配。
 *
 * 这个文件是**纯数据层**：不碰 DOM、不碰 React，所以两个消费方（区块外壳把锚点
 * 写成 `<section id>`，目录区块把它列成链接）与测试共用同一套规则，不会各写一份。
 *
 * 三条规则：
 * - **空就是没有**：归一化后为空串的锚点一律忽略——`id=""` 在 HTML 里是非法的，
 *   而 `href="#"` 会跳到页首，比没有锚点更糟；
 * - **第一次出现者胜**：同页重复的锚点在文档顺序里只有第一个能用，后来者当作没填，
 *   否则页面里会出现两个同 id 的元素，`#anchor` 最终落到哪个由浏览器决定；
 * - **不做花活**：只保留 `[a-z0-9-]`，最多 40 个字符。锚点是要写进 URL 的东西，
 *   中文、空格、标点都得先变成能复制、能分享、能进 `id` 的形状。
 *
 * 隐藏（`hidden`）与不支持（`unsupported`）的区块连同子树都不参与：它们在渲染树上
 * 根本不出现，把它们列进目录只会得到一条点了没反应的链接。
 */

/** 锚点长度上限；与 `normalizeAnchor` 的截断是同一个数字。 */
export const ANCHOR_MAX_LENGTH = 40;

/**
 * 把作者填的锚点整成能直接当 `id` 用的形状。
 *
 * 顺序很关键：先转小写再滤字符（否则 `İ` 这类大小写转换会多出字符）、连续连字符
 * 在截断前先并掉（否则 `a---b` 会白白吃掉长度预算）、截断后还要再抹一次结尾的
 * 连字符（正好切在 `-` 上时会留下 `foo-` 这种半截锚点）。
 */
export function normalizeAnchor(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, ANCHOR_MAX_LENGTH)
    .replace(/-+$/, '');
}

/** 一条目录条目：跳到哪个锚点、显示什么文字。 */
export interface AnchorTarget {
  anchor: string;
  title: string;
}

/** 收集时顺带记住区块 id，供「区块 id → 锚点」那一路复用同一趟遍历。 */
interface AnchorEntry extends AnchorTarget {
  id: string;
}

/**
 * 目录条目的标题。
 *
 * 优先用作者写在内容里的标题（`props.title` / `props.heading`）——目录是给读者看的，
 * 读者认的是正文标题，不是后台里的「显示名」。两样都没填才退回后台显示名，再没有
 * 就用锚点本身兜底，绝不留一条空链接。
 */
function titleOf(block: BlockInstance): string {
  for (const value of [blockProp(block, 'title', ''), blockProp(block, 'heading', '')]) {
    const text = value.trim();
    if (text) return text;
  }
  return block.title.trim();
}

/** 深度优先、先父后子地走一遍，按文档顺序收下第一个占住该锚点的区块。 */
function collect(blocks: BlockInstance[]): AnchorEntry[] {
  const entries: AnchorEntry[] = [];
  const taken = new Set<string>();
  const visit = (list: BlockInstance[]) => {
    for (const block of list) {
      // 隐藏 / 不支持的区块连子树都不渲染，锚点自然也不该存在。
      if (block.hidden === true || block.unsupported === true) continue;
      const anchor = normalizeAnchor(block.anchor ?? '');
      if (anchor && !taken.has(anchor)) {
        taken.add(anchor);
        entries.push({ id: block.id, anchor, title: titleOf(block) || anchor });
      }
      if (block.children?.length) visit(block.children);
    }
  };
  visit(blocks);
  return entries;
}

/** 本页目录的目标：文档顺序、已去重。 */
export function anchorTargets(blocks: BlockInstance[]): AnchorTarget[] {
  return collect(blocks).map(({ anchor, title }) => ({ anchor, title }));
}

/**
 * 「区块 id → 锚点」。
 *
 * 区块外壳拿它决定自己要不要画 `id`：表里没有就说明这个区块的锚点是空的、重复的
 * 或者来晚了，一律当作没填——这正是「第一次出现者胜」的落地方式。
 */
export function anchorIds(blocks: BlockInstance[]): Map<string, string> {
  return new Map(collect(blocks).map((entry) => [entry.id, entry.anchor]));
}
