import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import type { BlockInstance, LayoutVariant } from '../../types';
import { availableBlocks, createBlock, type BlockDefinition } from '../../lib/blocks';
import { pluginBlockRegistry } from '../../lib/plugins/registry';
import {
  MAX_BLOCKS,
  appendChild,
  columnCount,
  countBlocks,
  findBlock,
  insertBlock,
  moveBlock,
  removeBlock,
  stepTarget,
  updateBlock,
} from '../../lib/blockTree';
import { useT } from '../../lib/i18n';
import { Badge, Button } from '../ui';

/**
 * 递归区块树编辑器。
 *
 * 所有增删移动都落到 lib/blockTree 的纯函数上；这里只负责：
 * - 组件库点击/拖入；
 * - 递归行渲染；
 * - 分栏列投放区；
 * - 行首拖拽。
 *
 * 数组下标只在同一级内使用，跨级移动通过 parentId + column 表示。
 */

const MIME_BLOCK = 'application/x-pp-block';
const MIME_NEW = 'application/x-pp-new';

/**
 * 这一行下面还挂不挂子区块。
 *
 * 分栏按栏数分组，栅格与容器只有一个「子组件」组，其余类型只有在已经有子区块时
 * 才显示（旧配置里嵌套过就算数）。`grid` 必须在这里登记：空栅格在树里若是叶子，
 * 就没有可以投放的容器区，只能靠"拖到行上"这一条隐藏路径。
 */
function childHostColumns(block: BlockInstance): number {
  if (block.type === 'columns') return columnCount(block);
  if (block.type === 'grid') return 1;
  return block.type === 'container' || (block.children?.length ?? 0) > 0 ? 1 : 0;
}

interface AddTarget {
  parentId: string | null;
  column?: number;
}

function groupOf(type: string): 'layout' | 'media' | 'data' | 'content' | 'theme' {
  // 主题组件单独成组：它们的视觉与属性都由主题定义，和内置区块混排会让人分不清
  // 「换主题会不会丢掉它」。
  if (pluginBlockRegistry.has(type)) return 'theme';
  if (type === 'columns' || type === 'grid' || type === 'section' || type === 'text') return 'layout';
  if (type === 'image' || type === 'video' || type === 'website' || type === 'slideshow') return 'media';
  if (
    type === 'stats' ||
    type === 'chart' ||
    type === 'list' ||
    type === 'articles' ||
    type === 'code'
  ) {
    return 'data';
  }
  return 'content';
}

const GROUP_ORDER = ['layout', 'media', 'data', 'content', 'theme'] as const;

