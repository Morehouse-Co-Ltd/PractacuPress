import type {
  SiteCustomization,
  SiteTheme,
  ThemeSettingField,
  ThemeSettingFieldType,
  ThemeSettingTab,
  ThemeSettingsSchema,
} from '../types';

/**
 * 主题自定义设置（`admin/tabs.json` 协议）。
 *
 * 主题包可以带一份数据文件声明自己的设置字段；宿主按这份声明渲染表单，把值写进
 * 站点设计的 `theme_settings[themeId][tabId][fieldKey]`。主题不需要写 React，
 * 升级宿主时表单还能自动获得新的控件与可访问性改进。
 *
 * 这里只做归一化与读取，渲染在 `components/theme/ThemeCustomSettings.tsx`。
 */

const FIELD_TYPES: ThemeSettingFieldType[] = ['text', 'textarea', 'toggle', 'select', 'color', 'number'];
const MAX_TABS = 10;
const MAX_FIELDS = 24;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return value.slice(0, 4000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function normalizeField(raw: unknown): ThemeSettingField | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const key = text(record.key, 60);
  const label = text(record.label, 80);
  const type = text(record.type, 20) as ThemeSettingFieldType;
  if (!key || !ID.test(key) || !label || !FIELD_TYPES.includes(type)) return null;

  const field: ThemeSettingField = { key, label, type };
  const hint = text(record.hint, 240);
  if (hint) field.hint = hint;
  const fallback = scalar(record.default);
  if (fallback !== undefined) field.default = fallback;

  if (type === 'select') {
    const options = Array.isArray(record.options)
      ? record.options
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const option = item as Record<string, unknown>;
            const value = text(option.value, 80);
            const optionLabel = text(option.label, 80);
            return value && optionLabel ? { value, label: optionLabel } : null;
          })
          .filter((item): item is { value: string; label: string } => item !== null)
          .slice(0, 24)
      : [];
    if (!options.length) return null;
    field.options = options;
  }
  if (type === 'text' || type === 'textarea') {
    const maxLength = Number(record.maxLength ?? record.max);
    if (Number.isFinite(maxLength) && maxLength > 0) {
      field.maxLength = Math.min(Math.round(maxLength), type === 'text' ? 400 : 4000);
    }
  }
  if (type === 'number') {
    const min = Number(record.min);
    const max = Number(record.max);
    if (Number.isFinite(min)) field.min = min;
    if (Number.isFinite(max)) field.max = max;
  }
  return field;
}

function normalizeTab(raw: unknown): ThemeSettingTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id, 60);
  const label = text(record.label, 80);
  if (!id || !ID.test(id) || !label) return null;
  const fields = Array.isArray(record.fields)
    ? record.fields
        .map(normalizeField)
        .filter((item): item is ThemeSettingField => item !== null)
        .slice(0, MAX_FIELDS)
    : [];
  if (!fields.length) return null;
  const tab: ThemeSettingTab = { id, label, fields };
  const description = text(record.description, 240);
  if (description) tab.description = description;
  return tab;
}

/**
 * 归一化主题包里的 `admin/tabs.json`。
 *
 * `replaceDefault` 可以由主题清单的 `admin.replace_default` 或数据文件里的
 * `replace_default` 指定，二者取或。
 */
export function normalizeThemeSettingsSchema(
  value: unknown,
  replaceDefault = false,
): ThemeSettingsSchema | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const tabs = Array.isArray(record.tabs)
    ? record.tabs
        .map(normalizeTab)
        .filter((item): item is ThemeSettingTab => item !== null)
        .slice(0, MAX_TABS)
    : [];
  if (!tabs.length) return null;
  return {
    tabs,
    replace_default: replaceDefault || record.replace_default === true,
  };
}

/** 读取某个字段当前值；没有保存过时使用主题声明的默认值。 */
export function themeSettingValue(
  customization: SiteCustomization,
  themeId: string,
  tab: ThemeSettingTab,
  field: ThemeSettingField,
): string | number | boolean | undefined {
  const stored = customization.theme_settings?.[themeId]?.[tab.id]?.[field.key];
  if (stored !== undefined) return stored;
  if (field.default !== undefined) return field.default;
  return field.type === 'toggle' ? false : '';
}

/** 某套主题是否声明了自己的设置。 */
export function themeHasSettings(theme: SiteTheme | null | undefined): boolean {
  return !!theme?.settings?.tabs.length;
}

type ThemeSettingValues = Record<string, Record<string, Record<string, string | number | boolean>>>;

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 归一化站点设计里保存的自定义设置值。
 *
 * 只接受扁平的三层 map 与标量值：主题包与手改的 JSON 都不能把任意对象塞进配置，
 * 渲染器也只需要 `string | number | boolean`。
 */
export function normalizeThemeSettingValues(value: unknown): ThemeSettingValues | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: ThemeSettingValues = {};
  let themeCount = 0;
  for (const [themeId, tabs] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY.test(themeId) || themeCount >= 40) continue;
    if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) continue;
    const themeValues: Record<string, Record<string, string | number | boolean>> = {};
    let tabCount = 0;
    for (const [tabId, fields] of Object.entries(tabs as Record<string, unknown>)) {
      if (!KEY.test(tabId) || tabCount >= 20) continue;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const fieldValues: Record<string, string | number | boolean> = {};
      let fieldCount = 0;
      for (const [fieldKey, raw] of Object.entries(fields as Record<string, unknown>)) {
        if (!KEY.test(fieldKey) || fieldCount >= 40) continue;
        const value = scalar(raw);
        if (value === undefined) continue;
        fieldValues[fieldKey] = value;
        fieldCount += 1;
      }
      if (!fieldCount) continue;
      themeValues[tabId] = fieldValues;
      tabCount += 1;
    }
    if (!tabCount) continue;
    out[themeId] = themeValues;
    themeCount += 1;
  }
  return themeCount ? out : undefined;
}
