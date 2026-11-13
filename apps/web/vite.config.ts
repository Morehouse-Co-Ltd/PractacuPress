import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发服务器（Vite）仍然监听 80 端口：浏览器直接打开 http://localhost 即可。
// 注意 8080 留给本机 Go API（下面的 API_ORIGIN），所以 dev 端口不能改成 8080；
// 需要换端口时用 `npm run dev -- --port 5173`。
//
// 生产静态站点（`npm start` / scripts/serve.mjs / Windows 启动器）默认端口是
// 8080，运行中也可以在后台「站点设置 → 访问端口」改。
const WEB_PORT = 80;
const API_ORIGIN = 'http://127.0.0.1:8080';

// 开发时把 /api、/healthz、/readyz 代理到本地 Go API，生产由反向代理承担。
export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    // 80 被占用时让 Vite 自动换一个空闲端口，而不是直接启动失败。
    strictPort: false,
    // 部分编辑器（以及 DSH 的文件工具）用「同目录临时文件 + 原子替换」写盘。
    // 这些临时目录会瞬间出现又消失，Windows 上还常被占用；让 watcher 跳过它们，
    // 否则一个 EBUSY 就能把整个 dev server 打挂（本机已复现）。
    watch: {
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        // E2E / 截图脚本会把 Chrome 用户目录、下载与构建产物放在这些目录里；
        // Chrome 的 Cookies / LevelDB 文件在 Windows 上常被锁住，watcher 一碰就 EBUSY。
        '**/.tmp/**',
        '**/.tmpbuild/**',
        '**/.runtime/**',
        '**/dist/**',
      ],
    },
    proxy: {
      // 实时通道走 /api/v1/ws：开发代理也必须转发升级请求，否则本机调试时
      // 前端只能退回 45 秒轮询。
      '/api': { target: API_ORIGIN, changeOrigin: false, ws: true },
      // 扩展前端 bundle / CSS 由 API 提供（/plugins/<id>/<version>/...）。
      // 与生产反向代理保持一致：扩展资源必须和页面同源，否则浏览器会拒绝加载。
      '/plugins': { target: API_ORIGIN, changeOrigin: false },
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
