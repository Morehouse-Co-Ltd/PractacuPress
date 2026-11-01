import type { BlockAnimation, BlockArea, BlockInstance } from '../../types';
import { findBlock, updateBlock } from '../../lib/blockTree';
import { useT } from '../../lib/i18n';
import { BlockProps } from './BlockProps';
import { Field, Input, Select, Textarea, Toggle, Button, Badge } from '../ui';

const ANIMATIONS: BlockAnimation[] = ['none', 'fade', 'fade-up', 'slide-left', 'slide-right', 'zoom'];

const AREAS: BlockArea[] = ['full', 'main', 'side'];

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
  const t = useT();

  if (!block) {
    return (
      <aside className="builder-inspector panel">
        <div className="panel-body">
          <p className="field-hint">{t('在左侧或预览里选中一个区块，这里会出现它的属性。')}</p>
        </div>
      </aside>
    );
  }

  const location = findBlock(blocks, block.id);
  const parent = location?.parent ?? null;
  const patch = (next: Partial<BlockInstance>) => onChange(updateBlock(blocks, block.id, next));
  const columns = block.type === 'columns' ? Math.min(4, Math.max(2, Number(block.props.columns ?? 2))) : 0;
  const children = block.children ?? [];
  /** 动画名与落位名：中文原文作键，渲染时按当前语言取值。 */
  const animationLabels: Record<BlockAnimation, string> = {
    none: t('无动画'),
    fade: t('淡入'),
    'fade-up': t('上浮淡入'),
    'slide-left': t('左侧滑入'),
    'slide-right': t('右侧滑入'),
    zoom: t('缩放进入'),
  };
  const areaLabels: Record<BlockArea, string> = {
    full: t('整幅'),
    main: t('主栏'),
    side: t('侧栏'),
  };

  return (
    <aside className="builder-inspector panel">
      <div className="panel-head compact">
        <div>
          <h3>{t('区块属性')}</h3>
          <p>
            <Badge tone="muted">{block.type}</Badge>
            {parent ? (
              <span className="faint small"> {t('位于「{title}」内', { title: parent.title })}</span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <Field label={t('后台显示名')} hint={t('只影响编排器里的识别，不改变前台内容。')}>
          <Input value={block.title} onChange={(event) => patch({ title: event.target.value })} />
        </Field>
        <Field label={t('入场动画')}>
          <Select
            value={block.animation}
            onChange={(event) => {
              const next = event.target.value as BlockAnimation;
              patch({ animation: next });
              onPreviewAnimation({ ...block, animation: next });
            }}
          >
            {ANIMATIONS.map((item) => (
              <option key={item} value={item}>
                {animationLabels[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" size="sm" icon="eye" onClick={() => onPreviewAnimation(block)}>
          {t('预览动画')}
        </Button>
        {block.type === 'text' ? (
          <Button variant="secondary" size="sm" icon="edit" onClick={() => onEditRichText(block)}>
            {t('富文本编辑')}
          </Button>
        ) : null}
        {parent ? (
          <Field label={t('所在栏')}>
            <Select
              value={String(block.column ?? 1)}
              onChange={(event) => patch({ column: Number(event.target.value) })}
            >
              {Array.from({ length: Math.max(1, Number(parent.props.columns ?? 2)) }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  {t('第 {index} 栏', { index: index + 1 })}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('夜航布局落位')} hint={t('只在夜航（bento）布局下生效。')}>
            <Select
              value={block.area ?? 'main'}
              onChange={(event) => patch({ area: event.target.value as BlockArea })}
            >
              {AREAS.map((area) => (
                <option key={area} value={area}>
                  {areaLabels[area]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="form-grid">
          <Field label={t('组件宽度')} hint={t('0 表示自动；也可以直接拖预览右下角。')}>
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
          <Field label={t('最小高度')} hint={t('0 表示由内容撑开。')}>
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
          label={t('组件 CSS')}
          hint={t('只写声明，例如 padding: 24px; border: 1px solid var(--line); 只作用于当前组件，可复制到其他组件复用。')}
        >
          <Textarea
            value={block.custom_css ?? ''}
            onChange={(event) => patch({ custom_css: event.target.value || undefined })}
            style={{ minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </Field>
        <Toggle checked={block.hidden} onChange={(next) => patch({ hidden: next })} label={t('在页面中隐藏')} />
        <BlockProps block={block} onChange={(props) => patch({ props })} />
        {columns > 0 ? (
          <div className="inspector-children">
            <p className="field-label">{t('分栏内容')}</p>
            <p className="field-hint">
              {t('共 {count} 个子区块。直接在左侧把组件拖进对应栏，或用栏位里的“文本/分栏”按钮添加。', {
                count: children.length,
              })}
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
            {t('删除区块')}
          </Button>
        </div>
      </div>
    </aside>
  );
}
