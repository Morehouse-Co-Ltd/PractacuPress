import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { BLOCK_RENDERERS, blockRendererFor } from '../../components/blocks/index';
import { pluginBlockRegistry } from './registry';

afterEach(() => {
  pluginBlockRegistry.clearPlugin('com.example.blocks');
});

describe('plugin block registry', () => {
  it('resolves a plugin block when no built-in renderer exists', () => {
    const Card = () => createElement('strong', null, 'plugin card');
    pluginBlockRegistry.register('demo.card', 'com.example.blocks', Card);

    expect(blockRendererFor('demo.card')).toBe(Card);
  });

  it('never lets a plugin shadow a built-in block type', () => {
    const builtinType = Object.keys(BLOCK_RENDERERS)[0];
    expect(builtinType).toBeTruthy();
    pluginBlockRegistry.register(builtinType, 'com.example.blocks', () =>
      createElement('span', null, 'hijacked'),
    );

    expect(blockRendererFor(builtinType)).toBe(BLOCK_RENDERERS[builtinType]);
  });

  it('removes the renderer when the plugin is unloaded', () => {
    pluginBlockRegistry.register('demo.card', 'com.example.blocks', () =>
      createElement('strong', null, 'plugin card'),
    );
    pluginBlockRegistry.clearPlugin('com.example.blocks');
    expect(blockRendererFor('demo.card')).toBeUndefined();
  });
});
