#!/usr/bin/env node
/**
 * Build the Linux install package:
 *   release/PractacuPress-Linux-<x64|arm64>.tar.gz
 *
 *   node scripts/package-linux.mjs --arch amd64
 *   node scripts/package-linux.mjs --arch arm64 --skip-web --version v1.0.1-beta1
 *
 * What it does
 *   1. builds the frontend (unless --skip-web) and the Go binaries with GOOS=linux;
 *   3. assembles PractacuPress-Linux-<arch>/ from deploy/linux templates + artifacts;
 *   4. runs static self-checks (ELF arch, frontend presence, LF-only scripts);
 *   5. writes a deterministic-ish tar.gz (ustar + gzip) and its sha256.
 *
 * The .deb/.rpm wrappers are produced separately from the assembled tree with
 * deploy/package/nfpm.yaml (see .github/workflows/release.yml).
 *
 * The archive is written by a small built-in tar writer so file modes (0755 on
 * scripts and binaries) survive on Windows build hosts, where the native tar
 * would drop them.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { syncEmbeddedWeb } from './lib/embed-web.mjs';
import { parseVersion } from './lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'release');
const STAGE_ROOT = path.join(ROOT, '.tmp', 'linuxpkg');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const SKIP_WEB = flag('--skip-web');
const ARCH = option('--arch', 'amd64');
const OUT_DIR = path.resolve(option('--out', DEFAULT_OUT));
// 版本口径（含 -beta/-betaN 规范化）只由 scripts/lib/version.mjs 实现。
const RELEASE_INPUT = option('--version', '');
const RELEASE = RELEASE_INPUT ? parseVersion(RELEASE_INPUT) : null;

if (!['amd64', 'arm64'].includes(ARCH)) {
  fail(`unsupported --arch ${ARCH} (use amd64 or arm64)`);
}
if (RELEASE_INPUT && !RELEASE) {
  fail(`unsupported --version ${RELEASE_INPUT} (want X.Y.Z or X.Y.Z-beta[.N])`);
}
const ARCH_LABEL = ARCH === 'amd64' ? 'x64' : 'arm64';
const ELF_MACHINE = ARCH === 'amd64' ? 0x3e : 0xb7;
const PACKAGE_NAME = `PractacuPress-Linux-${ARCH_LABEL}`;
const PACKAGE = path.join(STAGE_ROOT, PACKAGE_NAME);
const TARBALL = path.join(OUT_DIR, `${PACKAGE_NAME}.tar.gz`);
const SHA_FILE = `${TARBALL}.sha256`;

function log(message) { console.log(`==> ${message}`); }
function ok(message) { console.log(`  \u2713 ${message}`); }
function warn(message) { console.warn(`[警告] ${message}`); }
function fail(message) { console.error(`[错误] ${message}`); process.exit(1); }

function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    // Windows 上 .cmd（npm.cmd）必须经 shell 才能启动。
    shell: options.shell ?? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)),
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with ${result.status}`);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function goCommand() {
  for (const candidate of [
    process.env.GO,
    process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : '',
    'go',
  ]) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return candidate;
  }
  fail('找不到 Go 工具链（需要 Go 1.26+）');
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** @returns {{magic:string, elfClass:number, machine:number, type:number, size:number}} */
function readElf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, header.length, 0);
    return {
      magic: header.subarray(0, 4).toString('latin1'),
      elfClass: header[4],
      machine: header.readUInt16LE(18),
      type: header.readUInt16LE(16),
      size: fs.statSync(file).size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertElf(file, label) {
  const elf = readElf(file);
  if (elf.magic !== '\x7fELF') fail(`${label} 不是 ELF 二进制：${file}`);
  if (elf.elfClass !== 2) fail(`${label} 不是 64 位 ELF：${file}`);
  if (elf.machine !== ELF_MACHINE) {
    fail(`${label} 的 ELF machine=0x${elf.machine.toString(16)}，期望 0x${ELF_MACHINE.toString(16)}（架构不匹配）`);
  }
  if (![2, 3].includes(elf.type)) fail(`${label} 不是可执行 ELF（type=${elf.type}）`);
  ok(`${label}：${(elf.size / 1024 / 1024).toFixed(1)} MB ELF64`);
}

function copyFile(from, to, mode = 0o644) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, mode);
}

function copyTree(from, to, { mode } = {}) {
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });
  if (mode) chmodTree(to, mode);
}

function chmodTree(target, mode) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) chmodTree(full, mode);
    else fs.chmodSync(full, mode);
  }
}

