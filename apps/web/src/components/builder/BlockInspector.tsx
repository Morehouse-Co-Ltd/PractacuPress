import type {
  BlockAnimation,
  BlockAppearance,
  BlockArea,
  BlockDisplayOverride,
  BlockInstance,
  BuilderDevice,
} from '../../types';
import { findBlock, updateBlock } from '../../lib/blockTree';
import {
  BLOCK_BACKGROUND_FALLBACK,
  BLOCK_CROP_OPTIONS,
  BLOCK_PADDING_RANGE,
  BLOCK_RADIUS_OPTIONS,
  BLOCK_SHADOW_OPTIONS,
  hasBlockAppearance,
} from '../../lib/blockAppearance';
import { overlayAt, overrideOf, writeOverride } from '../../lib/layout';
import { useT } from '../../lib/i18n';
import { BlockProps } from './BlockProps';
import { Field, Input, Select, Textarea, Toggle, Button, Badge } from '../ui';

const ANIMATIONS: BlockAnimation[] = ['none', 'fade', 'fade-up', 'slide-left', 'slide-right', 'zoom'];

const AREAS: BlockArea[] = ['full', 'main', 'side'];

/**
 * 展示层字段：能按设备覆盖的、也就是「恢复继承」能清掉的全部内容。
 * 内容（`props`）不在其中——内容永远只有一份，这是 P0 定下的规矩。
 */
const DISPLAY_KEYS = [
  'span',
  'appearance',
  'animation',
  'hidden',
  'custom_css',
  'width',
  'height',
  'align',
  'gap_scale',
  'mt',
  'mb',
] as const;

/**
 * 右栏检查器。属性表单继续由 BlockProps 的 schema 驱动；这里只放编排相关的
 * 标题、动画、落位、子区块信息和删除操作。
 */
