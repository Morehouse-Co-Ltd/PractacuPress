import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_SETTINGS,
  UPDATE_CHANNELS,
  UPDATE_FREQUENCIES,
  UPDATE_MODES,
  UPDATE_SERVERS,
  UPDATE_STYLES,
  VERSION_MANIFEST_PATH,
  canCheckForUpdates,
  compareUpdateVersions,
  evaluateUpdate,
  hasUpdateServer,
  isChannelAllowed,
  isNewerVersion,
  manifestUrlOf,
  modeLabel,
  parseUpdateManifest,
  readUpdateSettings,
  serverNameOf,
  serverOptionOf,
  styleLabel,
  updateIntervalMs,
  versionLabel,
} from './siteUpdate';

const manifest = {
  title: 'Practacu Press',
  describe: '自托管内容站点。',
  version: '0.2.0',
};

describe('site update settings', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(readUpdateSettings(undefined)).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(readUpdateSettings(null)).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(readUpdateSettings('nope')).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(
      readUpdateSettings({ mode: 'sometimes', channel: 'nightly', frequency: 'hourly' }),
    ).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(DEFAULT_UPDATE_SETTINGS.mode).toBe('manual');
    expect(DEFAULT_UPDATE_SETTINGS.channel).toBe('stable');
    // 旧配置允许把地址留空；下拉栏没有“留空”，空白回落到默认更新源。
    expect(readUpdateSettings({ server_url: '   ' }).server_url).toBe(
      DEFAULT_UPDATE_SETTINGS.server_url,
    );
    expect(readUpdateSettings({}).server_url).toBe(DEFAULT_UPDATE_SETTINGS.server_url);
  });

  it('migrates the old boolean auto_update into the new mode', () => {
    expect(readUpdateSettings({ auto_update: true }).mode).toBe('auto');
    expect(readUpdateSettings({ auto_update: false }).mode).toBe('manual');
    // 新字段优先：并存时以 mode 为准。
    expect(readUpdateSettings({ auto_update: true, mode: 'manual' }).mode).toBe('manual');
  });

  it('drops the retired server_port field and trims the source', () => {
    const settings = readUpdateSettings({
      mode: 'auto',
      channel: 'beta',
      frequency: 'weekly',
      server_url: '  https://updates.example.com/version.json  ',
      server_port: '8443',
      last_checked_at: '2026-11-13T00:00:00Z',
      last_remote_version: ' 0.3.0 ',
    });
    expect(settings).toEqual({
      mode: 'auto',
      channel: 'beta',
      frequency: 'weekly',
      server_url: 'https://updates.example.com/version.json',
      last_checked_at: '2026-11-13T00:00:00Z',
      last_remote_version: '0.3.0',
    });
    expect('server_port' in settings).toBe(false);
  });

  it('drops empty optional values instead of keeping empty strings', () => {
    const settings = readUpdateSettings({ last_checked_at: '', last_remote_version: '  ' });
    expect(settings.last_checked_at).toBeUndefined();
    expect(settings.last_remote_version).toBeUndefined();
  });

  it('detects whether an update source is selected', () => {
    expect(hasUpdateServer({ server_url: '' })).toBe(false);
    expect(hasUpdateServer({ server_url: '   ' })).toBe(false);
    expect(canCheckForUpdates({ server_url: UPDATE_SERVERS[0].url })).toBe(true);
  });

  it('exposes a dropdown catalog whose entries point at the same manifest', () => {
    expect(UPDATE_SERVERS.map((item) => item.id)).toEqual(['github', 'jsdelivr', 'local']);
    for (const option of UPDATE_SERVERS) {
      expect(option.url.length).toBeGreaterThan(0);
      expect(option.name.length).toBeGreaterThan(0);
      // 相对路径就是本站自己的 /version.json，绝对地址都指向仓库里的清单。
      expect(option.url === '/version.json' || option.url.endsWith(VERSION_MANIFEST_PATH)).toBe(
        true,
      );
    }
    expect(serverOptionOf(UPDATE_SERVERS[1].url)?.id).toBe('jsdelivr');
    expect(serverOptionOf('https://example.com/version.json')).toBeNull();
    expect(serverNameOf('https://example.com/version.json')).toBe('https://example.com/version.json');
    expect(serverNameOf(UPDATE_SERVERS[2].url)).toBe('本站 version.json');
    expect(manifestUrlOf('')).toBe(UPDATE_SERVERS[0].url);
    expect(manifestUrlOf(' /version.json ')).toBe('/version.json');
  });

  it('keeps the mode / channel / frequency catalogs in a stable order', () => {
    expect(UPDATE_MODES.map((item) => item.id)).toEqual(['manual', 'auto']);
    expect(UPDATE_CHANNELS.map((item) => item.id)).toEqual(['stable', 'beta']);
    expect(UPDATE_FREQUENCIES.map((item) => item.id)).toEqual(['startup', 'daily', 'weekly']);
    expect(UPDATE_STYLES.map((item) => item.id)).toEqual(['stable', 'beta', 'local']);
  });

  it('labels modes and styles for the page', () => {
    expect(modeLabel('manual')).toBe('手动更新');
    expect(modeLabel('auto')).toBe('自动更新');
    expect(styleLabel('beta')).toBe('测试版');
    expect(styleLabel('local')).toBe('本地版本');
  });

  it('computes the automatic check interval from the frequency', () => {
    expect(updateIntervalMs('startup')).toBe(0);
    expect(updateIntervalMs('daily')).toBe(24 * 60 * 60 * 1000);
    expect(updateIntervalMs('weekly')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('renders versions with a single v prefix', () => {
    expect(versionLabel('0.1.0')).toBe('v0.1.0');
    expect(versionLabel('v1.2.3')).toBe('v1.2.3');
    expect(versionLabel('')).toBe('—');
  });
});

describe('version manifest', () => {
  it('accepts the canonical version manifest and computes the integer code', () => {
    expect(parseUpdateManifest(manifest)).toEqual({
      ...manifest,
      channel: 'stable',
      version_code: 20099,
    });
    expect(parseUpdateManifest({ ...manifest, version: 'v1.0.0-beta.2' })).toEqual({
      title: manifest.title,
      describe: manifest.describe,
      version: '1.0.0-beta.2',
      channel: 'beta',
      version_code: 1000002,
    });
    // 旧清单只有 style：按版本号推断通道，并补出整数版本号。
    expect(parseUpdateManifest({ ...manifest, version: '0.2.0-beta', style: 'beta' })).toEqual({
      title: manifest.title,
      describe: manifest.describe,
      version: '0.2.0-beta',
      channel: 'beta',
      version_code: 20001,
    });
    // 多余字段不影响解析。
    expect(parseUpdateManifest({ ...manifest, extra: { a: 1 } })?.version).toBe('0.2.0');
  });

  it('rejects documents that are missing a core field', () => {
    for (const key of ['title', 'describe', 'version'] as const) {
      const broken: Record<string, unknown> = { ...manifest };
      delete broken[key];
      expect(parseUpdateManifest(broken), key).toBeNull();
    }
    expect(parseUpdateManifest(null)).toBeNull();
    expect(parseUpdateManifest([])).toBeNull();
    expect(parseUpdateManifest('0.2.0')).toBeNull();
  });

  it('rejects malformed versions, unknown styles and inconsistent codes', () => {
    for (const version of ['', '2', '1.2', '1.2.3.4', 'latest', 'v1.2.x', '1.2.3-alpha']) {
      expect(parseUpdateManifest({ ...manifest, version }), version).toBeNull();
    }
    expect(parseUpdateManifest({ ...manifest, style: 'nightly' })).toBeNull();
    // 通道与版本号必须自洽：0.2.0 只能是 stable。
    expect(parseUpdateManifest({ ...manifest, channel: 'beta' })).toBeNull();
    // version_code 必须与版本号算出的值一致。
    expect(parseUpdateManifest({ ...manifest, version_code: 20098 })).toBeNull();
    expect(parseUpdateManifest({ ...manifest, version_code: '20099' })).toBeNull();
  });
});

describe('version comparison', () => {
  it('orders versions by integer code', () => {
    expect(compareUpdateVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareUpdateVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareUpdateVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareUpdateVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(compareUpdateVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('treats a prerelease as older than its stable release', () => {
    expect(compareUpdateVersions('0.2.0', '0.2.0-beta')).toBeGreaterThan(0);
    expect(compareUpdateVersions('0.2.0-beta', '0.2.0')).toBeLessThan(0);
    expect(compareUpdateVersions('0.2.0-beta.2', '0.2.0-beta.10')).toBeLessThan(0);
    expect(compareUpdateVersions('0.2.0-beta.2', '0.2.0-beta')).toBeGreaterThan(0);
    expect(compareUpdateVersions('0.2.0-beta', '0.2.0-beta')).toBe(0);
    // 0.1.99 比 0.2.0-beta 旧：patch 不会溢出到 minor。
    expect(compareUpdateVersions('0.1.99', '0.2.0-beta')).toBeLessThan(0);
  });

  it('reports unparsable versions as equal, never as an update', () => {
    expect(compareUpdateVersions('latest', '0.1.0')).toBe(0);
    expect(isNewerVersion('latest', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
  });

  it('drops beta releases on the stable channel', () => {
    expect(isChannelAllowed('stable', 'stable')).toBe(true);
    expect(isChannelAllowed('stable', 'local')).toBe(true);
    expect(isChannelAllowed('stable', 'beta')).toBe(false);
    expect(isChannelAllowed('beta', 'beta')).toBe(true);
    expect(isChannelAllowed('beta', 'stable')).toBe(true);
  });
});

describe('update verdict', () => {
  const remote = (version: string) => ({ title: manifest.title, describe: manifest.describe, version });
  const evaluate = (remoteVersion: string, channel: 'stable' | 'beta' = 'stable') =>
    evaluateUpdate({
      localVersion: '0.1.0',
      remote: parseUpdateManifest(remote(remoteVersion)),
      channel,
    });

  it('reports an available update when the remote is newer', () => {
    const verdict = evaluate('0.2.0');
    expect(verdict.status).toBe('available');
    expect(verdict.available).toBe(true);
    expect(verdict.localVersion).toBe('0.1.0');
    expect(verdict.remote?.version).toBe('0.2.0');
  });

  it('does not offer a beta release on the stable channel', () => {
    const verdict = evaluate('0.2.0-beta', 'stable');
    expect(verdict.status).toBe('channel_mismatch');
    expect(verdict.available).toBe(false);
  });

  it('accepts a beta release on the beta channel', () => {
    const verdict = evaluate('0.2.0-beta', 'beta');
    expect(verdict.status).toBe('available');
    expect(verdict.remote?.channel).toBe('beta');
  });

  it('reports same / ahead / invalid', () => {
    expect(evaluate('0.1.0').status).toBe('up_to_date');
    expect(evaluate('0.0.9').status).toBe('ahead');
    expect(
      evaluateUpdate({
        localVersion: '0.1.0',
        remote: parseUpdateManifest(remote('broken')),
        channel: 'stable',
      }).status,
    ).toBe('invalid');
  });
});