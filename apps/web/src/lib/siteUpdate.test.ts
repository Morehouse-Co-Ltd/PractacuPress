import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_SETTINGS,
  UPDATE_CHANNELS,
  UPDATE_FREQUENCIES,
  hasUpdateServer,
  isValidUpdatePort,
  readUpdateSettings,
  versionLabel,
} from './siteUpdate';

describe('site update settings', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(readUpdateSettings(undefined)).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(readUpdateSettings(null)).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(readUpdateSettings('nope')).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(readUpdateSettings({ auto_update: 'yes', channel: 'nightly', frequency: 'hourly' })).toEqual(
      DEFAULT_UPDATE_SETTINGS,
    );
    expect(DEFAULT_UPDATE_SETTINGS.auto_update).toBe(false);
    expect(DEFAULT_UPDATE_SETTINGS.server_url).toBe('');
  });

  it('reads a valid document, trims text and keeps the channel/frequency', () => {
    expect(
      readUpdateSettings({
        auto_update: true,
        channel: 'beta',
        frequency: 'weekly',
        server_url: '  https://updates.example.com  ',
        server_port: ' 8443 ',
        last_checked_at: '2026-11-13T00:00:00Z',
      }),
    ).toEqual({
      auto_update: true,
      channel: 'beta',
      frequency: 'weekly',
      server_url: 'https://updates.example.com',
      server_port: '8443',
      last_checked_at: '2026-11-13T00:00:00Z',
    });
  });

  it('drops empty optional timestamps instead of keeping empty strings', () => {
    expect(readUpdateSettings({ last_checked_at: '' }).last_checked_at).toBeUndefined();
  });

  it('validates ports: empty is allowed, integers in range only', () => {
    for (const value of ['', '   ', '1', '80', '8080', '65535']) {
      expect(isValidUpdatePort(value), value).toBe(true);
    }
    for (const value of ['0', '65536', '1.5', '-1', 'http', '80 80', '１２３']) {
      expect(isValidUpdatePort(value), value).toBe(false);
    }
  });

  it('detects a configured update server only when the address is present', () => {
    expect(hasUpdateServer({ server_url: '' })).toBe(false);
    expect(hasUpdateServer({ server_url: '   ' })).toBe(false);
    expect(hasUpdateServer({ server_url: 'https://updates.example.com' })).toBe(true);
  });

  it('renders versions with a single v prefix', () => {
    expect(versionLabel('0.1.0')).toBe('v0.1.0');
    expect(versionLabel('v1.2.3')).toBe('v1.2.3');
    expect(versionLabel('')).toBe('—');
  });

  it('exposes the channel and frequency catalogs in a stable order', () => {
    expect(UPDATE_CHANNELS.map((item) => item.id)).toEqual(['stable', 'beta']);
    expect(UPDATE_FREQUENCIES.map((item) => item.id)).toEqual(['startup', 'daily', 'weekly']);
  });
});
