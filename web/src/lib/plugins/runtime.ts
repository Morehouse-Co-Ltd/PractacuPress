import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as ReactRouterDOM from 'react-router-dom';
import { AdminPageRegistry, adminPageRegistry } from './adminRegistry';
import { BlockRegistry, SlotRegistry, pluginBlockRegistry } from './registry';
import type {
  AdminPageDefinition,
  Disposable,
  PluginBlockRenderer,
  PluginBootResponse,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginManifest,
  PluginStatus,
  SlotRenderer,
} from './types';

const MODULE_TABLE: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
  'react-router-dom': ReactRouterDOM,
};

const LOAD_TIMEOUT_MS = 10_000;
const MAX_BUNDLE_STYLES = 100_000;

export interface PluginRuntimeOptions {
  /** Boot manifest endpoint. Defaults to /api/v1/plugins. */
  endpoint?: string;
  /** Site id passed to plugins; defaults to an empty string (visitor). */
  siteId?: string;
  fetchImpl?: typeof fetch;
  /** Injectable script loader; tests use it to register a factory synchronously. */
  loadScript?: (url: string, integrity?: string) => Promise<void>;
  slots?: SlotRegistry;
  blocks?: BlockRegistry;
  /** Admin page registry a plugin's `context.admin.registerPage()` writes into. */
  adminPages?: AdminPageRegistry;
  /** Extra host modules a plugin may require. */
  modules?: Record<string, unknown>;
  onError?: (pluginID: string, error: Error) => void;
  styleRoot?: HTMLElement;
}

interface ActivePlugin {
  manifest: PluginManifest;
  definition: PluginDefinition;
  disposers: Disposable[];
}

/**
 * Browser plugin runtime.
 *
 * Trust model: a plugin bundle is a same-origin classic script, so it already
 * has the authority of the page (DOM, cookies, storage). The permission list is
 * a composition guard, not a sandbox. Untrusted code belongs in the existing
 * sandboxed-iframe extension system, not here. The one hard rule this runtime
 * enforces is capability declaration: a plugin cannot fill a slot it did not
 * declare, render a block it did not declare, or load a cross-origin bundle.
 */
export class PluginRuntime {
  readonly slots: SlotRegistry;
  readonly blocks: BlockRegistry;
  readonly adminPages: AdminPageRegistry;
  private readonly endpoint: string;
  private readonly siteId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly loadScript: (url: string, integrity?: string) => Promise<void>;
  private readonly modules: Record<string, unknown>;
  private readonly onError: (pluginID: string, error: Error) => void;
  private readonly styleRoot?: HTMLElement;

  private readonly statuses = new Map<string, PluginStatus>();
  private readonly active = new Map<string, ActivePlugin>();
  private readonly factories = new Map<string, { version: string; factory: PluginFactory }>();
  private readonly loading = new Set<string>();
  private previousGlobal?: Window['__PP_PLUGIN_REGISTER__'];
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;

  constructor(options: PluginRuntimeOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/v1/plugins';
    this.siteId = options.siteId ?? '';
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.loadScript = options.loadScript ?? defaultLoadScript;
    this.slots = options.slots ?? new SlotRegistry();
    this.blocks = options.blocks ?? pluginBlockRegistry;
    this.adminPages = options.adminPages ?? adminPageRegistry;
    this.modules = { ...MODULE_TABLE, ...(options.modules ?? {}) };
    this.onError =
      options.onError ??
      ((pluginID, error) => {
        console.error(`[pp plugin ${pluginID}]`, error);
      });
    this.styleRoot = options.styleRoot;
  }

  /** Fetches the boot manifest and activates every listed plugin. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('plugin runtime is disposed');
    if (this.started) return;
    // A failed boot must stay retryable: an API restart or a transient network error
    // used to latch `started` and leave extensions unloaded until a full reload.
    // Concurrent callers share the in-flight attempt instead of racing a second one.
    if (this.starting) return this.starting;
    this.starting = this.boot();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Performs one boot attempt; `start` records its completion. */
  private async boot(): Promise<void> {
    this.installGlobal();
    const response = await this.fetchImpl(this.endpoint, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error(`plugin boot manifest answered ${response.status}`);
    }
    const document = (await response.json()) as PluginBootResponse;
    if (!document || !Array.isArray(document.plugins)) {
      throw new Error('plugin boot manifest has no plugins array');
    }
    for (const manifest of document.plugins) {
      try {
        await this.activate(manifest);
      } catch (error) {
        this.fail(manifest.id, error);
      }
    }
    this.started = true;
  }

