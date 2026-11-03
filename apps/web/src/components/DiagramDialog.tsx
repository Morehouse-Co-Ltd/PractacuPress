import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartKind, DiagramSpec, DiagramType } from '../lib/diagramSpec';
import {
  DEFAULT_DIAGRAM_SPECS,
  DIAGRAM_LIMITS,
  DIAGRAM_TYPES,
  diagramBlockHtml,
  parseChartData,
  serializeChartData,
} from '../lib/diagramSpec';
import { renderDiagramSvg } from '../lib/diagramSvg';
import { useT } from '../lib/i18n';
import { Button, Field, Input, Modal, Select, Textarea } from './ui';

/**
 * 图表弹窗：选类型、填内容、实时预览，确认后插入 `pp-diagram` 围栏代码块。
 *
 * 图不存渲染结果，只存规格 JSON；阅读页由 lib/diagramHydrate.ts 水合成 SVG，
 * 所以同一份稿件换主题、换布局、改数据都能重新画。
 */
export function DiagramDialog({
  open,
  initial,
  onClose,
  onInsert,
}: {
  open: boolean;
  /** 光标已有图表块时传回它的规格，用来回填「编辑图表」。 */
  initial: DiagramSpec | null;
  onClose: () => void;
  onInsert: (html: string) => void;
}) {
  const t = useT();
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const [type, setType] = useState<DiagramType>('mindmap');
  const [title, setTitle] = useState('');
  const [outline, setOutline] = useState('');
  const [layout, setLayout] = useState<'both' | 'right'>('both');
  const [line, setLine] = useState<'curve' | 'elbow'>('curve');
  const [palette, setPalette] = useState<'colorful' | 'theme'>('colorful');
  const [direction, setDirection] = useState<'right' | 'down'>('right');
  const [chartKind, setChartKind] = useState<ChartKind>('bar');
  const [unit, setUnit] = useState('');
  const [chartData, setChartData] = useState('');

  /** 按类型把表单灌成某份规格（null 时用默认示例）。 */
  const fill = (spec: DiagramSpec | null) => {
    const base = spec ?? DEFAULT_DIAGRAM_SPECS.mindmap;
    setType(base.type);
    setTitle(base.title ?? '');
    if (base.type === 'mindmap') {
      setOutline(base.outline);
      setLayout(base.layout);
      setLine(base.line);
      setPalette(base.palette);
      return;
    }
    if (base.type === 'logic') {
      setOutline(base.outline);
      setDirection(base.direction);
      return;
    }
    if (base.type === 'chart') {
      setChartKind(base.kind);
      setUnit(base.unit ?? '');
      setChartData(serializeChartData(base.items));
      return;
    }
    setOutline(base.outline);
  };

  useEffect(() => {
    if (open) fill(initialRef.current);
    // 只在打开时回填：编辑过程中 initial/父组件重渲染不能覆盖作者输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 切换类型：换成该类型的默认示例，避免上一类的字段残留到另一类。 */
  const changeType = (next: DiagramType) => {
    if (next === type) return;
    fill(DEFAULT_DIAGRAM_SPECS[next]);
  };

  const spec = useMemo<DiagramSpec>(() => {
    const trimmed = title.trim().slice(0, DIAGRAM_LIMITS.title);
    const head = trimmed ? { title: trimmed } : {};
    switch (type) {
      case 'mindmap':
        return { type, ...head, outline, layout, line, palette };
      case 'logic':
        return { type, ...head, outline, direction };
      case 'chart':
        return {
          type,
          ...head,
          kind: chartKind,
          ...(unit.trim() ? { unit: unit.trim().slice(0, 12) } : {}),
          items: parseChartData(chartData),
        };
      default:
        return { type: 'fishbone', ...head, outline };
    }
  }, [type, title, outline, layout, line, palette, direction, chartKind, unit, chartData]);

  const preview = useMemo(() => renderDiagramSvg(spec), [spec]);

  const typeLabels: Record<DiagramType, string> = {
    mindmap: t('思维导图'),
    logic: t('逻辑图'),
    chart: t('统计图'),
    fishbone: t('鱼骨图'),
  };

  const outlineHint =
    type === 'mindmap'
      ? t('第一行是中心主题；用两个空格或 Tab 缩进表示下一层。')
      : type === 'logic'
        ? t('第一行是起点；缩进表示下一步或分支。')
        : t('第一行是问题/结果；一级是分类（鱼骨），二级是原因。');

  return (
    <Modal
      open={open}
      title={initial ? t('编辑图表') : t('插入图表')}
      description={t('图表随文章保存为 Markdown 围栏，阅读页按当前主题重新绘制。')}
      onClose={onClose}
      width={900}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button icon="check" onClick={() => onInsert(diagramBlockHtml(spec))}>
            {initial ? t('更新图表') : t('插入图表')}
          </Button>
        </>
      }
    >
      <div className="diagram-dialog-grid">
        <div className="form-stack">
          <Field label={t('图表类型')} htmlFor="diagram-type">
            <Select
              id="diagram-type"
              value={type}
              onChange={(event) => changeType(event.target.value as DiagramType)}
            >
              {DIAGRAM_TYPES.map((item) => (
                <option key={item} value={item}>
                  {typeLabels[item]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('图题')} htmlFor="diagram-title" hint={t('可选，显示在图的上方。')}>
            <Input
              id="diagram-title"
              value={title}
              maxLength={DIAGRAM_LIMITS.title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          {type === 'chart' ? (
            <>
              <Field label={t('统计类型')} htmlFor="diagram-chart-kind">
                <Select
                  id="diagram-chart-kind"
                  value={chartKind}
                  onChange={(event) => setChartKind(event.target.value as ChartKind)}
                >
                  <option value="bar">{t('柱状图')}</option>
                  <option value="line">{t('折线图')}</option>
                  <option value="donut">{t('环形图')}</option>
                  <option value="pie">{t('饼图')}</option>
                </Select>
              </Field>
              <Field label={t('单位')} htmlFor="diagram-unit" hint={t('可选，例如 次、%、篇。')}>
                <Input
                  id="diagram-unit"
                  value={unit}
                  maxLength={12}
                  onChange={(event) => setUnit(event.target.value)}
                />
              </Field>
              <Field
                label={t('数据')}
                htmlFor="diagram-chart-data"
                hint={t('每行一项：标签,数值。最多 {count} 项。', { count: DIAGRAM_LIMITS.chartItems })}
              >
                <Textarea
                  id="diagram-chart-data"
                  value={chartData}
                  onChange={(event) => setChartData(event.target.value)}
                  style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
              </Field>
            </>
          ) : (
            <Field
              label={type === 'fishbone' ? t('问题与原因') : t('结构与层级')}
              htmlFor="diagram-outline"
              hint={outlineHint}
            >
              <Textarea
                id="diagram-outline"
                value={outline}
                onChange={(event) => setOutline(event.target.value)}
                style={{ minHeight: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              />
            </Field>
          )}

          {type === 'mindmap' ? (
            <>
              <div className="form-grid">
                <Field label={t('展开方向')} htmlFor="diagram-layout">
                  <Select
                    id="diagram-layout"
                    value={layout}
                    onChange={(event) => setLayout(event.target.value as 'both' | 'right')}
                  >
                    <option value="both">{t('两侧展开')}</option>
                    <option value="right">{t('向右展开')}</option>
                  </Select>
                </Field>
                <Field label={t('连线')} htmlFor="diagram-line">
                  <Select
                    id="diagram-line"
                    value={line}
                    onChange={(event) => setLine(event.target.value as 'curve' | 'elbow')}
                  >
                    <option value="curve">{t('曲线')}</option>
                    <option value="elbow">{t('折线')}</option>
                  </Select>
                </Field>
              </div>
              <Field label={t('配色')} htmlFor="diagram-palette">
                <Select
                  id="diagram-palette"
                  value={palette}
                  onChange={(event) => setPalette(event.target.value as 'colorful' | 'theme')}
                >
                  <option value="colorful">{t('彩色分支')}</option>
                  <option value="theme">{t('主题单色')}</option>
                </Select>
              </Field>
            </>
          ) : null}

          {type === 'logic' ? (
            <Field label={t('流程方向')} htmlFor="diagram-direction">
              <Select
                id="diagram-direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as 'right' | 'down')}
              >
                <option value="right">{t('向右')}</option>
                <option value="down">{t('向下')}</option>
              </Select>
            </Field>
          ) : null}
        </div>

        <div>
          <p className="field-label">{t('实时预览')}</p>
          <div
            className="diagram-dialog-preview"
            data-diagram-preview="dialog"
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        </div>
      </div>
    </Modal>
  );
}
