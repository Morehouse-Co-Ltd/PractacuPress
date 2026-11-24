#!/usr/bin/env node
/**
 * Build the macOS package: release/PractacuPress-macOS-<arm64|x86_64>.tar.gz
 *
 *   node scripts/package-macos.mjs --arch arm64 --version v1.0.1-beta1
 *   node scripts/package-macos.mjs --arch amd64 --skip-web
 *
 * Must run on macOS: it uses the native tar/shasum tools so executable bits and
 * code signing metadata survive.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncEmbeddedWeb } from './lib/embed-web.mjs';
import { parseVersion } from './lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'release');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const ARCH = option('--arch', process.arch === 'arm64' ? 'arm64' : 'amd64');
const SKIP_WEB = flag('--skip-web');
const OUT_DIR = path.resolve(option('--out', DEFAULT_OUT));
// 版本口径（含 -beta/-betaN 规范化）只由 scripts/lib/version.mjs 实现。
const RELEASE_INPUT = option('--version', '');
const RELEASE = RELEASE_INPUT ? parseVersion(RELEASE_INPUT) : null;
const ARCH_LABEL = ARCH === 'arm64' ? 'arm64' : 'x86_64';
const PACKAGE_NAME = `PractacuPress-macOS-${ARCH_LABEL}`;
const STAGE_ROOT = path.join(ROOT, '.tmp', 'macospkg');
const PACKAGE = path.join(STAGE_ROOT, PACKAGE_NAME);
const TARBALL = path.join(OUT_DIR, `${PACKAGE_NAME}.tar.gz`);
const SHA_FILE = `${TARBALL}.sha256`;

if (!['amd64', 'arm64'].includes(ARCH)) fail(`unsupported --arch ${ARCH}`);
if (RELEASE_INPUT && !RELEASE) {
  fail(`unsupported --version ${RELEASE_INPUT} (want X.Y.Z or X.Y.Z-beta[.N])`);
}
if (process.platform !== 'darwin') fail('macOS 包必须在 macOS 上构建');

function log(message) { console.log(`==> ${message}`); }
function ok(message) { console.log(`  ✓ ${message}`); }
function fail(message) { console.error(`[错误] ${message}`); process.exit(1); }

function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with ${result.status}`);
}

function rmrf(target) { fs.rmSync(target, { recursive: true, force: true }); }
function copyFile(from, to, mode = 0o644) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, mode);
}
function copyTree(from, to, mode) {
  fs.cpSync(from, to, { recursive: true, force: true, dereference: true });
  if (mode) chmodTree(to, mode);
}
function chmodTree(target, mode) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) chmodTree(full, mode);
    else fs.chmodSync(full, mode);
  }
}

function goCommand() {
  const result = spawnSync('go', ['version'], { stdio: 'ignore' });
  if (result.status === 0) return 'go';
  fail('找不到 Go 工具链');
}

function stampWebVersion(dir) {
  if (!RELEASE) return;
  const file = path.join(dir, 'version.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, `${JSON.stringify({
    title: current.title || 'Practacu Press',
    describe: current.describe || '自托管内容站点：文章、页面、主题与扩展都在你自己的机器上。',
    version: RELEASE.version,
    style: RELEASE.channel,
  }, null, 2)}\n`, 'utf8');
}

function main() {
  if (!SKIP_WEB) {
    // Stamp before the build so the version inlined by Vite matches the manifest
    // served as /version.json.
    stampWebVersion(path.join(ROOT, 'web', 'public'));
    run('npm', ['run', 'build'], { cwd: path.join(ROOT, 'web') });
  } else if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    fail('--skip-web 但 web/dist 不存在');
  }
  stampWebVersion(path.join(ROOT, 'web', 'dist'));

  rmrf(STAGE_ROOT);
  fs.mkdirSync(PACKAGE, { recursive: true });
  for (const name of ['install.sh', 'uninstall.sh', 'README.txt']) {
    copyFile(path.join(ROOT, 'deploy', 'macos', name), path.join(PACKAGE, name), name.endsWith('.sh') ? 0o755 : 0o644);
  }
  copyTree(path.join(ROOT, 'deploy', 'macos'), path.join(PACKAGE, 'deploy', 'macos'));
  copyTree(path.join(ROOT, 'deploy', 'linux', 'nginx'), path.join(PACKAGE, 'deploy', 'linux', 'nginx'));

  const binDir = path.join(PACKAGE, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  syncEmbeddedWeb({ root: ROOT, dist: path.join(ROOT, 'web', 'dist') });
  const go = goCommand();
  const targets = [
    { pkg: './cmd/server', name: 'practacu-press' },
    { pkg: './cmd/migrate', name: 'practacu-migrate' },
    { pkg: './cmd/seed', name: 'practacu-seed' },
    { pkg: './cmd/backup', name: 'practacu-backup' },
    { pkg: './cmd/media-gc', name: 'practacu-media-gc' },
    { pkg: './cmd/searchindex', name: 'practacu-searchindex' },
  ];
  for (const target of targets) {
    const out = path.join(binDir, target.name);
    run(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', out, target.pkg], {
      env: { GOOS: 'darwin', GOARCH: ARCH, CGO_ENABLED: '0' },
    });
  }
  fs.writeFileSync(path.join(PACKAGE, 'VERSION'), `${RELEASE ? RELEASE.version : 'development'}\n`, 'utf8');
  fs.writeFileSync(path.join(PACKAGE, 'ARCH'), `${ARCH}\n`, 'utf8');

  // Normalise the text files the installer reads over SSH/scp.
  for (const name of ['install.sh', 'uninstall.sh', 'README.txt']) {
    const file = path.join(PACKAGE, name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  rmrf(TARBALL);
  run('tar', ['-czf', TARBALL, '-C', STAGE_ROOT, PACKAGE_NAME]);
  const hash = createHash('sha256').update(fs.readFileSync(TARBALL)).digest('hex');
  fs.writeFileSync(SHA_FILE, `${hash}  ${path.basename(TARBALL)}\n`, 'utf8');
  ok(`${path.relative(ROOT, TARBALL)}（${(fs.statSync(TARBALL).size / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  架构 ${ARCH_LABEL} · ${hash}`);
}

main();
