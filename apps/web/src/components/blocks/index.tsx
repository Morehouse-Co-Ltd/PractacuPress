import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  BlockArea,
  BlockInstance,
  BuilderDevice,
  LayoutVariant,
  ScreenLayout,
} from '../../types';
import { builderDeviceForWidth, resolveArea, screenBlocksForDevice } from '../../lib/blocks';
import { hasBoundProps, resolveBoundProps } from '../../lib/blocksData';
import { blockAppearanceCss } from '../../lib/blockAppearance';
import { useInView } from '../../lib/hooks';
import { playBlockAnimation } from '../../lib/blockAnimations';
import { styleDeclarations } from '../../lib/blockStyles';
import { motionReduced } from '../../lib/performance';
import { BLOCK_SKELETON_SHAPES } from '../../lib/loading';
import { useT } from '../../lib/i18n';
import { usePageSkeleton } from '../SkeletonMode';
import { useFeed } from './FeedContext';
import { useBlockDataContext } from './ArticleContext';
import { BlockSkeleton } from './BlockSkeleton';
import { CLASSIC_RENDERERS } from './Classic';
import { NIGHT_RENDERERS } from './Nightflight';
import { CONTENT_RENDERERS } from './ContentBlocks';
import { ColumnsBlock, ContainerBlock } from './LayoutBlocks';
import { MEDIA_RENDERERS } from './MediaBlocks';
import { DATA_RENDERERS } from './DataBlocks';
import { ENGAGE_RENDERERS } from './EngageBlocks';
import { ACTION_RENDERERS } from './ActionBlocks';
import { ARTICLE_RENDERERS } from './ArticleBlocks';
import { ScreenScopeProvider, type ScreenScope } from './ScreenScope';

/**
 * 界面渲染器：把一份组件编排画出来。
 *
 * - 每个区块包一层 <section data-pp-block="id">，思维链通过这个属性找到它；
 * - 入场动画是 CSS 类（transform/opacity），首次进入视口时播放一次；
 * - prefers-reduced-motion 时自动降级（见 styles.css）；
 * - 未知区块类型直接跳过：旧配置在新版本里不会白屏。
 *
 * 夜航（bento）是多栏版面：整幅区块在最上面铺满，其余按「主栏 / 侧栏」
 * 分到两列。分栏只影响渲染顺序，不改数据结构——同一个区块换个落位就能搬走。
 */

const RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement | null> = {
  ...CLASSIC_RENDERERS,
  ...NIGHT_RENDERERS,
  ...CONTENT_RENDERERS,
  ...MEDIA_RENDERERS,
  ...DATA_RENDERERS,
  ...ENGAGE_RENDERERS,
  ...ACTION_RENDERERS,
  ...ARTICLE_RENDERERS,
};

