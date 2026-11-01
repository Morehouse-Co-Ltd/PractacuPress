import type { ThemeSettings, ThemeTokenKey } from '../../types';
import { THEME_TOKENS, resolveTokens } from '../../lib/theme';
import { Badge, Button, Callout, Toggle } from '../ui';

/**
 * 高级主题令牌：从原主题工坊迁移过来的逐令牌覆盖。
 * 只有开启“覆盖”才会写进 theme.tokens；否则跟随预设自动派生。
 */
export function ThemeTokensPanel({
  theme,
  onChange,
}: {
  theme: ThemeSettings;
  onChange: (theme: ThemeSettings) => void;
}) {
  const resolved = resolveTokens(theme);
  const overrides = theme.tokens ?? {};

  const setToken = (key: ThemeTokenKey, value: string | undefined) => {
    const next = { ...overrides };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...theme, tokens: Object.keys(next).length ? next : undefined });
  };

  return (
    <div className="form-stack">
      <Callout tone="info" icon="palette" title="什么时候需要高级令牌">
        只有在预设的颜色不合用时才需要逐项覆盖。覆盖只对当前明暗模式生效；切换模式会恢复预设重配。
      </Callout>
      <div className="token-list">
        {THEME_TOKENS.map((item) => {
          const override = overrides[item.key];
          const value = override ?? resolved[item.key];
          const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
          return (
            <div className="token-row" key={item.key}>
              <div className="token-row-head">
                <strong>{item.label}</strong>
                <span className="faint small">{item.hint}</span>
              </div>
              <div className="token-row-controls">
                {override ? (
                  <input
                    type="color"
                    value={hex}
                    aria-label={`${item.label}颜色`}
                    onChange={(event) => setToken(item.key, event.target.value)}
                  />
                ) : (
                  <span className="token-swatch" style={{ background: value }} aria-hidden />
                )}
                <code className="mono tiny">{value}</code>
                {item.advanced ? <Badge tone="muted">高级</Badge> : null}
                <Toggle
                  checked={!!override}
                  onChange={(next) => {
                    if (next) setToken(item.key, resolved[item.key]);
                    else setToken(item.key, undefined);
                  }}
                  label={override ? '已覆盖' : '跟随预设'}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="row gap-8">
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => onChange({ ...theme, tokens: undefined })}>
          清除全部覆盖
        </Button>
      </div>
    </div>
  );
}
