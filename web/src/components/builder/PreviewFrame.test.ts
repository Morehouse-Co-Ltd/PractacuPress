import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewFrame } from './PreviewFrame';

/**
 * P1 §5.3：编辑器不再生成 `device_split`。
 *
 * 设备差异写在区块的 `at` 覆盖层里，所以工具栏上不该再有「不同设备分割」开关：
 * 每点一次就多出两棵树，两套模型会一直并存。这个用例钉住「入口已经拿掉」；
 * 历史文档仍然能读、能渲染（见 lib/migrate.test.ts 的折算用例）。
 *
 * 只做静态渲染：不跑 effect、不加载 iframe，工具栏的 DOM 已经足够回答这个问题。
 */
function markup() {
  return renderToStaticMarkup(
    createElement(PreviewFrame, {
      url: 'http://localhost:3000/',
      selectedId: null,
      onSelect: () => {},
    }),
  );
}

describe('预览工具栏', () => {
  it('不再提供「不同设备分割」开关', () => {
    const html = markup();
    expect(html).not.toContain('不同设备分割');
    expect(html).not.toContain('builder-split-switch');
    expect(html).not.toContain('type="checkbox"');
  });

  it('设备切换按钮仍然在', () => {
    const html = markup();
    expect(html).toContain('桌面');
    expect(html).toContain('平板');
    expect(html).toContain('手机');
  });
});
