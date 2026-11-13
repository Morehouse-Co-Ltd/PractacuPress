import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginSlot } from '../../components/PluginSlot';
import { AdminPageRegistry } from './adminRegistry';
import { BlockRegistry, SlotRegistry } from './registry';
import { PluginRuntime } from './runtime';
import type { PluginContext, PluginFactory, PluginManifest } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'com.example.demo',
    name: 'Demo',
    version: '1.0.0',
    entry: '/plugins/com.example.demo/1.0.0/client.js',
    permissions: ['ui.inject'],
    slots: ['article.after'],
    ...overrides,
  };
}

function factoryFor(
  activate: (context: PluginContext, React: typeof import('react')) => void,
): PluginFactory {
  return (require, module) => {
    const React = require('react') as typeof import('react');
    module.exports = {
      activate: (context: PluginContext) => activate(context, React),
    };
  };
}

function loaderFor(
  id: string,
  version: string,
  factory: PluginFactory,
): (url: string, integrity?: string) => Promise<void> {
  return async () => {
    window.__PP_PLUGIN_REGISTER__?.(id, version, factory);
  };
}

function runtimeWith(
  manifests: PluginManifest[],
  loadScript: (url: string, integrity?: string) => Promise<void>,
): PluginRuntime {
  return new PluginRuntime({
    slots: new SlotRegistry(),
    blocks: new BlockRegistry(),
    adminPages: new AdminPageRegistry(),
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ plugins: manifests }),
    })) as unknown as typeof fetch,
    loadScript,
    onError: () => {
      /* assertions read runtime.status() instead of the console */
    },
  });
}

let runtime: PluginRuntime | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-pp-plugin]').forEach((style) => style.remove());
});

