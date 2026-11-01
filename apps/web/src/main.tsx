import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadConfig } from './lib/backend';
import { readCustomization, themeCss } from './lib/customize';
import { DEFAULT_LOCALE, setLocale } from './lib/i18n';
import { applyMotionPreference, readPerformance } from './lib/performance';
import { applySoftenAttributes, applyThemeMode } from './lib/theme';
import { importMovedSite } from './lib/runtime';
import './styles.css';

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
  if (bootCustomization) {
    const customization = bootCustomization;
    const style = document.createElement('style');
    style.id = 'pp-theme';
    style.textContent = themeCss(customization);
    document.head.appendChild(style);
    applyThemeMode(customization.theme.mode);
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
