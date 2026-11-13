import { Component, useCallback, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { defaultPluginRuntime, type PluginRuntime } from '../lib/plugins/runtime';

/**
 * A plugin seat. Contributions are rendered inside individual error boundaries
 * so a broken plugin loses its own UI instead of the page.
 */
export function PluginSlot({
  name,
  props,
  runtime = defaultPluginRuntime,
}: {
  name: string;
  props?: Record<string, unknown>;
  runtime?: PluginRuntime;
}) {
  const subscribe = useCallback(
    (listener: () => void) => runtime.slots.subscribe(listener),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.slots.get(name), [runtime, name]);
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!entries.length) return null;
  return (
    <>
      {entries.map((entry) => (
        <PluginBoundary key={`${entry.pluginID}:${entry.id}`} pluginID={entry.pluginID}>
          <PluginContribution
            pluginID={entry.pluginID}
            render={() => entry.render(props ?? {})}
          />
        </PluginBoundary>
      ))}
    </>
  );
}

/**
 * Calls the contribution inside the boundary's subtree. Rendering it eagerly in
 * PluginSlot's own return would run the plugin code outside the boundary and a
 * throw would take the whole page down.
 */
function PluginContribution({
  pluginID,
  render,
}: {
  pluginID: string;
  render: () => ReactNode;
}) {
  return <div data-pp-plugin={pluginID} style={{ display: 'contents' }}>{render()}</div>;
}

class PluginBoundary extends Component<
  { pluginID: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[pp plugin ${this.props.pluginID}] slot renderer failed`, error, info);
  }

  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
