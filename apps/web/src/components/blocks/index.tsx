import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
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
import { applyDisplayOverrides } from '../../lib/layout';
import { isVisibleAt, roleFromSession, type VisibilityContext } from '../../lib/visibility';
import { isPreviewFrame } from '../../lib/access';
import { useAuth } from '../../lib/session';
import { useT } from '../../lib/i18n';
import { usePageSkeleton } from '../SkeletonMode';
import { useFeed } from './FeedContext';
import { useBlockDataContext } from './ArticleContext';
import { BlockSkeleton } from './BlockSkeleton';
import { CLASSIC_RENDERERS } from './Classic';
import { NIGHT_RENDERERS } from './Nightflight';
import { CONTENT_RENDERERS } from './ContentBlocks';
import { ColumnsBlock, ContainerBlock, GridBlock, SectionBlock } from './LayoutBlocks';
import { MEDIA_RENDERERS } from './MediaBlocks';
import { DATA_RENDERERS } from './DataBlocks';
import { ENGAGE_RENDERERS } from './EngageBlocks';
import { ACTION_RENDERERS } from './ActionBlocks';
import { ARTICLE_RENDERERS } from './ArticleBlocks';
import { MARKETING_RENDERERS } from './MarketingBlocks';
import { MEDIA_GALLERY_RENDERERS } from './MediaGalleryBlocks';
import { CONVERSION_RENDERERS } from './ConversionBlocks';
import { UTILITY_RENDERERS } from './UtilityBlocks';
import { QUERY_RENDERERS } from './QueryBlocks';
import { FORM_RENDERERS } from './FormBlocks';
import { ANCHOR_RENDERERS } from './AnchorNav';
import { AnchorScopeProvider, useAnchorScope } from './AnchorScope';
import { ScreenScopeProvider, type ScreenScope } from './ScreenScope';

/**
 * 界面渲染器：把一份组件编排画出来。
 *
 * - 每个区块包一层 <section data-pp-block="id">，思维链通过这个属性找到它；
 * - 作者填了锚点时，同一个 <section> 再带上 `id`（整页去重，见 `AnchorScope`），
 *   这样 `#anchor` 链接、浏览器的前进后退和目录高亮用的是同一个落点；
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
  ...MARKETING_RENDERERS,
  ...MEDIA_GALLERY_RENDERERS,
  ...CONVERSION_RENDERERS,
  ...UTILITY_RENDERERS,
  ...QUERY_RENDERERS,
  ...FORM_RENDERERS,
  ...ANCHOR_RENDERERS,
};

/**
 * 条件显示的求值上下文。
 *
 * 子区块在任意深度都要用同一套「设备 / 角色 / 此刻」来求值（分栏容器、容器、
 * 嵌套层三条路径各不相同），所以走 context 而不是 props：`BlockView` 是递归的，
 * props 得穿过 `ColumnsBlock` 的 renderChild 和 `renderBlocks` 的分栏分组，
 * 而 context 让每个 `BlockView` 自己取——同目录的 `ScreenScope` / `FeedContext`
 * 已经是这个形状。
 *
 * 缺省 `null` 表示"不做条件显示过滤"：编排器里单独渲染一个区块预览时没有这层
 * provider，编辑时该看得见被藏起来的区块。
 */
const VisibilityCtx = createContext<VisibilityContext | null>(null);

function VisibilityProvider({
  value,
  children,
}: {
  value: VisibilityContext;
  children: ReactNode;
}) {
  return <VisibilityCtx.Provider value={value}>{children}</VisibilityCtx.Provider>;
}

function useVisibility(): VisibilityContext | null {
  return useContext(VisibilityCtx);
}

