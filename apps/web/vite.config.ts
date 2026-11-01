import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 站点默认监听 80 端口：浏览器直接打开 http://localhost 即可。
// 需要换端口时用 `npm run dev -- --port 8080`；生产预览用
// `npm start -- --port 8080`，运行中也可以在后台「站点设置 → 访问端口」改。
const WEB_PORT = 80;
const API_ORIGIN = 'http://127.0.0.1:8080';

// 开发时把 /api、/healthz、/readyz 代理到本地 Go API，生产由反向代理承担。
export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    // 80 被占用时让 Vite 自动换一个空闲端口，而不是直接启动失败。
    strictPort: false,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false },
      '/healthz': { target: API_ORIGIN, changeOrigin: false },
      '/readyz': { target: API_ORIGIN, changeOrigin: false },
    },
  },
  preview: {
    port: WEB_PORT,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-router') || id.includes('@remix-run')) return 'router';
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