const TEXT_EXTENSIONS = new Set(['.sh', '.in', '.md', '.txt', '.conf']);
function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file)) || path.basename(file) === 'VERSION';
}
function normalizeText(file) {
  if (!isTextFile(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\r\n')) {
    fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
    ok(`${path.relative(PACKAGE, file)} 已转为 LF`);
  }
}

function walk(target, list = []) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(target, entry.name);
    list.push({ full, isDirectory: entry.isDirectory() });
    if (entry.isDirectory()) walk(full, list);
  }
  return list;
}

// ---- 1. 前端 --------------------------------------------------------------
function buildWeb() {
  if (SKIP_WEB) {
    if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
      fail('--skip-web 但 web/dist 不存在；先运行 npm run build');
    }
    ok('复用 web/dist');
    return;
  }
  log('构建前端');
  // Stamp the source manifest before the build: appVersion.ts imports it, so
  // stamping only dist/ afterwards would leave the bundle reporting an older
  // version than the served /version.json.
  stampWebVersion(path.join(ROOT, 'web', 'public'));
  const temp = path.join(ROOT, '.tmp', 'eb');
  fs.mkdirSync(temp, { recursive: true });
  run(npmCommand(), ['run', 'build'], {
    cwd: path.join(ROOT, 'web'),
    // Windows 上 esbuild 会写系统临时目录，项目里偶尔被 ACL 拦；指到工作区内更稳。
    env: { TMP: temp, TEMP: temp, TMPDIR: temp },
  });
}

// ---- 2. Go ----------------------------------------------------------------
function buildGo(binDir) {
  const go = goCommand();
  log(`构建 Go 二进制（linux/${ARCH}，纯静态，内嵌前端）`);
  syncEmbeddedWeb({ root: ROOT, dist: path.join(ROOT, 'web', 'dist') });
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
    run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, target.pkg], {
      env: { GOOS: 'linux', GOARCH: ARCH, CGO_ENABLED: '0', GOFLAGS: '' },
    });
    assertElf(out, target.name);
  }
}

// ---- 4. 组装 --------------------------------------------------------------
// Version stamped into the package. Release builds must pass --version; local
// builds fall back to the frontend manifest plus the commit.
function packageVersion() {
  if (RELEASE) return RELEASE.version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() : 'unknown';
  return `${pkg.version}+${commit}`;
}

