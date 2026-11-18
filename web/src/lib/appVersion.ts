import manifest from '../../public/version.json';
import type { SiteUpdateManifest } from '../types';

/**
 * 当前前端构建版本。
 *
 * 唯一来源是仓库里的版本清单 `web/public/version.json`（构建后就是站点的
 * `/version.json`），打包时由 Vite 内联；`package.json` 的 version 必须与它一致，
 * 由 `appVersion.test.ts` 把关，避免“站点更新”页显示的版本和实际发布版本漂移。
 */
const raw = typeof manifest.version === 'string' ? manifest.version.trim() : '';

export const APP_VERSION = raw || '0.0.0';

/** 带 v 前缀的展示形式，例如 v0.1.0。 */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/**
 * 本机版本清单（标题 / 说明 / 版本 / 渠道）。
 *
 * 只用于展示与服务端清单做比较；字段不合法时退回一个占位值，页面另有校验。
 */
export const APP_VERSION_MANIFEST: SiteUpdateManifest = {
  title: manifest.title,
  describe: manifest.describe,
  version: APP_VERSION,
  style: manifest.style as SiteUpdateManifest['style'],
};
