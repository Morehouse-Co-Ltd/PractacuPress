import type { SiteTheme, ThemeSettingField } from '../../types';
import { useCustomization } from '../../lib/customize';
import { themeSettingValue } from '../../lib/themeSettings';
import { useT } from '../../lib/i18n';
import { Button, Callout, Field, Input, Select, Textarea, Toggle } from '../ui';
import { Icon } from '../Icon';

/**
 * 主题自定义设置。
 *
 * 字段来自主题包 `admin/tabs.json`；值存进
 * `customization.theme_settings[themeId][tabId][fieldKey]`，跟着站点设计跨设备同步。
 * 主题不需要写 React，字段类型由宿主统一渲染，升级后自动获得新的控件与可访问性。
 */
export function ThemeCustomSettings({ theme }: { theme: SiteTheme }) {
  const t = useT();
  const { customization, update } = useCustomization();
  const schema = theme.settings;
  if (!schema) return null;

  const setValue = (tabId: string, fieldKey: string, value: string | number | boolean) => {
    const all = { ...(customization.theme_settings ?? {}) };
    const themeValues = { ...(all[theme.id] ?? {}) };
    const tabValues = { ...(themeValues[tabId] ?? {}) };
    tabValues[fieldKey] = value;
    themeValues[tabId] = tabValues;
    all[theme.id] = themeValues;
    update({ theme_settings: all });
  };

  const clear = () => {
    const all = { ...(customization.theme_settings ?? {}) };
    delete all[theme.id];
    update({ theme_settings: Object.keys(all).length ? all : undefined });
  };

  return (
    <div className="theme-custom-settings">
      {!schema.replace_default ? (
        <Callout tone="info" icon="palette" title={t('这套主题提供自己的设置')}>
          {t('字段由主题自带的 admin/tabs.json 声明，保存后随站点设计同步到服务端。')}
        </Callout>
      ) : null}

      {schema.tabs.map((tab) => (
        <section className="panel mt-20" key={tab.id}>
          <div className="panel-head">
            <div>
              <h3>{tab.label}</h3>
              {tab.description ? <p>{tab.description}</p> : null}
            </div>
            <span className="tiny faint mono">
              {t('{count} 项', { count: tab.fields.length })}
            </span>
          </div>
          <div className="panel-body">
            <div className="theme-setting-grid">
              {tab.fields.map((field) => (
                <ThemeSettingControl
                  key={`${tab.id}:${field.key}`}
                  field={field}
                  value={themeSettingValue(customization, theme.id, tab, field)}
                  onChange={(value) => setValue(tab.id, field.key, value)}
                />
              ))}
            </div>
          </div>
        </section>
      ))}

      <div className="row gap-8 mt-16">
        <Button variant="ghost" size="sm" icon="refresh" onClick={clear}>
          {t('恢复主题默认设置')}
        </Button>
        <span className="tiny faint">
          <Icon name="database" size={12} /> {t('设置保存在站点设计里，不写入服务端环境变量。')}
        </span>
      </div>
    </div>
  );
}

function ThemeSettingControl({
  field,
  value,
  onChange,
}: {
  field: ThemeSettingField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  const t = useT();
  const hint = field.hint;
  switch (field.type) {
    case 'toggle':
      return (
        <div className="theme-setting-field is-wide">
          <Toggle
            checked={value === true}
            onChange={(next) => onChange(next)}
            label={field.label}
            description={hint}
          />
        </div>
      );
    case 'select':
      return (
        <Field label={field.label} hint={hint}>
          <Select
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
            aria-label={field.label}
          >
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'textarea':
      return (
        <div className="theme-setting-field is-wide">
          <Field label={field.label} hint={hint}>
            <Textarea
              value={String(value ?? '')}
              maxLength={field.maxLength}
              onChange={(event) => onChange(event.target.value)}
              aria-label={field.label}
              style={{ minHeight: 88 }}
            />
          </Field>
        </div>
      );
    case 'color':
      return (
        <Field label={field.label} hint={hint}>
          <div className="theme-setting-color">
            <input
              type="color"
              value={typeof value === 'string' && value ? value : '#000000'}
              onChange={(event) => onChange(event.target.value)}
              aria-label={field.label}
            />
            <Input
              value={String(value ?? '')}
              onChange={(event) => onChange(event.target.value)}
              aria-label={t('{field}的色值', { field: field.label })}
              placeholder="#000000"
              maxLength={32}
            />
          </div>
        </Field>
      );
    case 'number':
      return (
        <Field label={field.label} hint={hint}>
          <Input
            type="number"
            value={typeof value === 'number' ? value : Number(value ?? 0)}
            min={field.min}
            max={field.max}
            onChange={(event) => onChange(Number(event.target.value))}
            aria-label={field.label}
          />
        </Field>
      );
    default:
      return (
        <Field label={field.label} hint={hint}>
          <Input
            value={String(value ?? '')}
            maxLength={field.maxLength}
            onChange={(event) => onChange(event.target.value)}
            aria-label={field.label}
          />
        </Field>
      );
  }
}
