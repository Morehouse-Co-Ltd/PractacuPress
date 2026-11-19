import { describe, expect, it } from 'vitest';
import { styleDeclarations } from './blockStyles';

describe('styleDeclarations', () => {
  it('parses safe declarations', () => {
    expect(styleDeclarations('font-size: 18px; letter-spacing:.02em;')).toEqual({
      fontSize: '18px',
      letterSpacing: '.02em',
    });
  });

  it('drops selectors and dangerous values', () => {
    expect(styleDeclarations('} body{display:none; background:url(x)')).toEqual({});
    expect(styleDeclarations('color: expression(alert(1));')).toEqual({});
  });

  it('ignores malformed input', () => {
    expect(styleDeclarations(null)).toEqual({});
    expect(styleDeclarations('not-css')).toEqual({});
  });
});
