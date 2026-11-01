import type { BlockAnimation, BlockArea, BlockInstance } from '../../types';
import { findBlock, updateBlock } from '../../lib/blockTree';
import { BlockProps } from './BlockProps';
import { Field, Input, Select, Textarea, Toggle, Button, Badge } from '../ui';

const ANIMATIONS: { value: BlockAnimation; label: string }[] = [
  { value: 'none', label: '无动画' },
  { value: 'fade', label: '淡入' },
  { value: 'fade-up', label: '上浮淡入' },
  { value: 'slide-left', label: '左侧滑入' },
  { value: 'slide-right', label: '右侧滑入' },
  { value: 'zoom', label: '缩放进入' },
];

const AREA_LABEL: Record<BlockArea, string> = {
  full: '整幅',
  main: '主栏',
  side: '侧栏',
};

/**
 * 右栏检查器。属性表单继续由 BlockProps 的 schema 驱动；这里只放编排相关的
 * 标题、动画、落位、子区块信息和删除操作。
 */
export function BlockInspector({
  block,
  blocks,
  onChange,
  onDelete,
  onEditRichText,
  onPreviewAnimation,
}: {
  block: BlockInstance | null;
  blocks: BlockInstance[];
  onChange: (blocks: BlockInstance[]) => void;
  onDelete: (id: string) => void;
  onEditRichText: (block: BlockInstance) => void;
  onPreviewAnimation: (block: BlockInstance) => void;
}) {
  if (!block) {
    return (
      <aside className="builder-inspector panel">
        <div className="panel-body">
          <p className="field-hint">在左侧或预览里选中一个区块，这里会出现它的属性。</p>
        </div>
      </aside>
    );
  }

  const location = findBlock(blocks, block.id);
  const parent = location?.parent ?? null;
  const patch = (next: Partial<BlockInstance>) => onChange(updateBlock(blocks, block.id, next));
  const columns = block.type === 'columns' ? Math.min(4, Math.max(2, Number(block.props.columns ?? 2))) : 0;
  const children = block.children ?? [];

  return (
    <aside className="builder-inspector panel">
      <div className="panel-head compact">
        <div>
          <h3>区块属性</h3>
          <p>
            <Badge tone="muted">{block.type}</Badge>
            {parent ? <span className="faint small"> 位于「{parent.title}」内</span> : null}
          </p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <Field label="后台显示名" hint="只影响编排器里的识别，不改变前台内容。">
          <Input value={block.title} onChange={(event) => patch({ title: event.target.value })} />
        </Field>
        <Field label="入场动画">
          <Select
            value={block.animation}
            onChange={(event) => {
              const next = event.target.value as BlockAnimation;
              patch({ animation: next });
              onPreviewAnimation({ ...block, animation: next });
            }}
          >
            {ANIMATIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" size="sm" icon="eye" onClick={() => onPreviewAnimation(block)}>
          预览动画
        </Button>
        {block.type === 'text' ? (
          <Button variant="secondary" size="sm" icon="edit" onClick={() => onEditRichText(block)}>
            富文本编辑
          </Button>
        ) : null}
        {parent ? (
          <Field label="所在栏">
            <Select
              value={String(block.column ?? 1)}
              onChange={(event) => patch({ column: Number(event.target.value) })}
            >
              {Array.from({ length: Math.max(1, Number(parent.props.columns ?? 2)) }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  第 {index + 1} 栏
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="夜航布局落位" hint="只在夜航（bento）布局下生效。">
            <Select
              value={block.area ?? 'main'}
              onChange={(event) => patch({ area: event.target.value as BlockArea })}
            >
              {(['full', 'main', 'side'] as BlockArea[]).map((area) => (
                <option key={area} value={area}>
                  {AREA_LABEL[area]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="form-grid">
          <Field label="组件宽度" hint="0 表示自动；也可以直接拖预览右下角。">
            <Input
              type="number"
              min={0}
              max={1600}
              value={block.width ?? 0}
              onChange={(event) => {
                const width = Math.max(0, Math.min(1600, Number(event.target.value) || 0));
                patch({ width: width || undefined });
              }}
            />
          </Field>
          <Field label="最小高度" hint="0 表示由内容撑开。">
            <Input
              type="number"
              min={0}
              max={2400}
              value={block.height ?? 0}
              onChange={(event) => {
                const height = Math.max(0, Math.min(2400, Number(event.target.value) || 0));
                patch({ height: height || undefined });
              }}
            />
          </Field>
        </div>
        <Field
          label="组件 CSS"
          hint="只写声明，例如 padding: 24px; border: 1px solid var(--line); 只作用于当前组件，可复制到其他组件复用。"
        >
          <Textarea
            value={block.custom_css ?? ''}
            onChange={(event) => patch({ custom_css: event.target.value || undefined })}
            style={{ minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </Field>
        <Toggle checked={block.hidden} onChange={(next) => patch({ hidden: next })} label="在页面中隐藏" />
        <BlockProps block={block} onChange={(props) => patch({ props })} />
        {columns > 0 ? (
          <div className="inspector-children">
            <p className="field-label">分栏内容</p>
            <p className="field-hint">
              共 {children.length} 个子区块。直接在左侧把组件拖进对应栏，或用栏位里的“文本/分栏”按钮添加。
            </p>
          </div>
        ) : null}
        <div className="row gap-8">
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            onClick={() => onDelete(block.id)}
          >
            删除区块
          </Button>
        </div>
      </div>
    </aside>
  );
}