  /** Activates one plugin. Idempotent only for an already-active id (no-op). */
  async activate(manifest: PluginManifest): Promise<void> {
    if (this.disposed) throw new Error('plugin runtime is disposed');
    validateManifest(manifest);
    if (this.active.has(manifest.id) || this.loading.has(manifest.id)) {
      throw new Error(`plugin ${manifest.id} is already loaded`);
    }
    this.installGlobal();
    this.loading.add(manifest.id);
    this.statuses.set(manifest.id, { manifest, state: 'pending' });
    try {
      assertSameOriginBundle(manifest.entry);
      await this.loadScript(manifest.entry, manifest.integrity);
      this.loading.delete(manifest.id);

      const registered = this.factories.get(manifest.id);
      this.factories.delete(manifest.id);
      if (!registered) {
        throw new Error(`bundle did not register a factory for ${manifest.id}`);
      }
      if (registered.version !== manifest.version) {
        throw new Error(
          `bundle registered version ${registered.version}, manifest says ${manifest.version}`,
        );
      }
      const definition = materialize(registered.factory, this.modules);
      if (!definition || typeof definition.activate !== 'function') {
        throw new Error(`plugin ${manifest.id} has no activate() export`);
      }
      const plugin: ActivePlugin = { manifest, definition, disposers: [] };
      this.active.set(manifest.id, plugin);
      await definition.activate(this.createContext(plugin));
      this.statuses.set(manifest.id, { manifest, state: 'active' });
    } catch (error) {
      this.loading.delete(manifest.id);
      const partial = this.active.get(manifest.id);
      if (partial) {
        this.active.delete(manifest.id);
        for (const dispose of [...partial.disposers].reverse()) {
          try {
            dispose();
          } catch {
            /* the original activation error is the one worth reporting */
          }
        }
        this.slots.clearPlugin(manifest.id);
        this.blocks.clearPlugin(manifest.id);
        this.adminPages.clearPlugin(manifest.id);
      }
      this.fail(manifest.id, error);
      throw error;
    }
  }

  /** Deactivates one plugin and removes every registration it owns. */
  async deactivate(pluginID: string): Promise<void> {
    const plugin = this.active.get(pluginID);
    if (!plugin) return;
    this.active.delete(pluginID);
    try {
      await plugin.definition.deactivate?.();
    } catch (error) {
      this.onError(pluginID, asError(error));
    }
    for (const dispose of [...plugin.disposers].reverse()) {
      try {
        dispose();
      } catch (error) {
        this.onError(pluginID, asError(error));
      }
    }
    this.slots.clearPlugin(pluginID);
    this.blocks.clearPlugin(pluginID);
    this.adminPages.clearPlugin(pluginID);
    this.statuses.set(pluginID, { manifest: plugin.manifest, state: 'disposed' });
  }

  /** Deactivates everything and restores the global registration hook. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pluginID of [...this.active.keys()]) {
      await this.deactivate(pluginID);
    }
    this.loading.clear();
    this.factories.clear();
    if (typeof window === 'undefined') return;
    if (this.previousGlobal) window.__PP_PLUGIN_REGISTER__ = this.previousGlobal;
    else delete window.__PP_PLUGIN_REGISTER__;
  }

  /** Snapshot for an admin diagnostics page. */
  status(): PluginStatus[] {
    return [...this.statuses.values()].map((entry) => ({ ...entry }));
  }