function BlockView({ block, area }: { block: BlockInstance; area?: BlockArea }) {
  // 未知类型的区块（新版本导出的设计）仍保留在持久化数据里，避免被静默销毁，
  // 但绝不能画出来——包括外层 <section> 的边距和间距，否则访客会看到一块空档。
  // 这里在 hooks 之前提前 return：同一次挂载期间 unsupported 不会变（由规范化只写一次），
  // 提前返回不会造成 hooks 调用顺序在多次渲染间变化，因此是安全的。
  if (block.unsupported === true) return null;
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref);
  const motion = usePageSkeleton();
  const feed = useFeed();
  const dataContext = useBlockDataContext();
  // 组件文字可以绑定「显示什么数据」：在这里统一解析一次，所有渲染器都拿到
  // 已经换成真实数据的 props，不用逐个改渲染器。没有绑定时沿用原对象，避免
  // 每次渲染都产生新 props 触发子树重算。
  const displayBlock = useMemo(
    () =>
      hasBoundProps(block.props)
        ? { ...block, props: resolveBoundProps(block, dataContext) }
        : block,
    [block, dataContext],
  );
  const Renderer = RENDERERS[displayBlock.type];
  const isColumns = displayBlock.type === 'columns';
  const isContainer = displayBlock.type === 'container';
  const anim = displayBlock.animation && displayBlock.animation !== 'none' ? displayBlock.animation : '';
  const visibleChildren = (displayBlock.children ?? []).filter((child) => !child.hidden);
  const hasNestedLayer = !isColumns && !isContainer && visibleChildren.length > 0;
  // 骨架模式 + 内容还在加载 + 该区块依赖 FeedContext：外壳保留，内部只画骨架。
  // 未登记的类型（标题/文本/按钮/hero 等）照常渲染，不会把能立刻显示的内容藏起来。
  const skeletonShape = motion && feed.loading ? BLOCK_SKELETON_SHAPES[displayBlock.type] : undefined;

  useEffect(() => {
    if (!seen || !anim || !ref.current || motionReduced()) return;
    playBlockAnimation(ref.current, anim);
  }, [seen, anim]);

  return (
    <section
      ref={ref}
      className={`pp-block${hasNestedLayer ? ' has-nested-layer' : ''}${
        seen && anim ? ` pp-anim pp-anim-${anim} is-in` : ''
      }${anim ? ' pp-anim-ready' : ''}`}
      data-pp-block={displayBlock.id}
      data-block-type={displayBlock.type}
      data-block-area={area}
      aria-label={displayBlock.title || undefined}
      style={{
        width: displayBlock.width ? `${displayBlock.width}px` : undefined,
        minHeight: displayBlock.height ? `${displayBlock.height}px` : undefined,
        maxWidth: '100%',
        // 预设外观先落，手写 CSS 后落：高级用户永远可以覆盖面板里的选择。
        ...blockAppearanceCss(displayBlock.appearance),
        ...styleDeclarations(displayBlock.custom_css),
      }}
    >
      {skeletonShape ? (
        <BlockSkeleton block={displayBlock} shape={skeletonShape} />
      ) : isColumns ? (
        <ColumnsBlock block={displayBlock} renderChild={(child) => <BlockView key={child.id} block={child} />} />
      ) : isContainer ? (
        <ContainerBlock>
          {visibleChildren.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </ContainerBlock>
      ) : Renderer ? (
        <Renderer block={displayBlock} />
      ) : null}
      {!skeletonShape && hasNestedLayer ? (
        <div className="pp-nested-layer">
          {visibleChildren.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function flat(blocks: BlockInstance[]) {
  return blocks.map((block) => <BlockView key={block.id} block={block} />);
}

/** 前台按窗口宽度选择设备；开启「不同设备分割」时取对应设备的编排。 */
function useViewportDevice(): BuilderDevice {
  const [device, setDevice] = useState<BuilderDevice>(() =>
    builderDeviceForWidth(typeof window === 'undefined' ? 1440 : window.innerWidth),
  );
  useEffect(() => {
    const update = () => setDevice(builderDeviceForWidth(window.innerWidth));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return device;
}

export function ScreenRenderer({
  layout,
  variant = 'classic',
  scope,
}: {
  layout: ScreenLayout;
  variant?: LayoutVariant;
  /** 当前界面；留言箱用它区分不同页面的留言。 */
  scope?: ScreenScope;
}) {
  const t = useT();
  const device = useViewportDevice();
  const blocks = screenBlocksForDevice(layout, device).filter((block) => !block.hidden);
  if (!blocks.length) return null;
  return (
    <ScreenScopeProvider scope={scope ?? { type: 'home', id: 'home' }}>
      {renderBlocks(blocks, variant, t)}
    </ScreenScopeProvider>
  );
}

function renderBlocks(
  blocks: BlockInstance[],
  variant: LayoutVariant,
  t: ReturnType<typeof useT>,
) {
  if (variant !== 'bento') return <>{flat(blocks)}</>;

  const lead: BlockInstance[] = [];
  const main: BlockInstance[] = [];
  const side: BlockInstance[] = [];
  const tail: BlockInstance[] = [];
  let contentStarted = false;

  for (const block of blocks) {
    const area = resolveArea(block);
    if (area === 'side') {
      side.push(block);
      continue;
    }
    if (area === 'full') {
      // 内容开始之前的整幅区块是头图区，之后的按页脚区处理。
      (contentStarted ? tail : lead).push(block);
      continue;
    }
    main.push(block);
    contentStarted = true;
  }

  return (
    <div className="pp-screen pp-screen-bento">
      {lead.map((block) => (
        <BlockView key={block.id} block={block} area="full" />
      ))}
      {main.length || side.length ? (
        <div className="pp-screen-body">
          {main.length ? <div className="pp-screen-main">{flat(main)}</div> : null}
          {side.length ? (
            <aside className="pp-screen-side" aria-label={t('侧栏')}>
              {side.map((block) => (
                <BlockView key={block.id} block={block} area="side" />
              ))}
            </aside>
          ) : null}
        </div>
      ) : null}
      {tail.map((block) => (
        <BlockView key={block.id} block={block} area="full" />
      ))}
    </div>
  );
}

export { RENDERERS as BLOCK_RENDERERS };
