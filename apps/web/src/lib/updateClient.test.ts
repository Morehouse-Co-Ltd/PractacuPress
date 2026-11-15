import { describe, expect, it, vi } from 'vitest';
import {
  UPDATE_APPLY_ENDPOINT,
  UPDATE_ENDPOINT,
  UpdateCheckError,
  applyUpdateFromDir,
  checkForUpdate,
  updateErrorMessage,
} from './updateClient';
import { UPDATE_SERVERS } from './siteUpdate';

const remoteManifest = {
  title: 'Practacu Press',
  describe: '自托管内容站点。',
  version: '0.2.0',
  style: 'stable',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function htmlResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

const settings = { server_url: UPDATE_SERVERS[0].url };

describe('update client', () => {
  it('uses the server-side check when the launcher answers', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        source: UPDATE_SERVERS[0].url,
        fetched_at: '2026-11-15T03:00:00Z',
        local: { title: 'Practacu Press', describe: 'd', version: '0.1.0', style: 'beta' },
        remote: remoteManifest,
        update_available: true,
        reason: 'newer',
      }),
    );
    const check = await checkForUpdate(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(check.server_side).toBe(true);
    expect(check.remote).toEqual(remoteManifest);
    expect(check.local.version).toBe('0.1.0');
    expect(check.checked_at).toBe('2026-11-15T03:00:00Z');
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `${UPDATE_ENDPOINT}?source=${encodeURIComponent(UPDATE_SERVERS[0].url)}`,
    );
  });

  it('falls back to a direct fetch when the server has no update endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith(UPDATE_ENDPOINT) ? htmlResponse(404) : jsonResponse(remoteManifest),
    );
    const check = await checkForUpdate(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(check.server_side).toBe(false);
    expect(check.remote).toEqual(remoteManifest);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces the server message when the server refused or failed to fetch', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, code: 'upstream_failed', message: '更新源返回了 502。' }, 502),
    );
    await expect(
      checkForUpdate(settings, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      name: 'UpdateCheckError',
      code: 'http',
      message: '更新源返回了 502。',
    });
  });

  it('rejects an invalid manifest from either path', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith(UPDATE_ENDPOINT)
        ? htmlResponse(404)
        : jsonResponse({ title: 'Practacu Press', version: '0.2.0' }),
    );
    await expect(
      checkForUpdate(settings, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports a network failure instead of throwing a raw fetch error', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith(UPDATE_ENDPOINT)) throw new TypeError('failed to fetch');
      throw new TypeError('failed to fetch');
    });
    await expect(
      checkForUpdate(settings, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses to check without a source', async () => {
    const fetchImpl = vi.fn();
    await expect(
      checkForUpdate({ server_url: '' }, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'no_source' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('has an error type that keeps the reason code', () => {
    const error = new UpdateCheckError('invalid', 'x');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('x');
    expect(error.code).toBe('invalid');
  });

  it('translates the failure keys the page shows', () => {
    for (const code of ['no_source', 'unsupported', 'network', 'invalid', 'http'] as const) {
      expect(updateErrorMessage(code).length).toBeGreaterThan(0);
    }
  });
});

describe('manual apply from a local build directory', () => {
  it('posts the directory and returns the promoted build', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, version: '0.2.0', previous: '0.1.0', active: 'dist-0.2.0' }),
    );
    const result = await applyUpdateFromDir('  C:\\builds\\dist-0.2.0  ', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ version: '0.2.0', previous: '0.1.0', active: 'dist-0.2.0' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPDATE_APPLY_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ dir: 'C:\\builds\\dist-0.2.0' });
  });

  it('surfaces the server reason when the directory is rejected', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, code: 'validation_failed', message: '这个目录里没有 version.json。' },
        400,
      ),
    );
    await expect(
      applyUpdateFromDir('C:\\nope', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ message: '这个目录里没有 version.json。' });
  });

  it('refuses an empty directory before touching the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      applyUpdateFromDir('   ', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(UpdateCheckError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