  private createContext(plugin: ActivePlugin): PluginContext {
    const manifest = plugin.manifest;
    const permissions = new Set(manifest.permissions ?? []);
    const declaredSlots = new Set(manifest.slots ?? []);
    const declaredBlocks = new Map((manifest.blocks ?? []).map((block) => [block.type, block]));
    const track = (dispose: Disposable): Disposable => {
      plugin.disposers.push(dispose);
      return dispose;
    };

    return {
      plugin: { id: manifest.id, version: manifest.version },
      site: { id: this.siteId },
      slots: {
        register: (slot, id, render: SlotRenderer, options) => {
          if (!permissions.has('ui.inject')) {
            throw new Error(`${manifest.id} did not declare the ui.inject permission`);
          }
          if (!declaredSlots.has(slot)) {
            throw new Error(`${manifest.id} did not declare slot "${slot}"`);
          }
          return track(this.slots.register(slot, manifest.id, id, render, options));
        },
      },
      blocks: {
        register: (type, renderer: PluginBlockRenderer) => {
          if (!permissions.has('ui.block')) {
            throw new Error(`${manifest.id} did not declare the ui.block permission`);
          }
          if (!declaredBlocks.has(type)) {
            throw new Error(`${manifest.id} did not declare block "${type}"`);
          }
          return track(
            this.blocks.register(type, manifest.id, renderer, declaredBlocks.get(type)),
          );
        },
      },
      admin: {
        registerPage: (page: AdminPageDefinition) => {
          // Admin pages are injected UI too: reuse ui.inject rather than adding a
          // new permission word the backend manifest does not know about.
          if (!permissions.has('ui.inject')) {
            throw new Error(`${manifest.id} did not declare the ui.inject permission`);
          }
          return track(this.adminPages.register(manifest.id, page));
        },
      },
      ui: {
        addStyle: (css) => {
          if (!permissions.has('ui.style')) {
            throw new Error(`${manifest.id} did not declare the ui.style permission`);
          }
          if (typeof css !== 'string' || css.length > MAX_BUNDLE_STYLES) {
            throw new Error('plugin stylesheet is empty or too large');
          }
          if (/@import|url\(\s*['"]?\s*javascript:|expression\(/i.test(css)) {
            throw new Error('plugin stylesheet contains a forbidden construct');
          }
          const style = document.createElement('style');
          style.dataset.ppPlugin = manifest.id;
          style.textContent = css;
          (this.styleRoot ?? document.head).appendChild(style);
          return track(() => style.remove());
        },
      },
      api: {
        fetch: (path, init) => {
          if (typeof path !== 'string' || !path.startsWith('/api/')) {
            return Promise.reject(new Error('plugin api.fetch only accepts same-origin /api paths'));
          }
          return this.fetchImpl(path, { credentials: 'same-origin', ...init });
        },
      },
      log: (...args) => console.debug(`[pp plugin ${manifest.id}]`, ...args),
    };
  }

  private fail(pluginID: string, error: unknown): void {
    const manifest = this.statuses.get(pluginID)?.manifest;
    if (!manifest) return;
    if (this.statuses.get(pluginID)?.state === 'failed') return;
    this.statuses.set(pluginID, { manifest, state: 'failed', error: asError(error).message });
    this.onError(pluginID, asError(error));
  }

  private installGlobal(): void {
    if (typeof window === 'undefined') return;
    if (window.__PP_PLUGIN_REGISTER__ === this.registerFactory) return;
    this.previousGlobal = window.__PP_PLUGIN_REGISTER__;
    window.__PP_PLUGIN_REGISTER__ = this.registerFactory;
  }

  private readonly registerFactory = (
    id: string,
    version: string,
    factory: PluginFactory,
  ): void => {
    // Ignore a factory nobody is waiting for: an opaque script cannot inject a
    // plugin behind the boot manifest's back.
    if (!this.loading.has(id) || typeof factory !== 'function') return;
    this.factories.set(id, { version, factory });
  };
}

function materialize(
  factory: PluginFactory,
  modules: Record<string, unknown>,
): PluginDefinition | undefined {
  const module = { exports: {} as unknown };
  const require = (specifier: string): unknown => {
    if (!Object.prototype.hasOwnProperty.call(modules, specifier)) {
      throw new Error(`plugin requested a module outside the host table: ${specifier}`);
    }
    return modules[specifier];
  };
  factory(require, module, module.exports);
  const exported = module.exports as { default?: PluginDefinition } & PluginDefinition;
  return exported && typeof exported === 'object' && exported.default
    ? exported.default
    : exported;
}

function validateManifest(manifest: PluginManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('plugin manifest is not an object');
  if (typeof manifest.id !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id)) {
    throw new Error(`plugin id ${String(manifest.id)} is invalid`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error(`plugin ${manifest.id} has an invalid version`);
  }
  if (typeof manifest.entry !== 'string' || !manifest.entry.startsWith('/plugins/')) {
    throw new Error(`plugin ${manifest.id} entry must be an absolute /plugins path`);
  }
}

function assertSameOriginBundle(entry: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(entry, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new Error(`plugin bundle must be same-origin: ${entry}`);
  }
  if (!url.pathname.startsWith('/plugins/')) {
    throw new Error(`plugin bundle must live under /plugins/: ${entry}`);
  }
}

function defaultLoadScript(url: string, integrity?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    const cleanup = () => {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`plugin bundle timed out: ${url}`));
    }, LOAD_TIMEOUT_MS);
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      reject(new Error(`plugin bundle failed to load: ${url}`));
    };
    document.head.appendChild(script);
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The default runtime used by the app. It is inert until start() is called;
 * tests create their own instances so they never share slot state.
 */
export const defaultPluginRuntime = new PluginRuntime({ blocks: pluginBlockRegistry });
