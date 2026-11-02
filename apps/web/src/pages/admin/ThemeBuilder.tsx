import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { BlockInstance, BuilderDevice, ScreenLayout } from '../../types';
import { useCustomization } from '../../lib/customize';
import { activeTheme } from '../../lib/themes';
import { loadConfig, useBackend } from '../../lib/backend';
import {
  cloneBlocks,
  createBlock,
  defaultHomeLayout,
  screenBlocksForDevice,
} from '../../lib/blocks';
import {
  MAX_BLOCKS,
  countBlocks,
  findBlock,
  insertBlock,
  moveBlock,
  removeBlock,
  updateBlock,
} from '../../lib/blockTree';
import { templateById } from '../../lib/templates';
import { useBuilderHistory } from '../../lib/useBuilderHistory';
import { useToast } from '../../lib/toast';
import { BlockTreeEditor } from '../../components/builder/BlockTreeEditor';
import { BlockInspector } from '../../components/builder/BlockInspector';
import { FloatingPanel } from '../../components/builder/FloatingPanel';
import { PreviewFrame } from '../../components/builder/PreviewFrame';
import { RichTextBlockModal } from '../../components/builder/RichTextBlockModal';
import { ChainEditor } from '../../components/builder/ChainEditor';
import { Badge, Button, Callout, Modal, Select } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';

/**
 * 全屏页面编排工作台。
 *
 * 中间 iframe 是真实前台；左侧组件/结构树和右侧属性检查器是可收起的悬浮窗。
 * 页面编排结果仍写进 customization.home / pages[].layout，兼容旧配置。
 */

