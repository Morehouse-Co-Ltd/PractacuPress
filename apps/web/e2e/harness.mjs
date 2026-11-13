#!/usr/bin/env node
/**
 * 浏览器端 E2E 冒烟套件的一键启动器。
 *
 * 它把一次真实交付的最小拓扑拉起来，然后跑 Playwright：
 *
 *   1. 在 .tmp/e2e/data 建一份全新的 SQLite 数据库；
 *   2. 编译并启动 Rust 安全服务（注册、登录、发布清洗都依赖它）；
 *   3. 编译并启动 Go API（PP_DESKTOP=true，空库自动建表并创建单站点）；
 *   4. 构建前端并启动 apps/web/e2e/server.mjs（静态站 + 同源 /api 反代）；
 *   5. 运行 Playwright（chromium/chrome 无头，失败留截图与 trace）。
 *
 * 用法（仓库根目录）：
 *   node apps/web/e2e/harness.mjs
 *   powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
 *   bash scripts/e2e.sh
 *
 * 环境变量：
 *   PP_E2E_CHANNEL=chrome|msedge|chromium   浏览器通道，默认 chrome（用系统 Chrome，不下载）
 *   PP_E2E_SKIP_WEB_BUILD=1                 复用已有 apps/web/dist
 *   PP_E2E_SKIP_SECURITY=1                  不启动安全服务（只适合可跳过认证的调试）
 *   PP_E2E_SECURITY_BIN=<path>              指定安全服务可执行文件
 *   PP_E2E_GO=<path>                        指定 go 可执行文件
 *   PP_E2E_API_PORT / PP_E2E_SECURITY_PORT / PP_E2E_WEB_PORT  自定义端口
 *
 * 产物都在 .tmp/e2e/ 下：artifacts/（HTML 报告、JSON、截图、trace、video）、
 * logs/（go build、API、安全服务、静态服务器日志）、data/（SQLite 与媒体）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP_WEB, '..', '..');
const E2E = join(ROOT, '.tmp', 'e2e');
const DATA = join(E2E, 'data');
const LOGS = join(E2E, 'logs');
const ARTIFACTS = join(E2E, 'artifacts');
const BIN = join(E2E, 'bin');

const API_PORT = Number(process.env.PP_E2E_API_PORT || 18080);
const SEC_PORT = Number(process.env.PP_E2E_SECURITY_PORT || 19001);
const WEB_PORT = Number(process.env.PP_E2E_WEB_PORT || 18100);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const SKIP_SECURITY = process.env.PP_E2E_SKIP_SECURITY === '1';
const SKIP_WEB_BUILD = process.env.PP_E2E_SKIP_WEB_BUILD === '1';

const children = [];
let stopping = false;

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function findGo() {
  const candidates = [
    process.env.PP_E2E_GO,
    'C:\\Program Files\\Go\\bin\\go.exe',
    'go',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  fail('go not found; install Go 1.26+ or set PP_E2E_GO');
}

function findSecurity() {
  const candidates = [
    process.env.PP_E2E_SECURITY_BIN,
    join(ROOT, 'services', 'security', 'target', 'release', 'practacu-security.exe'),
    join(ROOT, 'services', 'security', 'target', 'release', 'practacu-security'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  return found || '';
}

function npmInvocation(args) {
  // Windows 上直接 spawn `npm.cmd` 需要 shell:true（会触发 Node 的 DEP0190），
  // 优先用同目录的 npm-cli.js 以 node 启动，参数、退出码和路径都原样传递。
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')],
    };
  }
  return { command: 'npm', args };
}

function appendLog(name) {
  return openSync(join(LOGS, `${name}.log`), 'a');
}

function track(name, child, logFd) {
  children.push({ name, child, logFd });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (code !== 0 && code !== null) log(`${name} exited early with code ${code}`);
    if (signal) log(`${name} exited on ${signal}`);
  });
  return child;
}

function startService(name, command, args, options = {}) {
  const logFd = appendLog(name);
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  return track(name, child, logFd);
}

function stopChildren() {
  stopping = true;
  for (const item of [...children].reverse()) {
    const { name, child } = item;
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      log(`could not stop ${name}: ${error.message}`);
    }
  }
  children.length = 0;
}

function runLogged(name, command, args, cwd) {
  const logFd = appendLog(name);
  log(`> ${command} ${args.join(' ')}`);
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.on('error', (error) => resolveRun({ code: -1, error }));
    child.on('exit', (code) => resolveRun({ code: code ?? -1 }));
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function portFree(port) {
  return new Promise((done) => {
    const server = net.createServer();
    server.once('error', () => done(false));
    server.once('listening', () => server.close(() => done(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function assertFreePort(port, label, envName) {
  if (!(await portFree(port))) {
    fail(
      `port ${port} (${label}) is already in use; stop that process or set ${envName} to a free port`,
    );
  }
}

function waitTcp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolveWait(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolveWait(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function waitHttp(url, accept, timeoutMs = 30000, label = url) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      if (accept(response, body)) return body;
      last = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(300);
  }
  fail(`${label} did not become ready: ${last}`);
}

async function collectResults() {
  const resultsPath = join(ARTIFACTS, 'results.json');
  if (!existsSync(resultsPath)) return null;
  let data;
  try {
    data = JSON.parse(await readFile(resultsPath, 'utf8'));
  } catch {
    return null;
  }
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const last = test.results?.[test.results.length - 1];
        tests.push({
          title: [...(spec.titlePath || []), spec.title].filter(Boolean).join(' › '),
          status: last?.status || 'unknown',
          duration: last?.duration || 0,
          error: last?.error?.message?.split('\n')[0] || '',
        });
      }
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of data.suites || []) walk(suite);
  return { tests, duration: data.stats?.duration || 0 };
}

async function writeSummary(run) {
  const collected = await collectResults();
  const lines = [
    '# Browser E2E smoke',
    '',
    `- Base URL: ${WEB_ORIGIN}`,
    `- Playwright exit code: ${run.code}`,
    `- Duration: ${Math.round((collected?.duration || run.duration) / 1000)}s`,
    `- Artifacts: \`${ARTIFACTS}\``,
    '',
  ];
  if (collected?.tests?.length) {
    lines.push('| Test | Status | Duration |', '| --- | --- | --- |');
    for (const test of collected.tests) {
      lines.push(
        `| ${test.title.replaceAll('|', '\\|')} | ${test.status} | ${Math.round(test.duration / 100) / 10}s |`,
      );
      if (test.error) lines.push(`| ↳ | ${test.error.replaceAll('|', '\\|')} | |`);
    }
  } else {
    lines.push('No machine-readable Playwright results were produced.');
  }
  lines.push(
    '',
    'Screenshots: `artifacts/screens/`; traces/videos: `artifacts/test-results/`; HTML report: `artifacts/html/index.html`.',
    '',
  );
  await writeFile(join(ARTIFACTS, 'summary.md'), lines.join('\n'), 'utf8');
}

async function main() {
  log(`repo ${ROOT}`);
  rmSync(DATA, { recursive: true, force: true });
  rmSync(ARTIFACTS, { recursive: true, force: true });
  rmSync(LOGS, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(ARTIFACTS, 'screens'), { recursive: true });

  await assertFreePort(API_PORT, 'Go API', 'PP_E2E_API_PORT');
  if (!SKIP_SECURITY) await assertFreePort(SEC_PORT, 'security service', 'PP_E2E_SECURITY_PORT');
  await assertFreePort(WEB_PORT, 'static web server', 'PP_E2E_WEB_PORT');

  const go = findGo();
  const security = SKIP_SECURITY ? '' : findSecurity();
  if (!SKIP_SECURITY && !security) {
    fail(
      'security service binary not found; run `cargo build --release` in services/security ' +
        'or set PP_E2E_SECURITY_BIN',
    );
  }
  if (SKIP_SECURITY) {
    log('WARNING: security service skipped; registration/login/publish will fail closed');
  }

  log('building Go API');
  const apiExe = join(BIN, process.platform === 'win32' ? 'practacu-api.exe' : 'practacu-api');
  const build = await runLogged('go-build', go, ['build', '-o', apiExe, './apps/api/cmd/server'], ROOT);
  if (build.code !== 0) fail(`go build failed with code ${build.code}; see .tmp/e2e/logs/go-build.log`);

  if (!SKIP_WEB_BUILD) {
    log('building web (tsc + vite)');
    const npmBuild = npmInvocation(['run', 'build']);
    let webBuild = await runLogged('web-build', npmBuild.command, npmBuild.args, APP_WEB);
    if (webBuild.code !== 0) {
      // Windows/杀毒软件偶尔会锁住 esbuild 的临时文件，重试一次通常就过；
      // 真正的类型错误会稳定失败，不会因为重试被掩盖。
      log('web build failed; retrying once (esbuild temp-file cleanup can be flaky)');
      webBuild = await runLogged('web-build-retry', npmBuild.command, npmBuild.args, APP_WEB);
    }
    if (webBuild.code !== 0) {
      fail(`web build failed with code ${webBuild.code}; see .tmp/e2e/logs/web-build.log`);
    }
  } else if (!existsSync(join(APP_WEB, 'dist', 'index.html'))) {
    fail('PP_E2E_SKIP_WEB_BUILD=1 but apps/web/dist/index.html is missing');
  }

  if (!SKIP_SECURITY) {
    log(`starting security service on 127.0.0.1:${SEC_PORT}`);
    startService('security', security, [], {
      cwd: ROOT,
      env: { ...process.env, SECURITY_GRPC_BIND: `127.0.0.1:${SEC_PORT}` },
    });
    if (!(await waitTcp(SEC_PORT, 20000))) {
      fail('security service did not open its gRPC port; see .tmp/e2e/logs/security.log');
    }
  }

  const sqlitePath = join(DATA, 'practacu.db').replaceAll('\\', '/');
  const apiEnv = {
    ...process.env,
    APP_ENV: 'development',
    HTTP_ADDR: `127.0.0.1:${API_PORT}`,
    DATABASE_DRIVER: 'sqlite',
    DATABASE_DSN: `file:${sqlitePath}?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)`,
    SECURITY_GRPC_ADDR: `127.0.0.1:${SEC_PORT}`,
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: join(DATA, 'media'),
    PP_DESKTOP: 'true',
    // 浏览器套件会在很短时间内反复导航、刷新、重连实时通道；生产默认的
    // 240 请求/分钟会把它自己的正常操作当成滥用。测试进程单独放宽两档限额。
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE: '1000',
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };

  log(`starting Go API on ${API_ORIGIN}`);
  startService('api', apiExe, [], { cwd: ROOT, env: apiEnv });
  await waitHttp(`${API_ORIGIN}/healthz`, (response) => response.ok, 30000, 'GET /healthz');
  await waitHttp(
    `${API_ORIGIN}/readyz`,
    (response, body) => response.ok && body.includes('ready'),
    30000,
    'GET /readyz',
  );

  const setup = JSON.parse(await waitHttp(`${API_ORIGIN}/api/v1/setup/status`, (r) => r.ok, 10000));
  if (!setup.installed || setup.has_admin) {
    fail(`expected a fresh desktop install, got ${JSON.stringify(setup)}`);
  }
  log(`fresh install ready (site=${setup.site_name || setup.site_id || 'unknown'})`);

  log(`starting static web server on ${WEB_ORIGIN}`);
  startService('web', process.execPath, [join(APP_WEB, 'e2e', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PP_E2E_WEB_PORT: String(WEB_PORT),
      PP_E2E_API_ORIGIN: API_ORIGIN,
      PP_E2E_DIST: join(APP_WEB, 'dist'),
    },
  });
  await waitHttp(WEB_ORIGIN, (response, body) => response.ok && body.includes('<div id="root"'), 20000);

  const cli = join(APP_WEB, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) fail('@playwright/test is not installed; run `npm install` in apps/web');

  log('running Playwright (headless)');
  const started = Date.now();
  const testRun = await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', join(APP_WEB, 'e2e', 'playwright.config.ts')], {
      cwd: APP_WEB,
      env: {
        ...process.env,
        PP_E2E_BASE: WEB_ORIGIN,
        PP_E2E_ARTIFACTS: ARTIFACTS,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (error) => resolveRun({ code: -1, error }));
    child.on('exit', (code) => resolveRun({ code: code ?? -1 }));
  });

  const run = { code: testRun.code, duration: Date.now() - started };
  await writeSummary(run);

  log('');
  log(`screenshots : ${join(ARTIFACTS, 'screens')}`);
  log(`html report : ${join(ARTIFACTS, 'html', 'index.html')}`);
  log(`json report : ${join(ARTIFACTS, 'results.json')}`);
  log(`traces      : ${join(ARTIFACTS, 'test-results')}`);
  log(`logs        : ${LOGS}`);
  log(`summary     : ${join(ARTIFACTS, 'summary.md')}`);
  return testRun.code;
}

let exitCode = 1;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}, stopping services`);
    stopChildren();
    process.exit(1);
  });
}
try {
  exitCode = await main();
} catch (error) {
  log(`FAILED: ${error.message}`);
  const apiLog = join(LOGS, 'api.log');
  if (existsSync(apiLog)) {
    log('--- last API log lines ---');
    try {
      const content = await readFile(apiLog, 'utf8');
      process.stdout.write(content.split(/\r?\n/).slice(-25).join('\n') + '\n');
    } catch {
      /* ignore */
    }
  }
  exitCode = 1;
} finally {
  stopChildren();
  await sleep(400);
}

process.exit(exitCode);
