// T5 reproduction over CDP: Playwright's pipe transport is blocked by the sandbox,
// so launch Chrome ourselves and connect over the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = process.env.PP_BASE || 'http://127.0.0.1:5173';
const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(path.join(tmpdir(), 't5-chrome-'));

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForDevtools() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('chrome devtools did not start');
}

const version = await waitForDevtools();
console.log('chrome', version['Browser']);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

async function probe(pathname) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/setup/status') || u.includes('/customization') || u.includes('/site-config')) {
      requests.push(u.replace(base, ''));
    }
  });
  await page.goto(`${base}${pathname}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const title = await page.title();
  const text = (await page.locator('body').innerText()).slice(0, 240).replace(/\s+/g, ' ');
  const storage = await page.evaluate(() => localStorage.getItem('pp.web.config.v1'));
  console.log(
    JSON.stringify(
      { pathname, url: page.url(), title, text, hasLocalConfig: storage !== null, requests },
      null,
      2,
    ),
  );
  await context.close();
}

try {
  await probe('/');
  await probe('/?mode=live');
} finally {
  await browser.close();
  child.kill();
}
