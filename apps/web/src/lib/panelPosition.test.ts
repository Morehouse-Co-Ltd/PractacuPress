import { describe, expect, it } from 'vitest';
import { clampPanelPosition, snapPanelPosition } from './panelPosition';

const viewport = { width: 1440, height: 900 };

describe('clampPanelPosition', () => {
  it('keeps a position that is already fully visible', () => {
    expect(clampPanelPosition({ left: 100, top: 120, height: 600 }, viewport, 320)).toEqual({
      left: 100,
      top: 120,
      height: 600,
    });
  });

  it('keeps the panel inside the viewport on every side', () => {
    expect(clampPanelPosition({ left: -40, top: -30, height: 500 }, viewport, 320)).toEqual({
      left: 8,
      top: 8,
      height: 500,
    });
    const pushed = clampPanelPosition({ left: 5000, top: 5000, height: 5000 }, viewport, 320);
    expect(pushed.left).toBe(1440 - 320 - 8);
    expect(pushed.top).toBe(900 - 48);
    expect(pushed.height).toBe(900 - 16);
  });

  it('rounds fractional coordinates', () => {
    expect(clampPanelPosition({ left: 10.6, top: 20.2, height: 400.7 }, viewport, 320)).toEqual({
      left: 11,
      top: 20,
      height: 401,
    });
  });

  it('falls back to a usable width and handles a tiny viewport', () => {
    const tiny = clampPanelPosition({ left: 50, top: 50, height: 50 }, { width: 300, height: 260 }, Number.NaN);
    expect(tiny.left).toBe(8);
    expect(tiny.top).toBe(50);
    expect(tiny.height).toBeGreaterThanOrEqual(220);
    expect(tiny.height).toBeLessThanOrEqual(244);
  });
});

describe('snapPanelPosition', () => {
  it('snaps to the left edge when released near it', () => {
    expect(snapPanelPosition({ left: 40, top: 120, height: 600 }, viewport, 320).left).toBe(8);
  });

  it('snaps to the right edge when released near it', () => {
    // 1440 - 320 - 8 = 1112；left=1060 时右边距 60px，在 64px 吸附范围内。
    expect(snapPanelPosition({ left: 1060, top: 120, height: 600 }, viewport, 320).left).toBe(1112);
  });

  it('keeps the panel in place when it is not near an edge', () => {
    expect(snapPanelPosition({ left: 500, top: 120, height: 600 }, viewport, 320).left).toBe(500);
  });

  it('still clamps before snapping on a tiny viewport', () => {
    const snapped = snapPanelPosition({ left: 9999, top: 9999, height: 9999 }, { width: 400, height: 320 }, 320);
    expect(snapped.left).toBe(400 - 320 - 8);
    expect(snapped.height).toBeLessThanOrEqual(304);
  });
});
