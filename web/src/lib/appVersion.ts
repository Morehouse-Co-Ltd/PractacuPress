import manifest from '../../public/version.json';
import type { SiteUpdateManifest } from '../types';
import { parseVersion } from './version';

/**
 * 当前前端构建版本。
 *
 * 唯一来源是仓库里的版本清单 `web/public/version.json`（构建后就是站点的
 * `/version.json`），打包时由 Vite 内联；`package.json` 的 version 必须与它一致，
 * 由 `appVersion.test.ts` 把关，避免“站点更新”页显示的版本和实际发布版本漂移。
 *
 * 版本口径见 `web/src/lib/version.ts`（与 `internal/version/version.go` 一致）：
 * 字符串只用于展示，比较一律用整数 `version_code`。
 */
const parsed = parseVersion(typeof manifest.version === 'string' ? manifest.version : '');
if (!parsed) {
  // 构建产物里的版本清单损坏属于构建错误，不能悄悄退回 0.0.0 继续发布。
  throw new Error(`version.json 里的版本号不合法：${String(manifest.version)}`);
}

export const APP_VERSION = parsed.version;
export const APP_VERSION_CHANNEL = parsed.channel;
export const APP_VERSION_CODE = parsed.code;

/** 带 v 前缀的展示形式，例如 v0.1.2-beta。 */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/**
 * 本机版本清单（标题 / 说明 / 版本 / 通道 / 整数版本）。
 *
 * 只用于展示与服务端清单做比较；字段不合法时构建期就会抛错，页面另有校验。
 */
export const APP_VERSION_MANIFEST: SiteUpdateManifest = {
  title: manifest.title,
  describe: manifest.describe,
  version: APP_VERSION,
  channel: APP_VERSION_CHANNEL,
  version_code: APP_VERSION_CODE,
};
