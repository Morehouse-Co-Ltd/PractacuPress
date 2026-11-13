import type {
  Disposable,
  PluginBlockRenderer,
  SlotRegistrationOptions,
  SlotRenderer,
} from './types';

/**
 * Named UI seats. A slot can hold many contributions; the host renders them in
 * order. The registry is deliberately framework-free so it can be unit tested
 * and so a non-React renderer can subscribe to the same source of truth.
 */
export interface SlotEntry {
  pluginID: string;
  id: string;
  order: number;
  sequence: number;
  render: SlotRenderer;
}

export class SlotRegistry {
  private readonly entries = new Map<string, SlotEntry[]>();
  private readonly listeners = new Set<() => void>();
  private readonly empty: SlotEntry[] = [];
  private revision = 0;
  private sequence = 0;

  /** Stable subscription for useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Monotonic revision; the snapshot value for useSyncExternalStore. */
  readonly getVersion = (): number => this.revision;

  /** Contributions for one slot, sorted by `order` then registration order. */
  get(slot: string): SlotEntry[] {
    return this.entries.get(slot) ?? this.empty;
  }

  /** Registers one contribution and returns its disposer. */
  register(
    slot: string,
    pluginID: string,
    id: string,
    render: SlotRenderer,
    options: SlotRegistrationOptions = {},
  ): Disposable {
    if (!slot || !pluginID || !id) throw new Error('slot, pluginID and id are required');
    if (typeof render !== 'function') throw new Error('slot renderer must be a function');
    const current = this.entries.get(slot) ?? [];
    if (current.some((entry) => entry.pluginID === pluginID && entry.id === id)) {
      throw new Error(`slot "${slot}" already has a contribution ${pluginID}/${id}`);
    }
    const entry: SlotEntry = {
      pluginID,
      id,
      order: Number.isFinite(options.order) ? Number(options.order) : 0,
      sequence: ++this.sequence,
      render,
    };
    const next = [...current, entry].sort(
      (left, right) => left.order - right.order || left.sequence - right.sequence,
    );
    this.entries.set(slot, next);
    this.bump();
    return () => this.remove(slot, pluginID, id);
  }

  /** Removes every contribution owned by one plugin (used on unload/failure). */
  clearPlugin(pluginID: string): void {
    let changed = false;
    for (const [slot, current] of this.entries) {
      const next = current.filter((entry) => entry.pluginID !== pluginID);
      if (next.length === current.length) continue;
      changed = true;
      if (next.length) this.entries.set(slot, next);
      else this.entries.delete(slot);
    }
    if (changed) this.bump();
  }

  /** Test/inspection helper. */
  slots(): string[] {
    return [...this.entries.keys()];
  }

  private remove(slot: string, pluginID: string, id: string): void {
    const current = this.entries.get(slot);
    if (!current) return;
    const next = current.filter((entry) => !(entry.pluginID === pluginID && entry.id === id));
    if (next.length === current.length) return;
    if (next.length) this.entries.set(slot, next);
    else this.entries.delete(slot);
    this.bump();
  }

  private bump(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Content block renderers. The built-in renderers stay in their own module; a
 * plugin only adds types that are absent from the built-in map, so a plugin
 * cannot shadow a shipped block.
 */
export interface BlockEntry {
  pluginID: string;
  type: string;
  renderer: PluginBlockRenderer;
}

export class BlockRegistry {
  private readonly entries = new Map<string, BlockEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.revision;

  get(type: string): PluginBlockRenderer | undefined {
    return this.entries.get(type)?.renderer;
  }

  register(type: string, pluginID: string, renderer: PluginBlockRenderer): Disposable {
    if (!type || !pluginID) throw new Error('type and pluginID are required');
    if (typeof renderer !== 'function' && typeof renderer !== 'object') {
      throw new Error('block renderer must be a component');
    }
    if (this.entries.has(type)) throw new Error(`block type "${type}" is already registered`);
    this.entries.set(type, { pluginID, type, renderer });
    this.bump();
    return () => {
      const current = this.entries.get(type);
      if (!current || current.pluginID !== pluginID) return;
      this.entries.delete(type);
      this.bump();
    };
  }

  clearPlugin(pluginID: string): void {
    let changed = false;
    for (const [type, entry] of this.entries) {
      if (entry.pluginID !== pluginID) continue;
      this.entries.delete(type);
      changed = true;
    }
    if (changed) this.bump();
  }

  types(): string[] {
    return [...this.entries.keys()];
  }

  private bump(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The process-wide block registry. BlockView sits deep in the render tree and
 * may be rendered from contexts without a plugin provider, so a module-level
 * singleton is the least invasive seam. Tests create their own registry.
 */
export const pluginBlockRegistry = new BlockRegistry();