// The frontend reads /version.json for the footer and the update screen. Leave the
// repository's development value in place unless a release version was supplied.
function stampWebVersion(webDir) {
  if (!RELEASE) return;
  const file = path.join(webDir, 'version.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = {
    title: current.title || 'Practacu Press',
    describe:
      current.describe ||
      '自托管内容站点：文章、页面、主题与扩展都在你自己的机器上。',
    version: RELEASE.version,
    style: RELEASE.channel,
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function assemble() {
  log(`组装 ${PACKAGE}`);
  rmrf(STAGE_ROOT);
  fs.mkdirSync(PACKAGE, { recursive: true });

  const linux = path.join(ROOT, 'deploy', 'linux');
  for (const name of ['install.sh', 'uninstall.sh', 'INSTALL.md', 'README.txt']) {
    copyFile(path.join(linux, name), path.join(PACKAGE, name), name.endsWith('.sh') ? 0o755 : 0o644);
  }
  copyTree(path.join(linux, 'systemd'), path.join(PACKAGE, 'deploy', 'systemd'));
  copyTree(path.join(linux, 'nginx'), path.join(PACKAGE, 'deploy', 'nginx'));

  const binDir = path.join(PACKAGE, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const builtBin = path.join(STAGE_ROOT, 'build', 'bin');
  rmrf(builtBin);
  fs.mkdirSync(builtBin, { recursive: true });
  // Stamp the source dist before embedding it: building the Go binary copies this
  // tree into internal/web/dist, and the package no longer ships web/.
  stampWebVersion(path.join(ROOT, 'web', 'dist'));
  buildGo(builtBin);
  const binaries = [
    'practacu-press',
    'practacu-migrate',
    'practacu-seed',
    'practacu-backup',
    'practacu-media-gc',
    'practacu-searchindex',
  ];
  for (const name of binaries) {
    copyFile(path.join(builtBin, name), path.join(binDir, name), 0o755);
  }

  fs.writeFileSync(path.join(PACKAGE, 'VERSION'), `${packageVersion()}\n`, 'utf8');
  fs.writeFileSync(path.join(PACKAGE, 'ARCH'), `${ARCH}\n`, 'utf8');

  // 文本文件统一 LF；shebang 与可执行位在 tar 写入时再确保一次。
  for (const entry of walk(PACKAGE)) {
    if (!entry.isDirectory) normalizeText(entry.full);
  }
}

function selfCheck() {
  log('自检');
  const required = [
    'install.sh',
    'uninstall.sh',
    'INSTALL.md',
    'README.txt',
    'VERSION',
    'ARCH',
    'bin/practacu-press',
    'bin/practacu-migrate',
    'bin/practacu-seed',
    'bin/practacu-backup',
    'bin/practacu-media-gc',
    'bin/practacu-searchindex',
    'deploy/nginx/site.conf.in',
    'deploy/nginx/tls.conf.in',
    'deploy/nginx/locations.conf.in',
    'deploy/systemd/practacu-press-api.service.in',
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(PACKAGE, relative))) fail(`自检失败：缺少 ${relative}`);
  }
  ok('必需文件齐全');

  if (fs.readFileSync(path.join(PACKAGE, 'ARCH'), 'utf8').trim() !== ARCH) {
    fail('自检失败：ARCH 与打包架构不一致');
  }

  for (const name of ['install.sh', 'uninstall.sh']) {
    const text = fs.readFileSync(path.join(PACKAGE, name), 'utf8');
    if (!text.startsWith('#!/usr/bin/env bash')) fail(`自检失败：${name} 缺少 bash shebang`);
    if (text.includes('\r')) fail(`自检失败：${name} 含 CRLF，Linux 上会执行失败`);
  }
  ok('安装脚本为 LF bash 脚本');

  assertElf(path.join(PACKAGE, 'bin', 'practacu-press'), 'bin/practacu-press');
  assertElf(path.join(PACKAGE, 'bin', 'practacu-seed'), 'bin/practacu-seed');
}

// ---- 5. tar.gz ------------------------------------------------------------
function octal(value, width) {
  const text = value.toString(8);
  return `${'0'.repeat(Math.max(0, width - 1 - text.length))}${text}\0`;
}

function tarHeader({ name, size, mode, mtime, type }) {
  const header = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    let split = -1;
    for (let i = 0; i < name.length; i += 1) {
      if (name[i] !== '/') continue;
      const prefixLength = Buffer.byteLength(name.slice(0, i));
      const restLength = Buffer.byteLength(name.slice(i + 1));
      if (prefixLength <= 155 && restLength <= 100) split = i;
    }
    if (split < 0) fail(`tar: 路径过长且无法拆分：${name}`);
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'latin1');
  header.write(octal(0, 8), 108, 8, 'latin1');
  header.write(octal(0, 8), 116, 8, 'latin1');
  header.write(octal(size, 12), 124, 12, 'latin1');
  header.write(octal(mtime, 12), 136, 12, 'latin1');
  header.write('        ', 148, 8, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.write('root', 265, 32, 'latin1');
  header.write('root', 297, 32, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function buildTar(entries, mtime) {
  const chunks = [];
  for (const entry of entries) {
    const relative = path.relative(STAGE_ROOT, entry.full).split(path.sep).join('/');
    const size = entry.isDirectory ? 0 : fs.statSync(entry.full).size;
    const mode = entry.isDirectory ? 0o755 : entry.full.endsWith('.sh') || relative.includes('/bin/') ? 0o755 : 0o644;
    const name = entry.isDirectory ? `${relative}/` : relative;
    chunks.push(tarHeader({ name, size, mode, mtime, type: entry.isDirectory ? '5' : '0' }));
    if (!entry.isDirectory) {
      const content = fs.readFileSync(entry.full);
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeArchive() {
  log('写入 tar.gz');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mtime = Number(process.env.SOURCE_DATE_EPOCH || Math.floor(Date.now() / 1000));
  const entries = [{ full: PACKAGE, isDirectory: true }, ...walk(PACKAGE)];
  const tar = buildTar(entries, mtime);
  const gzip = zlib.gzipSync(tar, { level: 9 });
  fs.writeFileSync(TARBALL, gzip);
  const hash = createHash('sha256').update(gzip).digest('hex');
  fs.writeFileSync(SHA_FILE, `${hash}  ${path.basename(TARBALL)}\n`, 'utf8');
  ok(`${path.relative(ROOT, TARBALL)}（${(gzip.length / 1024 / 1024).toFixed(1)} MB）`);
  ok(`${path.relative(ROOT, SHA_FILE)}：${hash}`);
}

// ---- main -----------------------------------------------------------------
log(`Practacu Press Linux 安装包（${PACKAGE_NAME}）`);
buildWeb();
assemble();
selfCheck();
writeArchive();
printfSummary();

function printfSummary() {
  console.log('');
  console.log('完成：');
  console.log(`  目录   ${path.relative(ROOT, PACKAGE)}`);
  console.log(`  压缩包 ${path.relative(ROOT, TARBALL)}`);
  console.log(`  校验   ${path.relative(ROOT, SHA_FILE)}`);
  console.log('');
  console.log('在目标 Linux 机器上：');
  console.log(`  tar -xzf ${path.basename(TARBALL)}`);
  console.log(`  cd ${PACKAGE_NAME}`);
  console.log('  sudo ./install.sh');
}
