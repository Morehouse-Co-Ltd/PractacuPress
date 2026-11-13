import { defineConfig } from '@playwright/test';
import path from 'node:path';

const artifacts = process.env.PP_E2E_ARTIFACTS
  ? path.resolve(process.env.PP_E2E_ARTIFACTS)
  : path.resolve(process.cwd(), '..', '..', '.tmp', 'e2e', 'artifacts');

// 默认使用系统 Chrome（channel: chrome）：不下载浏览器，本机与 CI 都能直接跑。
// 需要 Playwright 自带 chromium 时设 PP_E2E_CHANNEL=chromium，并先 npx playwright install chromium。
const channel = (process.env.PP_E2E_CHANNEL || 'chrome').trim();
const launchChannel = channel === 'chromium' || channel === 'bundled' ? undefined : channel;

export default defineConfig({
  testDir: './specs',
  outputDir: path.join(artifacts, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: Number(process.env.PP_E2E_RETRIES || 0),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(artifacts, 'html'), open: 'never' }],
    ['json', { outputFile: path.join(artifacts, 'results.json') }],
  ],
  use: {
    baseURL: process.env.PP_E2E_BASE || 'http://127.0.0.1:18100',
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    channel: launchChannel as 'chrome' | 'msedge' | 'chromium' | undefined,
  },
  projects: [
    {
      name: 'chromium-smoke',
      use: { browserName: 'chromium' },
    },
  ],
  metadata: {
    suite: 'browser-e2e-smoke',
    api: 'Go API + Rust security service + SQLite',
  },
});