export function BlockInspector({
  block,
  blocks,
  device,
  onChange,
  onDelete,
  onEditRichText,
  onPreviewAnimation,
}: {
  block: BlockInstance | null;
  blocks: BlockInstance[];
  /** 当前预览设备：非桌面时展示层编辑写进 `at[device]` 覆盖层。 */
  device: BuilderDevice;
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
  /** 当前设备这一层的覆盖；桌面没有层，永远是 undefined。 */
  const local = overrideOf(block, device);
  /**
   * 表单显示的是「这一层生效后的样子」：手机上看到的就是手机上的实际观感，
   * 而不是被覆盖掉的基础值。
   */
  const view = overlayAt(block, device);
  /** 这项是不是当前设备单独设过的（用于「已覆盖」标记）。 */
  const overridden = (key: keyof BlockDisplayOverride) => local?.[key] !== undefined;
  const overriddenAppearance = (key: keyof BlockAppearance) =>
    local?.appearance?.[key] !== undefined;
  /**
   * 展示层字段的写入通道。
   *
   * 桌面走 `writeOverride` 的基础字段合并（与改造前逐字节一致），平板 / 手机落进
   * `at[device]`，基础编排一动不动。非桌面会先把「本来就等于基础值」的编辑抹成
   * undefined：覆盖层只记真正的差异，点回原值就等于恢复继承。
   */
  const writeDisplay = (override: BlockDisplayOverride) => {
    const patchable: BlockDisplayOverride =
      device === 'desktop'
        ? override
        : (Object.fromEntries(
            Object.entries(override).map(([key, value]) => [
              key,
              value === block[key as keyof BlockInstance] ? undefined : value,
            ]),
          ) as BlockDisplayOverride);
    const next = writeOverride(block, device, patchable);
    const changed: Partial<BlockInstance> = {};
    for (const key of DISPLAY_KEYS) {
      if (next[key] !== block[key]) Object.assign(changed, { [key]: next[key] });
    }
    // 非桌面还要写回覆盖层本身；undefined 就是「恢复继承」。
    if (device !== 'desktop') changed.at = next.at;
    if (Object.keys(changed).length) patch(changed);
  };
  const appearance: BlockAppearance = view.appearance ?? {};
  /**
   * 写一项外观。
   *
   * 空值（未选、空串、0、false）或「本来就等于基础值」都不算覆盖：桌面直接从配置里
   * 删掉，其他设备写 undefined 让这一项恢复继承——覆盖层只留真正的差异。
   */
  const updateAppearance = (key: keyof BlockAppearance, value: unknown) => {
    const emptied = value === undefined || value === '' || value === 0 || value === false;
    if (device === 'desktop') {
      const next: BlockAppearance = { ...appearance };
      if (emptied) {
        delete next[key];
      } else {
        Object.assign(next, { [key]: value });
      }
      patch({ appearance: hasBlockAppearance(next) ? next : undefined });
      return;
    }
    const inherited = emptied || value === (block.appearance ?? {})[key];
    const delta: BlockAppearance = {};
    Object.assign(delta, { [key]: inherited ? undefined : value });
    writeDisplay({ appearance: delta });
  };
  /** 「清除外观」：桌面清基础外观，其他设备清掉这一层的外观覆盖。 */
  const clearAppearance = () => {
    if (device === 'desktop') patch({ appearance: undefined });
    else writeDisplay({ appearance: undefined });
  };
  const clearDeviceOverride = () => writeDisplay({});
  const deviceLabels: Record<BuilderDevice, string> = {
    desktop: t('桌面'),
    tablet: t('平板'),
    mobile: t('手机'),
  };
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
        {device !== 'desktop' ? (
          <div className="inspector-children">
            <div className="inspector-section-head">
              <span className="field-hint">{t('只改这一台设备；其他设备保持原样。')}</span>
              <span className="row gap-8">
                <Badge tone="accent">{deviceLabels[device]}</Badge>
                <button
                  type="button"
                  className="link-btn"
                  disabled={!local}
                  onClick={clearDeviceOverride}
                >
                  {t('恢复继承')}
                </button>
              </span>
            </div>
          </div>
        ) : null}
        <Field label={t('后台显示名')} hint={t('只影响编排器里的识别，不改变前台内容。')}>
          <Input value={block.title} onChange={(event) => patch({ title: event.target.value })} />
        </Field>
        <Field
          label={t('入场动画')}
          aside={overridden('animation') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
        >
          <Select
            value={view.animation}
            onChange={(event) => {
              const next = event.target.value as BlockAnimation;
              writeDisplay({ animation: next });
              onPreviewAnimation({ ...view, animation: next });
            }}
          >
            {ANIMATIONS.map((item) => (
              <option key={item} value={item}>
                {animationLabels[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" size="sm" icon="eye" onClick={() => onPreviewAnimation(view)}>
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
          <Field
            label={t('组件宽度')}
            hint={t('0 表示自动；也可以直接拖预览右下角。')}
            aside={overridden('width') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
          >
            <Input
              type="number"
              min={0}
              max={1600}
              value={view.width ?? 0}
              onChange={(event) => {
                const width = Math.max(0, Math.min(1600, Number(event.target.value) || 0));
                writeDisplay({ width: width || undefined });
              }}
            />
          </Field>
          <Field
            label={t('最小高度')}
            hint={t('0 表示由内容撑开。')}
            aside={overridden('height') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
          >
            <Input
              type="number"
              min={0}
              max={2400}
              value={view.height ?? 0}
              onChange={(event) => {
                const height = Math.max(0, Math.min(2400, Number(event.target.value) || 0));
                writeDisplay({ height: height || undefined });
              }}
            />
          </Field>
        </div>
        <div className="inspector-appearance">
          <div className="inspector-section-head">
            <strong>{t('组件外观')}</strong>
            <button
              type="button"
              className="link-btn"
              disabled={device === 'desktop' ? !hasBlockAppearance(block.appearance) : !local?.appearance}
              onClick={clearAppearance}
            >
              {t('清除外观')}
            </button>
          </div>
          <div className="form-grid">
            <Field
              label={t('圆角')}
              hint={t('作用在组件最外层；要让图片或子组件也一起切角，再打开「裁剪」。')}
              aside={overriddenAppearance('radius') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
            >
              <Select
                id="appearance-radius"
                value={appearance.radius ?? 'none'}
                onChange={(event) => updateAppearance('radius', event.target.value === 'none' ? 'none' : event.target.value)}
              >
                {BLOCK_RADIUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('阴影')}
              hint={t('跟随明暗主题的柔和投影；「强调光晕」用站点主色。')}
              aside={overriddenAppearance('shadow') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
            >
              <Select
                id="appearance-shadow"
                value={appearance.shadow ?? 'none'}
                onChange={(event) => updateAppearance('shadow', event.target.value === 'none' ? 'none' : event.target.value)}
              >
                {BLOCK_SHADOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field
              label={t('裁剪')}
              hint={t('裁剪溢出内容，或按比例裁成相框；文字型组件慎用固定比例。')}
              aside={overriddenAppearance('crop') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
            >
              <Select
                id="appearance-crop"
                value={appearance.crop ?? 'none'}
                onChange={(event) => updateAppearance('crop', event.target.value === 'none' ? 'none' : event.target.value)}
              >
                {BLOCK_CROP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('内边距')}
              hint={t('单位 px，0 表示不额外留白；配合背景色可以把组件做成卡片。')}
              aside={overriddenAppearance('padding') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
            >
              <Input
                id="appearance-padding"
                type="number"
                min={BLOCK_PADDING_RANGE.min}
                max={BLOCK_PADDING_RANGE.max}
                step={BLOCK_PADDING_RANGE.step}
                value={appearance.padding ?? 0}
                onChange={(event) => {
                  const next = Math.min(
                    BLOCK_PADDING_RANGE.max,
                    Math.max(BLOCK_PADDING_RANGE.min, Math.round(Number(event.target.value) || 0)),
                  );
                  updateAppearance('padding', next);
                }}
              />
            </Field>
          </div>
          <Field
            label={t('背景色')}
            hint={t('为空表示透明。配合内边距可以把组件做成卡片。')}
            aside={overriddenAppearance('background') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
          >
            <div className="color-field appearance-color">
              <input
                id="appearance-bg"
                type="color"
                value={appearance.background ?? BLOCK_BACKGROUND_FALLBACK}
                aria-label={t('组件背景色')}
                onChange={(event) => updateAppearance('background', event.target.value)}
              />
              <code>{appearance.background ?? t('透明')}</code>
              {appearance.background ? (
                <button type="button" className="link-btn" onClick={() => updateAppearance('background', undefined)}>
                  {t('清除')}
                </button>
              ) : null}
            </div>
          </Field>
          <Toggle
            checked={Boolean(appearance.border)}
            onChange={(next) => updateAppearance('border', next || undefined)}
            label={t('主题描边')}
            description={
              overriddenAppearance('border')
                ? t('已覆盖：只对这一台设备生效。')
                : t('用主题的细分割线颜色描一圈边框。')
            }
          />
        </div>
        <Field
          label={t('组件 CSS')}
          hint={t('只写声明，例如 padding: 24px; border: 1px solid var(--line); 只作用于当前组件，可复制到其他组件复用。')}
          aside={overridden('custom_css') ? <Badge tone="accent">{t('已覆盖')}</Badge> : undefined}
        >
          <Textarea
            value={view.custom_css ?? ''}
            onChange={(event) => writeDisplay({ custom_css: event.target.value || undefined })}
            style={{ minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </Field>
        <Toggle
          checked={view.hidden}
          onChange={(next) => writeDisplay({ hidden: next })}
          label={t('在页面中隐藏')}
          description={overridden('hidden') ? t('已覆盖：只对这一台设备生效。') : undefined}
        />
        <BlockProps block={view} onChange={(props) => patch({ props })} />
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