function Palette({
  variant,
  onAdd,
  onDragStart,
}: {
  variant: LayoutVariant;
  onAdd: (def: BlockDefinition) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, def: BlockDefinition) => void;
}) {
  const t = useT();
  // 扩展的激活是异步的：订阅注册表，主题组件装好后不刷新页面也能出现在面板里。
  const pluginRevision = useSyncExternalStore(
    pluginBlockRegistry.subscribe,
    pluginBlockRegistry.getVersion,
    pluginBlockRegistry.getVersion,
  );
  const grouped = useMemo(() => {
    const map: Record<string, BlockDefinition[]> = {
      layout: [],
      media: [],
      data: [],
      content: [],
      theme: [],
    };
    for (const def of availableBlocks(variant)) map[groupOf(def.type)].push(def);
    return map;
  }, [variant, pluginRevision]);
  /** 分组名：中文原文作键，渲染时按当前语言取值。 */
  const groupLabel: Record<string, string> = {
    layout: t('布局'),
    media: t('媒体'),
    data: t('数据与代码'),
    content: t('内容'),
    theme: t('主题组件'),
  };

  return (
    <div className="builder-palette">
      <div className="panel-head compact">
        <div>
          <h3>{t('组件')}</h3>
          <p>{t('点击追加，或拖到画布/分栏里。')}</p>
        </div>
      </div>
      {GROUP_ORDER.map((group) => (
        <details className="palette-group" key={group} open={group !== 'content'}>
          <summary className="field-label">{groupLabel[group]}</summary>
          <div className="palette-grid">
            {grouped[group].map((def) => (
              <button
                key={def.type}
                type="button"
                className="palette-item"
                draggable
                onDragStart={(event) => onDragStart(event, def)}
                onClick={() => onAdd(def)}
                title={def.description}
              >
                <strong>{def.name}</strong>
                <span>{def.description}</span>
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function DropZone({
  onDropBlock,
  onDropNew,
  label,
}: {
  onDropBlock: (id: string) => void;
  onDropNew: (type: string) => void;
  label?: string;
}) {
  const t = useT();
  const dropLabel = label ?? t('拖到这里');
  const [over, setOver] = useState(false);
  return (
    <div
      className={`tree-drop${over ? ' is-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MIME_NEW) ? 'copy' : 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const blockId = event.dataTransfer.getData(MIME_BLOCK) || event.dataTransfer.getData('text/plain');
        if (blockId && !blockId.startsWith('new:')) {
          onDropBlock(blockId);
          return;
        }
        const type =
          event.dataTransfer.getData(MIME_NEW) ||
          (blockId.startsWith('new:') ? blockId.slice(4) : '');
        if (type) onDropNew(type);
      }}
      data-drop-label={dropLabel}
    />
  );
}

export function BlockTreeEditor({
  variant,
  blocks,
  selectedId,
  onChange,
  onSelect,
  onLocate,
}: {
  variant: LayoutVariant;
  blocks: BlockInstance[];
  selectedId: string | null;
  onChange: (blocks: BlockInstance[]) => void;
  onSelect: (id: string | null) => void;
  /** 双击组件行：把预览视角移动到该组件。 */
  onLocate: (id: string) => void;
}) {
  const t = useT();
  const selected = findBlock(blocks, selectedId ?? '');
  const total = countBlocks(blocks);
  const full = total >= MAX_BLOCKS;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  // 在预览里双击/选中区块时，左侧结构树跟着滚动到对应行。
  useEffect(() => {
    if (!selectedId) return;
    const row = containerRef.current?.querySelector<HTMLElement>('.tree-row.is-selected');
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addAt = (target: AddTarget, type: string) => {
    if (countBlocks(blocks) >= MAX_BLOCKS) return;
    const parent = target.parentId ? findBlock(blocks, target.parentId)?.block : null;
    const index = parent?.children?.length ?? blocks.length;
    const block = createBlock(type);
    onChange(insertBlock(blocks, { ...target, index }, block));
    onSelect(block.id);
  };

  const addChild = (parentId: string, column: number, type: string) => {
    if (countBlocks(blocks) >= MAX_BLOCKS) return;
    const block = createBlock(type);
    onChange(appendChild(blocks, parentId, column, block));
    onSelect(block.id);
  };

  const handlePaletteAdd = (def: BlockDefinition) => {
    // 选中分栏或栅格时，从组件库点一个就加进去——和「拖到栏里」等价。
    if (selected?.block.type === 'columns' || selected?.block.type === 'grid') {
      addChild(selected.block.id, 1, def.type);
      return;
    }
    addAt({ parentId: null }, def.type);
  };

  const move = (id: string, direction: -1 | 1) => {
    const location = findBlock(blocks, id);
    if (!location) return;
    const siblings = location.parent?.children ?? blocks;
    const index = location.index + direction;
    if (index < 0 || index >= siblings.length) return;
    onChange(moveBlock(blocks, id, stepTarget(location, direction)));
  };

  const remove = (id: string) => {
    onChange(removeBlock(blocks, id));
    if (selectedId === id) onSelect(null);
  };

  const toggleHidden = (block: BlockInstance) => {
    onChange(updateBlock(blocks, block.id, { hidden: !block.hidden }));
  };

  const renderRows = (
    list: BlockInstance[],
    parentId: string | null,
    depth = 0,
  ): ReactNode => (
    <div className="tree-rows">
      {list.map((block, index) => {
        const isSelected = block.id === selectedId;
        const cols = childHostColumns(block);
        const childCount = block.children?.length ?? 0;
        const isCollapsed = collapsed.has(block.id);
        return (
          <div className="tree-node" key={block.id} data-depth={depth}>
            <div
              className={`tree-row${isSelected ? ' is-selected' : ''}${block.hidden ? ' is-hidden' : ''}${
                cols > 0 ? ' is-parent' : ''
              }`}
              data-depth={depth}
              draggable
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData(MIME_BLOCK, block.id);
                event.dataTransfer.setData('text/plain', block.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(MIME_BLOCK) || event.dataTransfer.types.includes(MIME_NEW)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MIME_NEW) ? 'copy' : 'move';
                  event.currentTarget.classList.add('is-nest-target');
                }
              }}
              onDragLeave={(event) => {
                event.currentTarget.classList.remove('is-nest-target');
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.classList.remove('is-nest-target');
                const dragged = event.dataTransfer.getData(MIME_BLOCK) || event.dataTransfer.getData('text/plain');
                const newType = event.dataTransfer.getData(MIME_NEW);
                if (newType) {
                  addChild(block.id, 1, newType);
                  return;
                }
                if (!dragged || dragged === block.id) return;
                // 拖到组件行上 = 成为它的子图层，而不是同级排序。
                onChange(
                  moveBlock(blocks, dragged, {
                    parentId: block.id,
                    column: 1,
                    index: block.children?.length ?? 0,
                  }),
                );
              }}
              onClick={() => onSelect(block.id)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onSelect(block.id);
                onLocate(block.id);
              }}
            >
              {cols > 0 ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={isCollapsed ? t('展开子组件') : t('收起子组件')}
                  aria-expanded={!isCollapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleCollapse(block.id);
                  }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              ) : (
                <span className="tree-toggle tree-toggle-spacer" aria-hidden />
              )}
              <span className="tree-grip" aria-hidden>⠿</span>
              <span className="tree-main">
                <strong>{block.title || block.type}</strong>
                <span className="tree-meta">
                  <Badge tone="muted">{block.type}</Badge>
                  {cols > 0 ? (
                    <span className="tree-child-count">{t('{count} 子项', { count: childCount })}</span>
                  ) : null}
                  {block.animation !== 'none' ? <span>{block.animation}</span> : null}
                  {block.hidden ? <span>{t('已隐藏')}</span> : null}
                </span>
              </span>
              <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
                <button type="button" className="icon-btn" title={t('上移')} onClick={() => move(block.id, -1)}>
                  ↑
                </button>
                <button type="button" className="icon-btn" title={t('下移')} onClick={() => move(block.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={block.hidden ? t('显示') : t('隐藏')}
                  onClick={() => toggleHidden(block)}
                >
                  {block.hidden ? '◌' : '◉'}
                </button>
                <button type="button" className="icon-btn danger" title={t('删除')} onClick={() => remove(block.id)}>
                  ×
                </button>
              </span>
            </div>

            {cols > 0 && !isCollapsed ? (
              <div className="tree-children">
                {Array.from({ length: cols }, (_, columnIndex) => {
                  const column = columnIndex + 1;
                  const children = (block.children ?? []).filter((child) => (child.column ?? 1) === column);
                  return (
                    <div
                      className="tree-column"
                      key={column}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MIME_NEW) ? 'copy' : 'move';
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const blockId =
                          event.dataTransfer.getData(MIME_BLOCK) ||
                          event.dataTransfer.getData('text/plain');
                        if (blockId && !blockId.startsWith('new:')) {
                          onChange(
                            moveBlock(blocks, blockId, {
                              parentId: block.id,
                              column,
                              index: (block.children ?? []).filter((child) => (child.column ?? 1) === column).length,
                            }),
                          );
                          return;
                        }
                        const type =
                          event.dataTransfer.getData(MIME_NEW) ||
                          (blockId.startsWith('new:') ? blockId.slice(4) : '');
                        if (type) addChild(block.id, column, type);
                      }}
                    >
                      <p className="tree-column-label">
                        {block.type === 'columns' ? t('第 {index} 栏', { index: column }) : t('子组件')}
                        <span>{children.length}</span>
                      </p>
                      {renderRows(children, block.id, depth + 1)}
                      <DropZone
                        label={t('拖入第 {index} 栏', { index: column })}
                        onDropBlock={(id) =>
                          onChange(
                            moveBlock(blocks, id, {
                              parentId: block.id,
                              column,
                              index: (block.children ?? []).filter((child) => (child.column ?? 1) === column).length,
                            }),
                          )
                        }
                        onDropNew={(type) => addChild(block.id, column, type)}
                      />
                      <div className="tree-column-add">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="plus"
                          disabled={full}
                          onClick={() => addChild(block.id, column, 'text')}
                        >
                          {t('文本')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="plus"
                          disabled={full}
                          onClick={() => addChild(block.id, column, 'columns')}
                        >
                          {t('分栏')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="plus"
                          disabled={full}
                          onClick={() => addChild(block.id, column, 'container')}
                        >
                          {t('容器')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {parentId === null ? (
              <DropZone
                label={t('拖到这里排序')}
                onDropBlock={(id) => onChange(moveBlock(blocks, id, { parentId: null, index: index + 1 }))}
                onDropNew={(type) => addAt({ parentId: null }, type)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="builder-left panel" ref={containerRef}>
      <Palette
        variant={variant}
        onAdd={handlePaletteAdd}
        onDragStart={(event, def) => {
          event.dataTransfer.setData(MIME_NEW, def.type);
          event.dataTransfer.setData('text/plain', `new:${def.type}`);
          event.dataTransfer.effectAllowed = 'copy';
        }}
      />
      <div className="panel-head compact">
        <div>
          <h3>{t('页面结构')}</h3>
          <p>
            {t('{count} 个区块', { count: total })}
            {selected ? t(' · 已选「{title}」', { title: selected.block.title || selected.block.type }) : ''}
          </p>
        </div>
      </div>
      {blocks.length === 0 ? (
        <div className="builder-empty">
          <p>{t('还没有区块。从上方组件库点击添加，或把组件拖进来。')}</p>
        </div>
      ) : (
        <>
          {renderRows(blocks, null)}
          <DropZone
            label={t('拖到页面末尾')}
            onDropBlock={(id) => onChange(moveBlock(blocks, id, { parentId: null, index: blocks.length }))}
            onDropNew={(type) => addAt({ parentId: null }, type)}
          />
        </>
      )}
      {full ? <p className="field-hint">{t('已达到 200 个区块上限，删除一些再添加。')}</p> : null}
    </div>
  );
}