export function ThemeBuilderPage() {
  const t = useT();
  useTitle(t('页面编排'));
  const navigate = useNavigate();
  const backend = useBackend();
  const { customization, update } = useCustomization();
  const [params] = useSearchParams();
  const requestedPage = params.get('page');
  const [target, setTarget] = useState(
    requestedPage && customization.pages.some((page) => page.id === requestedPage) ? requestedPage : 'home',
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<BuilderDevice>('desktop');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [logicOpen, setLogicOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [richBlock, setRichBlock] = useState<BlockInstance | null>(null);
  const toast = useToast();
  const [animationPreview, setAnimationPreview] = useState<{
    blockId: string;
    animation: string;
    nonce: number;
  } | null>(null);
  // 双击组件后请求预览 iframe 把视角平滑移到对应区块。
  const [locateRequest, setLocateRequest] = useState<{ blockId: string; nonce: number } | null>(null);
  // 「文章页」目标需要一个真实文章地址来预览；打开时取第一篇文章。
  const [articlePreviewUrl, setArticlePreviewUrl] = useState('');

  const currentTheme = activeTheme(customization.active_theme, customization.themes ?? []);
  const themeLabel = currentTheme?.name ?? t('自定义主题');
  const targetPage = customization.pages.find((page) => page.id === target);
  const screenLayout: ScreenLayout =
    target === 'home'
      ? customization.home
      : target === 'article'
        ? (customization.article ?? { blocks: [] })
        : (targetPage?.layout ?? { blocks: [] });
  const blocks = screenBlocksForDevice(screenLayout, device);
  const history = useBuilderHistory(blocks);
  const selected = findBlock(history.value, selectedId ?? '')?.block ?? null;
  const splitDevices = screenLayout.device_split === true;

  const setScreenLayout = (next: ScreenLayout) => {
    if (target === 'home') {
      update({ home: next });
      return;
    }
    if (target === 'article') {
      update({ article: next });
      return;
    }
    if (!targetPage) return;
    update({
      pages: customization.pages.map((page) =>
        page.id === targetPage.id ? { ...page, layout: next } : page,
      ),
    });
  };

  /**
   * 保存前的区块总量护栏。
   *
   * 读入时的归一化会静默丢掉超限的区块，用户只会看到「加着加着少了几块」。所以在
   * 落盘这一步就用同一套常量（`blockTree.ts` 的 `countBlocks` / `MAX_BLOCKS`）挡住，
   * 并在提示里写清当前数量与上限。
   */
  const guardBudget = (next: BlockInstance[]): boolean => {
    const total = countBlocks(next);
    if (total <= MAX_BLOCKS) return true;
    toast.push(
      'error',
      t('这份编排有 {count} 个区块，超过上限 {limit} 个。请先删掉一些再保存。', {
        count: total,
        limit: MAX_BLOCKS,
      }),
    );
    return false;
  };

  /** 把当前撤销栈里的编排写到「当前设备」或共用编排。 */
  const persistBlocks = (next: BlockInstance[]) => {
    if (!guardBudget(next)) return;
    if (screenLayout.device_split) {
      setScreenLayout({
        ...screenLayout,
        device_split: true,
        devices: {
          ...(screenLayout.devices ?? {}),
          [device]: { blocks: next },
        },
      });
      return;
    }
    setScreenLayout({ blocks: next });
  };

  /** 切换预览设备；开启分设备后同时切换编辑中的那份编排。 */
  const changeDevice = (next: BuilderDevice) => {
    if (next === device) return;
    setDevice(next);
    setSelectedId(null);
    setLocateRequest(null);
    history.reset(screenBlocksForDevice(screenLayout, next));
  };

  /** 打开时把当前编排复制给三台设备，关闭时以桌面版作为共用编排。 */
  const toggleSplit = (enabled: boolean) => {
    if (enabled === splitDevices) return;
    setSelectedId(null);
    setLocateRequest(null);
    if (enabled) {
      const current = history.value;
      setScreenLayout({
        blocks: current,
        device_split: true,
        devices: {
          desktop: { blocks: current },
          tablet: { blocks: cloneBlocks(current) },
          mobile: { blocks: cloneBlocks(current) },
        },
      });
      setDevice('desktop');
      history.reset(current);
      toast.push(
        'ok',
        t('已开启不同设备分割'),
        t('桌面 / 平板 / 手机现在各有一份独立编排，切换设备再编辑。'),
      );
      return;
    }
    const desktop = screenLayout.devices?.desktop?.blocks ?? history.value;
    setScreenLayout({ blocks: desktop });
    setDevice('desktop');
    history.reset(desktop);
    toast.push('ok', t('已关闭不同设备分割'), t('三台设备重新共用同一份编排（保留桌面版）。'));
  };

  useEffect(() => {
    if (target !== 'article' || articlePreviewUrl) return;
    let alive = true;
    backend
      .listContent('article', { limit: 1 })
      .then((page) => {
        if (!alive) return;
        const first = page.items.find((item) => item.status === 'published') ?? page.items[0];
        if (first) setArticlePreviewUrl(`/a/${first.id}`);
      })
      .catch(() => {
        /* 没有文章时回退到文章列表 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, target]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    document.body.classList.add('builder-mode');
    return () => {
      document.body.style.overflow = '';
      document.body.classList.remove('builder-mode');
    };
  }, []);

  useEffect(() => {
    if (JSON.stringify(history.value) === JSON.stringify(blocks)) return;
    persistBlocks(history.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.value]);

  useEffect(() => {
    if (selectedId && !findBlock(history.value, selectedId)) setSelectedId(null);
  }, [history.value, selectedId]);

  // 首次打开时把当前首页编排落盘一次：预览 iframe 与结构树必须共用同一批区块 id，
  // 选中高亮、双击定位才找得到目标（默认编排的 id 是运行时生成的）。
  useEffect(() => {
    const storedHome = loadConfig()?.customization?.home;
    const hasStoredHome = !!storedHome && Array.isArray(storedHome.blocks) && storedHome.blocks.length > 0;
    if (hasStoredHome) return;
    update({ home: customization.home });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 预览 iframe 把“拖到真实位置”的目标回传到这里。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        targetId?: string;
        position?: 'before' | 'after';
        sourceId?: string;
        newType?: string;
        blockId?: string;
        width?: number;
        height?: number;
      } | null;
      if (data?.type === 'pp:preview-resize' && data.blockId) {
        if (typeof data.width !== 'number' || typeof data.height !== 'number') return;
        if (!findBlock(history.value, data.blockId)) return;
        changeBlocks(
          updateBlock(history.value, data.blockId, {
            width: Math.min(1600, Math.max(80, Math.round(data.width))),
            height: Math.min(2400, Math.max(40, Math.round(data.height))),
          }),
        );
        return;
      }
      if (data?.type !== 'pp:preview-drop' || !data.targetId) return;
      const targetLocation = findBlock(history.value, data.targetId);
      if (!targetLocation) return;
      const parentId = targetLocation.parent?.id ?? null;
      const column = targetLocation.column;
      const index = targetLocation.index + (data.position === 'after' ? 1 : 0);

      if (data.newType) {
        const block = createBlock(data.newType);
        changeBlocks(insertBlock(history.value, { parentId, column, index }, block));
        setSelectedId(block.id);
        setRightOpen(true);
        return;
      }
      if (data.sourceId) {
        changeBlocks(moveBlock(history.value, data.sourceId, { parentId, column, index }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.value]);

  const switchTarget = (next: string) => {
    const nextLayout =
      next === 'home'
        ? customization.home
        : next === 'article'
          ? (customization.article ?? { blocks: [] })
          : (customization.pages.find((page) => page.id === next)?.layout ?? { blocks: [] });
    const nextDevice = nextLayout.device_split ? device : 'desktop';
    setTarget(next);
    setDevice(nextDevice);
    setSelectedId(null);
    setResetOpen(false);
    history.reset(screenBlocksForDevice(nextLayout, nextDevice));
  };

  const changeBlocks = (next: typeof blocks) => history.commit(next);

  /** 双击组件（结构树或预览里）时：选中它，并让预览视角平滑移动到它。 */
  const locateBlock = (id: string) => {
    if (!id || !findBlock(history.value, id)) return;
    setSelectedId(id);
    setRightOpen(true);
    setLocateRequest({ blockId: id, nonce: Date.now() });
  };

  const remove = (id: string) => {
    changeBlocks(removeBlock(history.value, id));
    if (selectedId === id) setSelectedId(null);
  };

  const previewAnimation = (block: BlockInstance) => {
    setAnimationPreview({ blockId: block.id, animation: block.animation, nonce: Date.now() });
  };

  const updateRichText = (markdown: string) => {
    if (!richBlock) return;
    changeBlocks(updateBlock(history.value, richBlock.id, { props: { ...richBlock.props, body: markdown } }));
  };

  const resetCurrentPage = () => {
    if (target === 'home') {
      changeBlocks(defaultHomeLayout(customization.layout.variant).blocks);
    } else if (target === 'article') {
      changeBlocks([]);
    } else if (targetPage) {
      const template = targetPage.template ? templateById(targetPage.template) : undefined;
      changeBlocks(template ? template.build().layout.blocks : []);
    }
    setSelectedId(null);
    setResetOpen(false);
    toast.push(
      'ok',
      target === 'home' ? t('首页已恢复默认编排') : t('页面编排已恢复默认'),
      target === 'home'
        ? t('仍可以按 Ctrl/Cmd + Z 撤销。')
        : target === 'article'
          ? t('文章页附加区块已清空；文章正文与评论区不受影响。')
          : targetPage?.template
            ? t('已按原模板重建组件；页面正文、标题和路径没有改变。')
            : t('组件已清空，页面正文仍会显示。'),
    );
  };

  const previewUrl =
    target === 'home'
      ? '/'
      : target === 'article'
        ? articlePreviewUrl || '/articles'
        : targetPage
          ? `/${targetPage.slug}`
          : '/';
  const targetOptions = [
    { value: 'home', label: t('首页') },
    { value: 'article', label: t('文章页') },
    ...customization.pages.map((page) => ({
      value: page.id,
      label: t('页面：{title}', { title: page.title }),
    })),
  ];

  const undo = () => history.undo();
  const redo = () => history.redo();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const element = event.target as HTMLElement | null;
      if (!element) return;
      const tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.canUndo, history.canRedo]);

  const page = (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div
        className={`builder-fullscreen${leftOpen ? ' is-left-open' : ''}${
          rightOpen ? ' is-right-open' : ''
        }`}
        style={{ '--builder-canvas-bg': customization.theme.background } as CSSProperties}
      >
        <PreviewFrame
          url={previewUrl}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            if (id) setRightOpen(true);
          }}
          onLocate={locateBlock}
          locate={locateRequest}
          animationPreview={animationPreview}
          device={device}
          onDeviceChange={changeDevice}
          split={splitDevices}
          onSplitChange={toggleSplit}
        />

        <div className="builder-floating-top">
          <button
            type="button"
            className="builder-back"
            onClick={() => navigate('/admin')}
            aria-label={t('返回后台')}
          >
            <Icon name="arrow-left" size={15} />
          </button>
          <strong className="builder-brand">{t('页面编排')}</strong>
          <Select
            aria-label={t('编辑页面')}
            value={target}
            onChange={(event) => switchTarget(event.target.value)}
            className="builder-page-select"
          >
            {targetOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="sm" disabled={!history.canUndo} onClick={undo}>
            {t('撤销')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!history.canRedo} onClick={redo}>
            {t('重做')}
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => setResetOpen(true)}>
            {t('恢复默认')}
          </Button>
          <Badge tone="accent">{themeLabel}</Badge>
          <Link to="/admin/themes" className="btn btn-ghost btn-sm builder-appearance-link">
            <Icon name="palette" size={14} /> {t('主题设置')}
          </Link>
        </div>

        {leftOpen ? (
          <FloatingPanel side="left" title={t('组件与结构')} onClose={() => setLeftOpen(false)}>
            <BlockTreeEditor
              variant={customization.layout.variant}
              blocks={history.value}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                if (id) setRightOpen(true);
              }}
              onLocate={locateBlock}
              onChange={changeBlocks}
            />
          </FloatingPanel>
        ) : (
          <button type="button" className="builder-rail builder-rail-left" onClick={() => setLeftOpen(true)}>
            {t('组件')}
          </button>
        )}

        {rightOpen ? (
          <FloatingPanel
            side="right"
            title={t('区块属性')}
            onClose={() => setRightOpen(false)}
            aside={
              <button type="button" className="link-btn" onClick={() => setLogicOpen(true)}>
                {t('逻辑链')}
              </button>
            }
          >
            <BlockInspector
              block={selected}
              blocks={history.value}
              onChange={changeBlocks}
              onDelete={remove}
              onEditRichText={(block) => setRichBlock(block)}
              onPreviewAnimation={previewAnimation}
            />
          </FloatingPanel>
        ) : (
          <button type="button" className="builder-rail builder-rail-right" onClick={() => setRightOpen(true)}>
            {t('属性')}
          </button>
        )}

        <RichTextBlockModal block={richBlock} onClose={() => setRichBlock(null)} onSave={updateRichText} />

        <Modal
          open={logicOpen}
          title={t('无代码逻辑链')}
          description={t(
            '当…发生时，满足条件，就执行动作。逻辑保存在安装配置里，前台由 LogicRuntime 执行。',
          )}
          onClose={() => setLogicOpen(false)}
          width={980}
        >
          <ChainEditor
            logic={customization.logic}
            layout={{ blocks: history.value }}
            onChange={(logic) => update({ logic })}
          />
        </Modal>

        <Modal
          open={resetOpen}
          title={
            target === 'home'
              ? t('恢复首页的默认编排？')
              : target === 'article'
                ? t('清空文章页附加区块？')
                : targetPage
                ? t('恢复「{name}」的默认编排？', { name: targetPage.title })
                : t('恢复「页面」的默认编排？')
          }
          description={
            target === 'home'
              ? t('首页会回到当前布局变体的默认组件；仍可以撤销。')
              : target === 'article'
                ? t('只会清空文章页正文之后附加的区块；文章正文、评论区与 SEO 不受影响。')
                : targetPage?.template
                  ? t('会按原模板重建组件。页面正文、标题、路径与发布状态都不会改变。')
                  : t('这个页面没有模板，恢复后会清空组件；正文仍会显示。')
          }
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetOpen(false)}>
                {t('取消')}
              </Button>
              <Button variant="danger" onClick={resetCurrentPage} icon="refresh">
                {t('恢复默认')}
              </Button>
            </>
          }
        >
          <Callout tone="warn" icon="alert" title={t('只重置编排，不动内容')}>
            {t('文章、页面正文、评论、账户与媒体都不会被删除。恢复后可以按 Ctrl/Cmd + Z 撤销。')}
          </Callout>
        </Modal>
      </div>
    </RoleGate>
  );

  return typeof document === 'undefined' ? null : createPortal(page, document.body);
}
