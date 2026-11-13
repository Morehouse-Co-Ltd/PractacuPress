import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadConfig } from './lib/backend';
import { readCustomization, themeCss } from './lib/customize';
import { DEFAULT_LOCALE, setLocale } from './lib/i18n';
import { applyMotionPreference, readPerformance } from './lib/performance';
import { applySoftenAttributes, applyThemeMode } from './lib/theme';
import { applyBootThemePreference } from './lib/themePreference';
import { importMovedSite } from './lib/runtime';
import './styles.css';
import './styles/adminTheme.css';
// 白昼不再作为可选主题，但旧配置的 `daylight` 版式仍要能正常渲染。
import './styles/daylightTheme.css';
import './styles/siteRefresh.css';
import './styles/writeDesk.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');
const root = createRoot(container);

async function boot() {
  // 换端口后先接管旧地址带过来的配置与演示数据，再读取安装状态。
  await importMovedSite();

  const bootConfig = loadConfig();
  const bootCustomization = bootConfig ? readCustomization(bootConfig) : null;

  // 语言先于首屏确定：英文站点不能先闪一下中文。没有配置时按简体中文。
  setLocale(bootCustomization?.language ?? DEFAULT_LOCALE);

  // 首屏之前先写入主题变量与明暗模式，避免刷新时闪一下默认配色。
  // 明暗优先读 Cookie：同一次安装里，读者自己的选择不应该被站点的默认值覆盖。
  if (bootCustomization) {
    const customization = bootCustomization;
    const mode = applyBootThemePreference(customization.theme.mode);
    const style = document.createElement('style');
    style.id = 'pp-theme';
    style.textContent = themeCss(customization, mode);
    document.head.appendChild(style);
    applyThemeMode(mode);
    applySoftenAttributes(customization.theme);
    applyMotionPreference(readPerformance(bootConfig!));
    document.documentElement.dataset.variant = customization.layout.variant;
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
