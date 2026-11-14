#!/usr/bin/env node
/**
 * Build the Linux install package: release/PractacuPress-Linux-x64.tar.gz
 *
 *   node scripts/package-linux.mjs                 # full build (web + Go + Rust + tar.gz)
 *   node scripts/package-linux.mjs --skip-web      # reuse apps/web/dist
 *   node scripts/package-linux.mjs --skip-security # package without the Rust binary (degraded)
 *
 * What it does
 *   1. builds the frontend (unless --skip-web) and the Go binaries with GOOS=linux;
 *   2. picks up the Rust security binary built for Linux (native or musl cross build);
 *   3. assembles PractacuPress-Linux-x64/ from deploy/linux templates + the artifacts;
 *   4. runs static self-checks (ELF arch, frontend presence, LF-only scripts);
 *   5. writes a deterministic-ish tar.gz (ustar + gzip) and its sha256.
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
const SKIP_SECURITY = flag('--skip-security');
const ALLOW_DEGRADED = flag('--allow-degraded');
const ARCH = option('--arch', 'amd64');
const OUT_DIR = path.resolve(option('--out', DEFAULT_OUT));
const SECURITY_OVERRIDE = option('--security', '');

if (!['amd64', 'arm64'].includes(ARCH)) {
  fail(`unsupported --arch ${ARCH} (use amd64 or arm64)`);
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
    if (!fs.existsSync(path.join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
      fail('--skip-web 但 apps/web/dist 不存在；先运行 npm run build');
    }
    ok('复用 apps/web/dist');
    return;
  }
  log('构建前端');
  const temp = path.join(ROOT, '.tmp', 'eb');
  fs.mkdirSync(temp, { recursive: true });
  run(npmCommand(), ['run', 'build'], {
    cwd: path.join(ROOT, 'apps', 'web'),
    // Windows 上 esbuild 会写系统临时目录，项目里偶尔被 ACL 拦；指到工作区内更稳。
    env: { TMP: temp, TEMP: temp, TMPDIR: temp },
  });
}

// ---- 2. Go ----------------------------------------------------------------
function buildGo(binDir) {
  const go = goCommand();
  log(`构建 Go 二进制（linux/${ARCH}，纯静态）`);
  const targets = [
    { pkg: './apps/api/cmd/server', name: 'practacu-api' },
    { pkg: './apps/api/cmd/migrate', name: 'practacu-migrate' },
    { pkg: './apps/api/cmd/seed', name: 'practacu-seed' },
  ];
  for (const target of targets) {
    const out = path.join(binDir, target.name);
    run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, target.pkg], {
      env: { GOOS: 'linux', GOARCH: ARCH, CGO_ENABLED: '0', GOFLAGS: '' },
    });
    assertElf(out, target.name);
  }
}

// ---- 3. Rust 安全服务 -----------------------------------------------------
function findSecurityBinary() {
  const candidates = [];
  if (SECURITY_OVERRIDE) candidates.push(path.resolve(SECURITY_OVERRIDE));
  candidates.push(
    path.join(ROOT, 'services', 'security', 'target', `x86_64-unknown-linux-musl`, 'release', 'practacu-security'),
    path.join(ROOT, 'services', 'security', 'target', 'release', 'practacu-security'),
    path.join(ROOT, 'services', 'security', 'target', 'release', 'practacu-security.exe'),
  );
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const elf = readElf(candidate);
      if (elf.magic === '\x7fELF' && elf.machine === ELF_MACHINE) return candidate;
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

function copySecurity(binDir) {
  if (SKIP_SECURITY) {
    warn('已按 --skip-security 跳过安全服务：发布文章与完成上传会返回 503');
    return false;
  }
  const found = findSecurityBinary();
  if (!found) {
    const message =
      '找不到 Linux 版 practacu-security。先交叉编译（Windows 构建机）：\n' +
      '  rustup target add x86_64-unknown-linux-musl\n' +
      '  cd services/security\n' +
      '  $env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="<rust-lld.exe 路径>"\n' +
      '  $env:RUSTFLAGS="-C link-self-contained=yes"\n' +
      '  cargo build --release --target x86_64-unknown-linux-musl\n' +
      '或在 Linux 构建机上直接 cargo build --release。\n' +
      '确实要打一个降级包（发布/上传不可用）时加 --allow-degraded。';
    if (ALLOW_DEGRADED) {
      warn(message);
      return false;
    }
    fail(message);
  }
  const target = path.join(binDir, 'practacu-security');
  copyFile(found, target, 0o755);
  assertElf(target, 'practacu-security');
  return true;
}

// ---- 4. 组装 --------------------------------------------------------------
function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'package.json'), 'utf8'));
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() : 'unknown';
  return `${pkg.version}+${commit}`;
}

function assemble(securityPresent) {
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
  buildGo(builtBin);
  for (const name of ['practacu-api', 'practacu-migrate', 'practacu-seed']) {
    copyFile(path.join(builtBin, name), path.join(binDir, name), 0o755);
  }
  const securityPresent2 = copySecurity(binDir);

  copyTree(path.join(ROOT, 'apps', 'web', 'dist'), path.join(PACKAGE, 'web'));

  fs.writeFileSync(
    path.join(PACKAGE, 'VERSION'),
    `${packageVersion()}\n`,
    'utf8',
  );

  // 文本文件统一 LF；shebang 与可执行位在 tar 写入时再确保一次。
  for (const entry of walk(PACKAGE)) {
    if (!entry.isDirectory) normalizeText(entry.full);
  }
  return securityPresent2;
}

function selfCheck() {
  log('自检');
  const required = [
    'install.sh',
    'uninstall.sh',
    'INSTALL.md',
    'README.txt',
    'VERSION',
    'bin/practacu-api',
    'bin/practacu-seed',
    'web/index.html',
    'deploy/nginx/site.conf.in',
    'deploy/nginx/tls.conf.in',
    'deploy/nginx/locations.conf.in',
    'deploy/systemd/practacu-press-api.service.in',
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(PACKAGE, relative))) fail(`自检失败：缺少 ${relative}`);
  }
  ok('必需文件齐全');

  for (const name of ['install.sh', 'uninstall.sh']) {
    const text = fs.readFileSync(path.join(PACKAGE, name), 'utf8');
    if (!text.startsWith('#!/usr/bin/env bash')) fail(`自检失败：${name} 缺少 bash shebang`);
    if (text.includes('\r')) fail(`自检失败：${name} 含 CRLF，Linux 上会执行失败`);
  }
  ok('安装脚本为 LF bash 脚本');

  assertElf(path.join(PACKAGE, 'bin', 'practacu-api'), 'bin/practacu-api');
  assertElf(path.join(PACKAGE, 'bin', 'practacu-seed'), 'bin/practacu-seed');

  const html = fs.readFileSync(path.join(PACKAGE, 'web', 'index.html'), 'utf8');
  if (!html.includes('id="root"')) fail('自检失败：web/index.html 不像前端入口');
  ok('前端入口存在');
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
assemble(true);
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
