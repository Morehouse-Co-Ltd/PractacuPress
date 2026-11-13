import webPackage from '../../package.json';

/**
 * 当前前端构建版本。
 *
 * 直接取 `apps/web/package.json` 的 version，打包时由 Vite 内联；这样“站点更新”
 * 页显示的版本不会和 package.json 漂移。升级流程还没接入，所以这里只做展示。
 */
const raw = typeof webPackage.version === 'string' ? webPackage.version.trim() : '';

export const APP_VERSION = raw || '0.0.0';

/** 带 v 前缀的展示形式，例如 v0.1.0。 */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
