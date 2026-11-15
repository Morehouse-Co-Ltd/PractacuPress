import { describe, expect, it } from 'vitest';
import webPackage from '../../package.json';
import { APP_VERSION, APP_VERSION_LABEL, APP_VERSION_MANIFEST } from './appVersion';
import manifest from '../../public/version.json';

/**
 * 版本清单与 package.json 必须一致。
 *
 * 站点更新页显示的是清单里的版本，安装包与 npm 发布用的是 package.json；两者一旦
 * 分叉，用户看到的版本就会和实际发布的版本对不上。改动版本时两个文件一起改。
 */
describe('app version', () => {
  it('uses the version manifest as the single source of truth', () => {
    expect(APP_VERSION).toBe(manifest.version);
    expect(APP_VERSION_LABEL).toBe(`v${manifest.version}`);
    expect(webPackage.version).toBe(manifest.version);
  });

  it('exposes the local manifest with all four core fields', () => {
    expect(APP_VERSION_MANIFEST).toEqual({
      title: manifest.title,
      describe: manifest.describe,
      version: manifest.version,
      style: manifest.style,
    });
    expect(['stable', 'beta', 'local']).toContain(APP_VERSION_MANIFEST.style);
  });
});
