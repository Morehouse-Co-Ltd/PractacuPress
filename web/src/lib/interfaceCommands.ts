/**
 * 界面命令：区块按钮、思维链动作与快捷键都通过它打开全屏层。
 * 用自定义事件而不是共享 state，避免命令源与命令目标互相引用。
 */

export type InterfaceCommand = 'search' | 'command' | 'home' | 'mode';

const EVENT = 'pp:interface-command';

export function dispatchInterfaceCommand(command: InterfaceCommand, detail?: Record<string, string>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { command, ...detail } }));
}

export function onInterfaceCommand(handler: (command: InterfaceCommand, detail: Record<string, string>) => void) {
  const listener = (event: Event) => {
    const data = (event as CustomEvent<Record<string, string>>).detail ?? {};
    handler(data.command as InterfaceCommand, data);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
