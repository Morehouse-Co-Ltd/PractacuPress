import { describe, expect, it } from 'vitest';
import { caretAnchor, placeMenu } from './caretRect';

const viewport = { width: 1200, height: 800 };

describe('placeMenu', () => {
  it('sits below the caret when there is room', () => {
    const anchor = { left: 300, top: 200, bottom: 220, height: 20 };
    expect(placeMenu(anchor, { width: 276, height: 330 }, viewport)).toEqual({
      left: 300,
      top: 226,
      placement: 'below',
    });
  });

  it('flips above when the remaining space below is too small', () => {
    const anchor = { left: 300, top: 600, bottom: 620, height: 20 };
    const placed = placeMenu(anchor, { width: 276, height: 330 }, viewport);
    expect(placed.placement).toBe('above');
    expect(placed.top).toBe(600 - 330 - 6);
  });

  it('clamps inside the viewport margins', () => {
    const near = placeMenu(
      { left: 1190, top: 100, bottom: 120, height: 20 },
      { width: 276, height: 200 },
      viewport,
    );
    expect(near.left).toBe(1200 - 276 - 8);
    const left = placeMenu(
      { left: -40, top: 100, bottom: 120, height: 20 },
      { width: 276, height: 200 },
      viewport,
    );
    expect(left.left).toBe(8);
  });

  it('never pushes the panel off the top or bottom edge', () => {
    const tall = placeMenu(
      { left: 100, top: 40, bottom: 60, height: 20 },
      { width: 276, height: 760 },
      viewport,
    );
    expect(tall.top).toBeGreaterThanOrEqual(8);
    const above = placeMenu(
      { left: 100, top: 790, bottom: 795, height: 5 },
      { width: 276, height: 700 },
      viewport,
    );
    expect(above.top).toBeGreaterThanOrEqual(8);
    expect(above.top + 700).toBeLessThanOrEqual(800 - 8);
  });

  it('honours custom gap and margin', () => {
    const placed = placeMenu(
      { left: 300, top: 200, bottom: 220, height: 20 },
      { width: 200, height: 100 },
      viewport,
      14,
      20,
    );
    expect(placed.top).toBe(234);
    expect(placeMenu({ left: 0, top: 200, bottom: 220, height: 20 }, { width: 200, height: 100 }, viewport, 14, 20).left)
      .toBe(20);
  });
});

describe('caretAnchor', () => {
  it('falls back to the block rect when the range reports nothing', () => {
    const block = document.createElement('p');
    block.textContent = '正文';
    document.body.appendChild(block);
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(true);
    const anchor = caretAnchor(range, block);
    // happy-dom 的量测恒为零，降级到块矩形后仍然是"有值但零尺寸"
    expect(anchor).not.toBeNull();
    expect(typeof anchor!.left).toBe('number');
  });

  it('returns null without a range', () => {
    expect(caretAnchor(null as unknown as Range, null)).toBeNull();
  });

  it('returns null when neither the range nor the block can be measured', () => {
    const range = document.createRange();
    expect(caretAnchor(range, null)).toBeNull();
  });
});
