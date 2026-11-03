import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // 只有 styles.css 需要按文本读进测试（栅格断点写在 CSS 里，见 lib/gridBlock.test.ts）。
    // 其余样式表照旧被替换成空模块，不参与处理。
    css: { include: [/styles\.css/] },
    clearMocks: true,
  },
});