describe('PluginRuntime', () => {
  it('loads a manifest, materialises the factory and registers a slot', async () => {
    const demo = manifest();
    runtime = runtimeWith(
      [demo],
      loaderFor(demo.id, demo.version, factoryFor((context, React) => {
        context.slots.register('article.after', 'footer', () =>
          React.createElement('span', { id: 'plugin-footer' }, 'hello from plugin'),
        );
      })),
    );

    await runtime.start();

    expect(runtime.status()).toEqual([
      { manifest: demo, state: 'active' },
    ]);
    expect(runtime.slots.get('article.after')).toHaveLength(1);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(PluginSlot, { name: 'article.after', runtime: runtime ?? undefined }));
    });
    expect(container.querySelector('#plugin-footer')?.textContent).toBe('hello from plugin');

    await act(async () => {
      await runtime?.deactivate(demo.id);
    });
    expect(container.textContent).toBe('');
    expect(runtime.slots.get('article.after')).toHaveLength(0);
  });

  it('rejects a slot the manifest did not declare', async () => {
    const demo = manifest({ slots: [] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.slots.register('admin.nav', 'evil', () => null);
      })),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('did not declare slot "admin.nav"');
    expect(runtime.status()[0]).toMatchObject({ state: 'failed' });
    expect(runtime.slots.slots()).toEqual([]);
  });

  it('rejects a plugin that did not declare ui.inject', async () => {
    const demo = manifest({ permissions: [], slots: ['article.after'] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.slots.register('article.after', 'x', () => null);
      })),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('ui.inject');
    expect(runtime.slots.get('article.after')).toHaveLength(0);
  });

  it('rejects a block type the manifest did not declare', async () => {
    const demo = manifest({ permissions: ['ui.block'], blocks: [] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.blocks.register('demo.card', () => null);
      })),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('did not declare block "demo.card"');
  });

  it('registers a block renderer and serves it from the registry', async () => {
    const demo = manifest({
      permissions: ['ui.block'],
      blocks: [{ type: 'demo.card', name: 'Demo card' }],
    });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context, React) => {
        context.blocks.register('demo.card', (props) =>
          React.createElement('strong', null, String(props.block.props?.title ?? 'card')),
        );
      })),
    );

    await runtime.activate(demo);
    const renderer = runtime.blocks.get('demo.card');
    expect(renderer).toBeTypeOf('function');

    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(renderer!, {
          block: { id: 'b1', type: 'demo.card', props: { title: 'Hi' } },
        }),
      );
    });
    expect(container.textContent).toBe('Hi');
  });

  it('does not expose modules outside the host table', async () => {
    const demo = manifest();
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, (require, module) => {
        require('lodash');
        module.exports = { activate: () => undefined };
      }),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('outside the host table');
  });

  it('rejects two plugins with the same id and a bundle version mismatch', async () => {
    const demo = manifest();
    const factory = factoryFor(() => undefined);
    runtime = runtimeWith([], loaderFor(demo.id, demo.version, factory));
    await runtime.activate(demo);
    await expect(runtime.activate(demo)).rejects.toThrow('already loaded');

    const second = manifest({ id: 'com.example.mismatch', entry: '/plugins/com.example.mismatch/1.0.0/client.js' });
    await runtime.dispose();
    runtime = runtimeWith([], loaderFor(second.id, '2.0.0', factory));
    await expect(runtime.activate(second)).rejects.toThrow('registered version 2.0.0');
  });

  it('injects a plugin stylesheet and removes it on dispose', async () => {
    const demo = manifest({ permissions: ['ui.inject', 'ui.style'], slots: [] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.ui.addStyle('.demo { color: red }');
      })),
    );
    await runtime.activate(demo);
    expect(document.head.querySelector('style[data-pp-plugin="com.example.demo"]')).not.toBeNull();
    await runtime.dispose();
    expect(document.head.querySelector('style[data-pp-plugin="com.example.demo"]')).toBeNull();
    runtime = null;
  });

  it('contains a throwing slot renderer inside its own boundary', async () => {
    const demo = manifest();
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context, React) => {
        context.slots.register('article.after', 'bad', () => {
          throw new Error('boom');
        });
        context.slots.register('article.after', 'good', () =>
          React.createElement('span', { id: 'good' }, 'still here'),
        );
      })),
    );
    await runtime.activate(demo);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(PluginSlot, { name: 'article.after', runtime: runtime ?? undefined }));
    });
    expect(container.querySelector('#good')?.textContent).toBe('still here');
    consoleError.mockRestore();
  });

  it('registers an admin page through the admin namespace and clears it on deactivate', async () => {
    const demo = manifest({ permissions: ['ui.inject'], slots: [] });
    runtime = runtimeWith(
      [demo],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.admin.registerPage({
          id: 'demo-page',
          path: 'demo-page',
          label: 'Demo page',
          icon: 'chart',
          group: 'extensions',
          render: () => null,
        });
      })),
    );

    await runtime.activate(demo);

    expect(runtime.adminPages.list()).toHaveLength(1);
    expect(runtime.adminPages.list()[0]).toMatchObject({
      pluginID: demo.id,
      page: { id: 'demo-page', path: 'demo-page', label: 'Demo page' },
    });
    expect(runtime.adminPages.resolve('demo-page')?.page.label).toBe('Demo page');

    await runtime.deactivate(demo.id);
    expect(runtime.adminPages.list()).toEqual([]);
  });

  it('rejects admin pages from a plugin that did not declare ui.inject', async () => {
    const demo = manifest({ permissions: [], slots: [] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.admin.registerPage({
          id: 'x',
          path: 'x',
          label: 'X',
          render: () => null,
        });
      })),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('ui.inject');
    expect(runtime.adminPages.list()).toEqual([]);
  });

  it('clears admin pages when activation fails after registering one', async () => {
    const demo = manifest({ permissions: ['ui.inject'], slots: [] });
    runtime = runtimeWith(
      [],
      loaderFor(demo.id, demo.version, factoryFor((context) => {
        context.admin.registerPage({
          id: 'half',
          path: 'half',
          label: 'Half',
          render: () => null,
        });
        throw new Error('activation blew up after registering');
      })),
    );

    await expect(runtime.activate(demo)).rejects.toThrow('activation blew up');
    expect(runtime.adminPages.list()).toEqual([]);
    expect(runtime.status()[0]).toMatchObject({ state: 'failed' });
  });
});