function BlockView({ block, area }: { block: BlockInstance; area?: BlockArea }) {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref);
  const motion = usePageSkeleton();
  const feed = useFeed();
  const dataContext = useBlockDataContext();
  const visibility = useVisibility();
  // 锚点是整页分配好的（见 `AnchorScope`）：重复的后来者根本不在表里，
  // 所以这里查不到就当作没填，绝不自己再 normalize 一遍。
  const anchors = useAnchorScope();
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
  // 栅格和分栏一样，自己负责递归子区块（见下面的 GridBlock 分支）。
  const isGrid = displayBlock.type === 'grid';
  // 分节也是子区块宿主：它自己画 children，不能再让嵌套层兜底画一遍。
  const isSection = displayBlock.type === 'section';
  const anim = displayBlock.animation && displayBlock.animation !== 'none' ? displayBlock.animation : '';
  // 子区块服从与根级区块同一条规则：设备、角色、时间窗。没有 provider 时
  // visibility 为 null，只按 hidden 过滤（编排器预览要看全）。
  const visibleChildren = (displayBlock.children ?? []).filter(
    (child) => !child.hidden && (!visibility || isVisibleAt(child, visibility)),
  );
  const hasNestedLayer =
    !isColumns && !isContainer && !isGrid && !isSection && visibleChildren.length > 0;
  // 骨架模式 + 内容还在加载 + 该区块依赖 FeedContext：外壳保留，内部只画骨架。
  // 未登记的类型（标题/文本/按钮/hero 等）照常渲染，不会把能立刻显示的内容藏起来。
  const skeletonShape = motion && feed.loading ? BLOCK_SKELETON_SHAPES[displayBlock.type] : undefined;

  useEffect(() => {
    if (!seen || !anim || !ref.current || motionReduced()) return;
    playBlockAnimation(ref.current, anim);
  }, [seen, anim]);

  // 未知类型的区块（新版本导出的设计）仍保留在持久化数据里，避免被静默销毁，
  // 但绝不能画出来——包括外层 <section> 的边距和间距，否则访客会看到一块空档。
  // 守卫放在所有 hooks 之后：即使之后有人在原地改掉 unsupported，多次渲染的
  // hooks 调用顺序也不会变化，不会触发「Rendered fewer hooks than expected」崩溃。
  if (block.unsupported === true) return null;

  return (
    <section
      ref={ref}
      // 锚点直接落在这一层：`#anchor` 与浏览器前进后退都靠这个 id，包一层会把
      // 「跳到哪」和「哪一段被高亮」错开。空锚点不会走到这里（表里没有）。
      id={anchors.ids.get(displayBlock.id)}
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
        // 分栏自己不认得设备与角色：把同一份过滤结果（hidden + 条件显示）交给它，
        // 与栅格 / 分节同一条路径。少了这一步，列里 members-only 或未来日期的区块
        // 会在访客面前照常渲染——`ColumnsBlock` 只过滤 hidden。
        <ColumnsBlock
          block={{ ...displayBlock, children: visibleChildren }}
          renderChild={(child) => <BlockView key={child.id} block={child} />}
        />
      ) : isContainer ? (
        <ContainerBlock>
          {visibleChildren.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </ContainerBlock>
      ) : isGrid ? (
        // 子区块已经过 hidden / 条件显示的过滤，连同过滤结果一起交给栅格：
        // 栅格自己不认得设备与角色，只负责落位。
        <GridBlock
          block={{ ...displayBlock, children: visibleChildren }}
          renderChild={(child) => <BlockView key={child.id} block={child} />}
        />
      ) : isSection ? (
        // 与栅格同理：过滤后的子区块交给分节，分节只负责留白、限宽与底色。
        // 这一支必须在 hasNestedLayer 的排除名单里，否则子区块会被画两遍。
        <SectionBlock block={displayBlock}>
          {visibleChildren.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </SectionBlock>
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
  // 条件显示：角色由登录态推出，设备是当前断点，时间点在挂载时取一次。
  // 不为时间窗挂定时器——改天换内容靠下一次加载生效，比每个会话重排一次版面省。
  const { me } = useAuth();
  const role = roleFromSession(me);
  const now = useMemo(() => new Date(), []);
  // 编排器预览跑在 iframe 里（带管理员真实登录态）：角色与时间窗在预览里不该生效，
  // 否则作者刚设了限制的区块会当场消失、再也选不中。设备条件仍然生效。
  const preview = useMemo(() => isPreviewFrame(), []);
  const visibility = useMemo<VisibilityContext>(
    () => ({ device, role, now, preview }),
    [device, role, now, preview],
  );
  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device)
    .filter((block) => !block.hidden)
    .filter((block) => isVisibleAt(block, visibility));
  if (!blocks.length) return null;
  return (
    <ScreenScopeProvider scope={scope ?? { type: 'home', id: 'home' }}>
      {/* 锚点分配要求「看见整页」：放在这一层，重复锚点才能按文档顺序判给第一个。 */}
      <AnchorScopeProvider blocks={blocks}>
        <VisibilityProvider value={visibility}>{renderBlocks(blocks, variant, t)}</VisibilityProvider>
      </AnchorScopeProvider>
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
