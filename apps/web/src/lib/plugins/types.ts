import type { ReactNode } from 'react';
import type { IconName } from '../../components/Icon';
import type { BlockArea, LayoutVariant } from '../../types';

/** Presentation group a theme component belongs to. Only affects the palette. */
export type PluginBlockGroup = 'shared' | 'classic' | 'nightflight' | 'content';

/** One property field of a theme component, mirroring `PropSchema`. */
export interface PluginPropSchema {
  key: string;
  label: string;
  type: string;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  bindable?: boolean;
  itemSchema?: PluginPropSchema[];
  itemLabel?: string;
  minItems?: number;
  maxItems?: number;
}

/**
 * Everything the page builder needs to present one theme component.
 *
 * The host, not the bundle, is authoritative for these values: the runtime reads
 * them from `plugin.json` and hands them to the block registry, so a bundle
 * cannot silently rename itself or claim a different schema at activation time.
 */
export interface PluginBlockSpec {
  type: string;
  name?: string;
  description?: string;
  group?: PluginBlockGroup;
  variants?: LayoutVariant[];
  area?: BlockArea;
  /** Seed props for a freshly inserted block. Scalar values only. */
  defaults?: Record<string, string | number | boolean>;
  schema?: PluginPropSchema[];
}

/**
 * Public manifest shape served by GET /api/v1/plugins.
 *
 * The browser runtime treats this document as untrusted data: it only loads
 * same-origin bundle URLs, and every capability is checked against the
 * permission list here rather than against a value the bundle supplies.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  styles?: string[];
  slots?: string[];
  blocks?: PluginBlockSpec[];
  permissions?: string[];
  integrity?: string;
  settings?: boolean;
}

export interface PluginBootResponse {
  plugins: PluginManifest[];
}

/** A React renderer registered into a named slot. */
export type SlotRenderer = (props: Record<string, unknown>) => ReactNode;

/** The minimal block shape a plugin renderer receives. */
export interface PluginBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: PluginBlock[];
}

export type PluginBlockRenderer = (props: { block: PluginBlock }) => ReactNode;

/** A disposer returned by every registration. */
export type Disposable = () => void;

export interface SlotRegistrationOptions {
  order?: number;
}

/**
 * Where an extension page appears in the admin navigation.
 *
 * `overview` sits directly under the dashboard (the built-in performance panel
 * is one); `extensions` gets its own "扩展页面" group further down. Anything
 * unrecognised falls back to `extensions` so a bad value cannot hide a page.
 */
export type AdminPageGroup = 'overview' | 'extensions';

/**
 * One admin page an extension contributes.
 *
 * The host renders `render()` inside an error boundary at
 * `/admin/ext/{path}` and puts a navigation entry in the admin shell. The page
 * is trusted host code (it runs in the page's own realm, like slot renderers),
 * so this is composition, not sandboxing.
 */
export interface AdminPageDefinition {
  /** Stable id within the owning extension; used for diagnostics and React keys. */
  id: string;
  /** URL slug: the page lives at `/admin/ext/{path}`. */
  path: string;
  /** Navigation/title label, already in the page's language. */
  label: string;
  icon?: IconName;
  group?: AdminPageGroup;
  /** Sort key inside its group (lower first; registration order breaks ties). */
  order?: number;
  description?: string;
  render(): ReactNode;
}

export interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly site: { id: string };
  readonly slots: {
    register(
      slot: string,
      id: string,
      render: SlotRenderer,
      options?: SlotRegistrationOptions,
    ): Disposable;
  };
  readonly blocks: {
    register(type: string, renderer: PluginBlockRenderer): Disposable;
  };
  /**
   * Admin pages the extension contributes. Requires the `ui.inject` permission;
   * the host owns the route (`/admin/ext/{path}`) and the nav entry.
   */
  readonly admin: {
    registerPage(page: AdminPageDefinition): Disposable;
  };
  readonly ui: {
    addStyle(css: string): Disposable;
  };
  readonly api: {
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  readonly log: (...args: unknown[]) => void;
}

/** The value a bundle exports (or its `default` export). */
export interface PluginDefinition {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * A browser bundle's factory. The bundle is a classic script that calls
 * window.__PP_PLUGIN_REGISTER__(id, version, factory). The factory is
 * materialised lazily by the host with a frozen module table, so React is the
 * page's single instance and no eval() is involved.
 */
export type PluginFactory = (
  require: (specifier: string) => unknown,
  module: { exports: unknown },
  exports: unknown,
) => void;

export type PluginState = 'pending' | 'active' | 'failed' | 'disposed';

export interface PluginStatus {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
}

/** The module table every plugin bundle resolves against. */
export const PLUGIN_MODULES: Record<string, string> = {
  react: 'react',
  'react-dom': 'react-dom',
  'react-dom/client': 'react-dom/client',
  'react/jsx-runtime': 'react/jsx-runtime',
  'react/jsx-dev-runtime': 'react/jsx-dev-runtime',
  'react-router-dom': 'react-router-dom',
};

declare global {
  interface Window {
    __PP_PLUGIN_REGISTER__?: (
      id: string,
      version: string,
      factory: PluginFactory,
    ) => void;
  }
}
