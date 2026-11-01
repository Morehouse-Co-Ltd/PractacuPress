import type { BlockInstance } from '../../types';
import { blockDef, blockProp, type PropSchema } from '../../lib/blocks';
import { useT } from '../../lib/i18n';
import { Field, Input, Select, Textarea, Toggle } from '../ui';

/**
 * 区块属性编辑器：完全由 BLOCK_DEFS 里的 schema 驱动。
 * 新增组件不需要改这里——只要在注册表里声明 schema，表单自动生成。
 */

function PropControl({
  block,
  schema,
  onChange,
}: {
  block: BlockInstance;
  schema: PropSchema;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  const t = useT();
  const id = `blk-${block.id}-${schema.key}`;

  if (schema.type === 'itemlist') {
    const raw = typeof block.props[schema.key] === 'string' ? (block.props[schema.key] as string) : '';
    let items: Record<string, string>[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        items = parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => {
            const entry: Record<string, string> = {};
            for (const [k, v] of Object.entries(item)) {
              if (typeof v === 'string' || typeof v === 'number') entry[k] = String(v);
            }
            return entry;
          });
      }
    } catch {
      items = [];
    }

    const commit = (next: Record<string, string>[]) => {
      onChange(schema.key, JSON.stringify(next.slice(0, schema.maxItems ?? 30)));
    };

    return (
      <Field
        label={schema.label}
        hint={schema.hint ?? t('最多 {count} 条。', { count: schema.maxItems ?? 30 })}
        aside={`${items.length}/${schema.maxItems ?? 30}`}
      >
        <div className="itemlist">
          {items.map((item, index) => (
            <div className="itemlist-row" key={index}>
              {(schema.itemFields ?? []).map((field) => (
                <label key={field.key} className="itemlist-field">
                  <span>{field.label}</span>
                  <input
                    type={field.type === 'color' ? 'color' : 'text'}
                    value={item[field.key] ?? ''}
                    onChange={(event) => {
                      const next = items.map((entry, i) =>
                        i === index ? { ...entry, [field.key]: event.target.value } : entry,
                      );
                      commit(next);
                    }}
                    aria-label={t('{label} 第 {index} 条 {field}', {
                      label: schema.label,
                      index: index + 1,
                      field: field.label,
                    })}
                  />
                </label>
              ))}
              <button
                type="button"
                className="link-btn"
                onClick={() => commit(items.filter((_, i) => i !== index))}
              >
                {t('删除')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={items.length >= (schema.maxItems ?? 30)}
            onClick={() => {
              const blank: Record<string, string> = {};
              for (const field of schema.itemFields ?? []) blank[field.key] = '';
              commit([...items, blank]);
            }}
          >
            {t('添加{label}', { label: schema.itemLabel ?? t('条目') })}
          </button>
        </div>
      </Field>
    );
  }

  if (schema.type === 'toggle') {
    return (
      <Toggle
        checked={blockProp(block, schema.key, false)}
        onChange={(next) => onChange(schema.key, next)}
        label={schema.label}
        description={schema.hint}
      />
    );
  }

  if (schema.type === 'select') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <Select
          id={id}
          value={String(block.props[schema.key] ?? schema.options?.[0]?.value ?? '')}
          onChange={(event) => onChange(schema.key, event.target.value)}
        >
          {(schema.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (schema.type === 'number') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <Input
          id={id}
          type="number"
          min={schema.min}
          max={schema.max}
          step={schema.step ?? 1}
          value={Number(block.props[schema.key] ?? 0)}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            const clamped = Math.min(schema.max ?? 1e6, Math.max(schema.min ?? -1e6, next));
            onChange(schema.key, clamped);
          }}
        />
      </Field>
    );
  }

  if (schema.type === 'color') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <div className="color-field">
          <input
            id={id}
            type="color"
            value={String(block.props[schema.key] ?? '#c4b5fd')}
            onChange={(event) => onChange(schema.key, event.target.value)}
          />
          <code>{String(block.props[schema.key] ?? '')}</code>
        </div>
      </Field>
    );
  }

  if (schema.type === 'textarea') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <Textarea
          id={id}
          value={String(block.props[schema.key] ?? '')}
          onChange={(event) => onChange(schema.key, event.target.value)}
          style={{ minHeight: 76 }}
        />
      </Field>
    );
  }

  return (
    <Field label={schema.label} hint={schema.hint} htmlFor={id}>
      <Input
        id={id}
        value={String(block.props[schema.key] ?? '')}
        onChange={(event) => onChange(schema.key, event.target.value)}
      />
    </Field>
  );
}

export function BlockProps({
  block,
  onChange,
}: {
  block: BlockInstance;
  onChange: (props: Record<string, string | number | boolean>) => void;
}) {
  const t = useT();
  const def = blockDef(block.type);
  if (!def) return <p className="field-hint">{t('这个组件类型已不存在，删除它再添加新的。')}</p>;
  if (!def.schema.length) return <p className="field-hint">{t('这个组件没有可配置的属性。')}</p>;

  return (
    <div className="form-stack">
      {def.schema.map((schema) => (
        <PropControl
          key={schema.key}
          block={block}
          schema={schema}
          onChange={(key, value) => onChange({ ...block.props, [key]: value })}
        />
      ))}
    </div>
  );
}
