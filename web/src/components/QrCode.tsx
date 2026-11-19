import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * 二维码渲染。
 *
 * 用 `qrcode-generator` 生成模块矩阵，再自己画成 SVG：
 * - 不输出 `<img src="data:...">`，避免演示模式下把一次性密钥写进 DOM 属性；
 * - SVG 在深色主题里也能保持白底黑码，扫码识别率不受主题影响；
 * - `shapeRendering="crispEdges"` 保证放大后模块边缘不糊。
 */
export function QrCode({
  value,
  size = 180,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const modules = useMemo(() => {
    if (!value) return null;
    // 0 = automatic version, M = 15% error correction: enough for a printed or
    // screen-shown enrollment QR without making the code dense.
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const cells: { x: number; y: number }[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) cells.push({ x: col, y: row });
      }
    }
    return { count, cells };
  }, [value]);

  if (!modules) return null;
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules.count} ${modules.count}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect width={modules.count} height={modules.count} fill="#ffffff" />
      <g fill="#111111">
        {modules.cells.map((cell) => (
          <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />
        ))}
      </g>
    </svg>
  );
}
