/**
 * Node 26 自带的 Web Storage 全局（未传 --localstorage-file 时是 `undefined`）会
 * 遮住 happy-dom 装在 window 上的实现，导致用到 localStorage 的测试在 beforeEach
 * 里直接抛 `Cannot read properties of undefined`。测试环境统一装一份 happy-dom
 * 的 Storage；浏览器里本来就是 window 上的那一份，所以不影响线上行为。
 */
import { Storage } from 'happy-dom';

for (const key of ['localStorage', 'sessionStorage'] as const) {
  let existing: unknown;
  try {
    existing = window[key];
  } catch {
    existing = undefined;
  }
  Object.defineProperty(globalThis, key, {
    value: existing ?? new Storage(),
    configurable: true,
    writable: true,
  });
}
