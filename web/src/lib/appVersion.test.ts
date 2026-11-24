import { describe, expect, it } from 'vitest';
import webPackage from '../../package.json';
import {
  APP_VERSION,
  APP_VERSION_CHANNEL,
  APP_VERSION_CODE,
  APP_VERSION_LABEL,
  APP_VERSION_MANIFEST,
} from './appVersion';
import manifest from '../../public/version.json';
import { parseVersion } from './version';

/**
 * 版本清单与 package.json 必须一致。
 *
 * 站点更新页显示的是清单里的版本，安装包与 npm 发布用的是 package.json；两者一旦
 * 分叉，用户看到的版本就会和实际发布的版本对不上。改动版本时两个文件一起改。
 */
describe('app version', () => {
  it('uses the version manifest as the single source of truth', () => {
    expect(manifest.version).toBe('0.1.3-beta');
    expect(APP_VERSION).toBe(manifest.version);
    expect(APP_VERSION_LABEL).toBe(`v${manifest.version}`);
    expect(webPackage.version).toBe(manifest.version);
  });

  it('derives the canonical channel and integer version code from the version', () => {
    expect(manifest.style).toBe('beta');
    expect(APP_VERSION_CHANNEL).toBe('beta');
    expect(APP_VERSION_CODE).toBe(10301);
    const parsed = parseVersion(manifest.version);
    expect(parsed?.channel).toBe('beta');
    expect(parsed?.code).toBe(APP_VERSION_CODE);
  });

  it('keeps the local manifest self-consistent with the version fields', () => {
    expect(APP_VERSION_MANIFEST).toEqual({
      title: manifest.title,
      describe: manifest.describe,
      version: manifest.version,
      channel: 'beta',
      version_code: 10301,
    });
    expect(APP_VERSION_MANIFEST.channel).toBe('beta');
    expect(APP_VERSION_MANIFEST.version_code).toBe(10301);
  });
});
