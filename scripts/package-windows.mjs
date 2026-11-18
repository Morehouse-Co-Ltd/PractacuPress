#!/usr/bin/env node
/**
 * Practacu Press · Windows 便携包一键打包
 *
 *   node scripts/package-windows.mjs                        # 当前机器架构
 *   node scripts/package-windows.mjs --arch amd64
 *   node scripts/package-windows.mjs --arch arm64 --version v1.0.1-beta1
 *
 * 默认流程（每一步失败都会立刻停下并打印原因）：
 *   1. 构建前端（web → dist），缺少 node_modules 时自动安装依赖
 *   2. 把前端产物同步进启动器的 go:embed 目录
 *   3. 编译 Go 启动器（launcher）与 Go API（Windows，目标架构）
 *   4. 组装干净的分发目录（exe + README.txt + VERSION）
 *   5. 自检：用随机端口在临时目录启动打包产物，验证静态站点、/api/healthz、/api/readyz、
 *      注册、文章创建（Go 内嵌安全清洗）与发布（仅本机架构可执行时）
 *   6. 压缩成 release/PractacuPress-Windows-<x64|arm64>.zip
 *
 * 常用参数：
 *   --arch amd64|arm64   目标架构（默认当前 Node 架构）
 *   --version <tag>      发布版本（写入 VERSION 与 web/version.json）
 *   --skip-web           复用 web/dist（CI 已单独构建时）
 *   --skip-smoke         跳过自检（不推荐；跨架构构建会自动跳过）
 *   --no-zip             只生成 release/PractacuPress 目录，不压缩
 *   --release-dir <目录>  输出目录（默认 <仓库>/release，也可用 PP_RELEASE_DIR）
 *   --port <端口>        自检时固定使用该端口（默认自动挑空闲端口）
 *   --keep-staging       保留 release/.staging 中间目录，便于排查
 *   --help               打印本说明
 *
 * 环境变量：
 *   PP_RELEASE_DIR      同 --release-dir
 *
 * 注意：Windows 上 esbuild 会往 %TEMP% 写临时文件，某些安全软件/沙箱会拒绝清理，
 * 导致 “vite:esbuild-transpile remove ... Access is denied”。脚本把所有子进程的
 * TEMP/TMP 指到仓库内的 .tmpbuild/tmp，绕开系统临时目录的删除限制。
 *
 * 架构说明：Go 可以交叉编译；CI 用 x64 与 arm64 的 Windows runner 原生构建。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { syncEmbeddedWeb } from './lib/embed-web.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const launcherDir = path.join(root, 'launcher');
const distDir = path.join(webDir, 'dist');
const embedDir = path.join(launcherDir, 'web', 'dist');
const tmpRoot = path.join(root, '.tmpbuild', 'tmp');

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const ARCH = options.arch || HOST_ARCH;
const NATIVE_ARCH = ARCH === HOST_ARCH;
const ARCH_LABEL = ARCH === 'arm64' ? 'arm64' : 'x64';
const RELEASE_VERSION = String(options.version || '').replace(/^v/i, '');
if (RELEASE_VERSION && !/^\d+\.\d+\.\d+(?:-beta\.?\d+)?$/i.test(RELEASE_VERSION)) {
  throw new Error(`--version 只支持 X.Y.Z 或 X.Y.Z-betaN，收到 ${options.version}`);
}

const releaseDir = path.resolve(options.releaseDir || process.env.PP_RELEASE_DIR || path.join(root, 'release'));
const stagingRoot = path.join(releaseDir, '.staging');
const stagingDir = path.join(stagingRoot, `PractacuPress-Windows-${ARCH_LABEL}`);
const hostPackageDir = path.join(releaseDir, 'PractacuPress');
const zipPath = path.join(releaseDir, `PractacuPress-Windows-${ARCH_LABEL}.zip`);

// 所有子进程共享的临时目录：避开系统 %TEMP% 的删除限制（见文件头说明）。
fs.mkdirSync(tmpRoot, { recursive: true });
const baseEnv = { ...process.env, TEMP: tmpRoot, TMP: tmpRoot };
const goEnv = { ...baseEnv, GOOS: 'windows', GOARCH: ARCH, CGO_ENABLED: '0' };

main().catch((err) => {
  process.stdout.write(`\n打包失败：${err && err.message ? err.message : err}\n`);
  if (process.env.PP_DEBUG && err && err.stack) process.stdout.write(`${err.stack}\n`);
  process.exitCode = 1;
});

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('这个打包脚本生成的是 Windows 便携包，请在 Windows 上运行。');
  }

  step('检查工具链');
  ensureNodeVersion(process.versions.node);
  const go = resolveGo();
  const goVersion = capture(go, ['version']);
  console.log(`  Node    ${process.version}`);
  console.log(`  Go      ${goVersion}  (${go})`);
  console.log(`  目标    windows/${ARCH}${NATIVE_ARCH ? '（本机）' : `（交叉，宿主机 ${HOST_ARCH}）`}`);


  fs.mkdirSync(releaseDir, { recursive: true });
  rmrf(stagingRoot);
  fs.mkdirSync(stagingDir, { recursive: true });

  step('构建前端');
  if (options.skipWeb) {
    requireFile(path.join(distDir, 'index.html'), '--skip-web 但 web/dist 不存在；先运行 npm run build');
    console.log('  复用 web/dist');
  } else {
    ensureWebDeps();
    runShell('npm run build', webDir, 'npm run build');
    requireFile(path.join(distDir, 'index.html'), '前端构建完成但没有 web/dist/index.html');
    console.log('  dist/index.html 已生成');
  }
  stampWebVersion(distDir);


  step('把前端产物同步进启动器（go:embed）');
  rmrf(embedDir);
  fs.mkdirSync(embedDir, { recursive: true });
  fs.cpSync(distDir, embedDir, { recursive: true });
  console.log(`  ${countFiles(embedDir)} 个文件`);

  step('把前端产物同步进 Go API（go:embed）');
  syncEmbeddedWeb({ root, dist: distDir });
  console.log('  internal/web/dist');

  step(`编译 Windows 启动器（${ARCH}）`);
  const launcherExe = path.join(stagingDir, 'PractacuPress.exe');
  run(
    go,
    ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', launcherExe, '.'],
    launcherDir,
    goEnv,
    'go build launcher',
  );
  requireFile(launcherExe, '启动器没有编译出来');
  console.log(`  PractacuPress.exe  ${formatSize(fs.statSync(launcherExe).size)}`);

  step(`编译 Go API（windows/${ARCH}）`);
  const apiExe = path.join(stagingDir, 'PractacuPressAPI.exe');
  run(
    go,
    ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', apiExe, './cmd/server'],
    root,
    goEnv,
    'go build api',
  );
  requireFile(apiExe, 'API 没有编译出来');
  console.log(`  PractacuPressAPI.exe  ${formatSize(fs.statSync(apiExe).size)}`);

  step('写入发布说明');
  writeReleaseReadme();
  fs.writeFileSync(path.join(stagingDir, 'VERSION'), `${RELEASE_VERSION || 'development'}\n`, 'utf8');

  if (options.skipSmoke || !NATIVE_ARCH) {
    console.log('\n注意：已跳过运行自检（--skip-smoke 或跨架构构建）。');
  } else {
    await smokeTest(stagingDir);
  }

  let zipResult = null;
  if (options.noZip) {
    console.log('\n--no-zip：跳过压缩。');
  } else {
    step('压缩分发包');
    zipResult = createZip(stagingDir);
    console.log(`  ${zipResult.path}  ${formatSize(zipResult.size)}`);
    fs.writeFileSync(`${zipResult.path}.sha256`, `${zipResult.sha256}  ${path.basename(zipResult.path)}\n`, 'utf8');
  }

  if (NATIVE_ARCH) {
    step('同步 release/PractacuPress（保留 data/ 与 practacu-web.json）');
    try {
      syncPackageDir();
    } catch (err) {
      throw new Error(
        `写入 ${hostPackageDir} 失败（${err.code || err.message}）。` +
          '如果旧版 PractacuPress.exe 正在运行，请先关闭它再重试；本次 zip 已经生成。',
      );
    }
    console.log(`  ${hostPackageDir}`);
  } else {
    console.log(`\n跨架构包只写 zip，不同步本机 release/PractacuPress。`);
  }

  if (!options.keepStaging) rmrf(stagingRoot);

  step('完成');
  console.log(`  架构       windows/${ARCH}`);
  if (NATIVE_ARCH) console.log(`  启动器     ${path.join(hostPackageDir, 'PractacuPress.exe')}`);
  if (NATIVE_ARCH) console.log(`  API        ${path.join(hostPackageDir, 'PractacuPressAPI.exe')}`);
  if (zipResult) {
    console.log(`  压缩包     ${zipResult.path}`);
    console.log(`  大小       ${formatSize(zipResult.size)}`);
    console.log(`  SHA256     ${zipResult.sha256}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
/* 参数与工具                                                          */
/* ------------------------------------------------------------------ */

function parseOptions(argv) {
  const parsed = {
    help: false,
    skipSmoke: false,
    skipWeb: false,
    noZip: false,
    keepStaging: false,
    releaseDir: '',
    arch: '',
    version: '',
    port: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--skip-smoke':
        parsed.skipSmoke = true;
        break;
      case '--skip-web':
        parsed.skipWeb = true;
        break;
      case '--no-zip':
        parsed.noZip = true;
        break;
      case '--keep-staging':
        parsed.keepStaging = true;
        break;
      case '--arch':
        parsed.arch = argv[++i] || '';
        if (!['amd64', 'arm64'].includes(parsed.arch)) {
          throw new Error('--arch 只能是 amd64 或 arm64。');
        }
        break;
      case '--version':
        parsed.version = argv[++i] || '';
        if (!parsed.version) throw new Error('--version 需要一个版本号。');
        break;
      case '--release-dir':
        parsed.releaseDir = argv[++i] || '';
        if (!parsed.releaseDir) throw new Error('--release-dir 需要一个目录参数。');
        break;
      case '--port': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('--port 需要一个 1–65535 的整数。');
        }
        parsed.port = value;
        break;
      }
      default:
        throw new Error(`不认识的参数：${arg}（用 --help 查看用法）`);
    }
  }
  if (parsed.releaseDir.startsWith('--')) throw new Error('--release-dir 需要一个目录参数。');
  return parsed;
}

function printHelp() {
  console.log(`Practacu Press · Windows 一键打包

用法：
  node scripts/package-windows.mjs [参数]

参数：
  --arch amd64|arm64   目标架构（默认当前 Node 架构）
  --version <tag>      发布版本（写入 VERSION 与 web/version.json）
  --skip-web           复用 web/dist
  --skip-smoke         跳过打包后的自检（跨架构构建会自动跳过）
  --no-zip             只生成 release/PractacuPress 目录
  --release-dir <目录> 输出目录（默认 <仓库>/release，也可用 PP_RELEASE_DIR）
  --port <端口>        自检固定端口（默认自动挑选空闲端口）
  --keep-staging       保留 release/.staging 中间目录
  --help               显示这段说明

产物：
  release/PractacuPress-Windows-<x64|arm64>.zip
  release/PractacuPress-Windows-<x64|arm64>.zip.sha256

更省事的方式：在仓库根目录双击 打包.bat（内部调用 scripts/package.ps1）。`);
}

function step(text) {
  process.stdout.write(`\n==> ${text}\n`);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// Vite 7 要求 Node ^20.19 或 >=22.12；一键包只支持当前 LTS 线，所以按 22.12 起。
function ensureNodeVersion(version) {
  const parts = String(version).split('.').map((value) => Number(value));
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const ok = major > 22 || (major === 22 && minor >= 12);
  if (!ok) {
    throw new Error(`Node.js 版本过低（${version}），前端构建需要 Node 22.12 或更高版本。`);
  }
}

function requireFile(file, message) {
  if (!fs.existsSync(file)) throw new Error(message);
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    console.warn(`  注意：清理 ${target} 失败（${err.code || err.message}），可稍后手动删除。`);
  }
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

function resolveGo() {
  const candidates = [
    'C:\\Program Files\\Go\\bin\\go.exe',
    'C:\\Program Files (x86)\\Go\\bin\\go.exe',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const found = spawnSync('where', ['go'], { encoding: 'utf8', env: baseEnv, windowsHide: true });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0].trim();
  throw new Error('没有找到 Go。请安装 Go 1.26+，并确保 go 在 PATH 里。');
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: baseEnv, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`无法执行 ${command} ${args.join(' ')}：${result.error ? result.error.message : '退出码 ' + result.status}`);
  }
  return String(result.stdout || '').trim();
}

function run(command, args, cwd, env, label) {
  console.log(`> ${label || command}`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`${label || command} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label || command} 失败（退出码 ${result.status}）。`);
}

function runShell(command, cwd, label) {
  console.log(`> ${label || command}`);
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd,
    env: baseEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label || command} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label || command} 失败（退出码 ${result.status}）。`);
}

function ensureWebDeps() {
  if (fs.existsSync(path.join(webDir, 'node_modules'))) return;
  console.log('  没有 web/node_modules，先安装前端依赖（首次打包需要联网）');
  if (fs.existsSync(path.join(webDir, 'package-lock.json'))) {
    runShell('npm ci --no-audit --no-fund', webDir, 'npm ci');
  } else {
    runShell('npm install --no-audit --no-fund', webDir, 'npm install');
  }
}

function stampWebVersion(dir) {
  if (!RELEASE_VERSION) return;
  const file = path.join(dir, 'version.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const beta = /-beta/i.test(RELEASE_VERSION);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        title: current.title || 'Practacu Press',
        describe:
          current.describe ||
          '自托管内容站点：文章、页面、主题与扩展都在你自己的机器上。',
        version: RELEASE_VERSION,
        style: beta ? 'beta' : 'stable',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function writeReleaseReadme() {
  const templatePath = path.join(root, 'scripts', 'release-readme.txt');
  if (!fs.existsSync(templatePath)) throw new Error(`缺少发布说明模板：${templatePath}`);
  const text = fs.readFileSync(templatePath, 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(stagingDir, 'README.txt'), `\ufeff${text}`, 'utf8');
  console.log('  README.txt');
}

/* ------------------------------------------------------------------ */
/* 压缩                                                                */
/* ------------------------------------------------------------------ */

function createZip(sourceDir) {
  const target = zipPath;
  const partial = `${target}.partial`;
  writeZip(partial, 'PractacuPress', sourceDir);
  let finalPath = target;
  try {
    fs.renameSync(partial, target);
  } catch (err) {
    const stamp = timestamp();
    const fallback = path.join(releaseDir, `PractacuPress-Windows-${ARCH_LABEL}-${stamp}.zip`);
    try {
      fs.renameSync(partial, fallback);
      finalPath = fallback;
    } catch {
      finalPath = partial;
    }
    console.log(`  注意：${target} 被占用（${err.code}），本次产物写到 ${finalPath}`);
  }
  const data = fs.readFileSync(finalPath);
  return {
    path: finalPath,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/* ---------- 最小 ZIP 写入器 ----------
 * 不用 Compress-Archive / .NET Framework ZipFile：它们可能把路径分隔符写成反斜杠，
 * 非 Windows 的解压工具会报错。这里统一用 /，并给文件名打 UTF-8 标记。
 */

function crc32(buffer) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const byte of buffer) c = crc32.table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const date = new Date(value);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function collectFiles(dir, prefix, output) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = fs.statSync(full);
    if (info.isDirectory()) collectFiles(full, `${prefix}${name}/`, output);
    else output.push({ name: `${prefix}${name}`, path: full, mtime: info.mtime });
  }
}

function writeZip(file, folder, sourceDir) {
  const files = [];
  collectFiles(sourceDir, `${folder}/`, files);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of files) {
    const data = fs.readFileSync(entry.path);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);
    const { time, dosDate } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuffer, payload);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(file, Buffer.concat([...localParts, central, end]));
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

function syncPackageDir() {
  fs.mkdirSync(hostPackageDir, { recursive: true });
  for (const name of fs.readdirSync(hostPackageDir)) {
    if (name === 'data' || name === 'practacu-web.json') continue;
    rmrf(path.join(hostPackageDir, name));
  }
  for (const name of fs.readdirSync(stagingDir)) {
    const source = path.join(stagingDir, name);
    const target = path.join(hostPackageDir, name);
    fs.cpSync(source, target, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

async function smokeTest(builtDir) {
  step('自检：启动打包产物，验证站点、API 与内容清洗');
  const smokeRoot = path.join(root, '.tmpbuild', 'smoke', `run-${Date.now()}`);
  const copyDir = path.join(smokeRoot, 'PractacuPress');
  fs.mkdirSync(smokeRoot, { recursive: true });
  fs.cpSync(builtDir, copyDir, { recursive: true });
  const dataDir = path.join(copyDir, 'data');
  if (options.port) {
    const available = await isPortFree(options.port);
    if (!available) {
      throw new Error(`自检端口 ${options.port} 已被占用；省略 --port 让脚本自动挑选空闲端口。`);
    }
  }
  const port = options.port || (await findFreePort());
  const exe = path.join(copyDir, 'PractacuPress.exe');
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(exe, ['--port', String(port), '--no-browser', '--mode', 'live'], {
    cwd: copyDir,
    env: { ...baseEnv },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  let exitText = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code, signal) => { exited = true; exitText = `code=${code} signal=${signal}`; });

  try {
    const runtime = await waitFor(async () => {
      if (exited) throw fatal(`启动器提前退出（${exitText}）：\n${tail(output)}`);
      const response = await httpJSON(`${base}/__pp/runtime`);
      return response && response.body && response.body.name === 'practacu-press' ? response.body : null;
    }, 120000, 400, '启动器 /__pp/runtime');

    check(runtime.dist_ready === true, '站点文件没有内嵌进启动器');
    check(runtime.runtime_mode === 'live', `运行方式应为 live，实际是 ${runtime.runtime_mode}`);
    check(runtime.api && runtime.api.managed === true, '本机 API 没有由启动器托管');
    check(runtime.api.ready === true, '本机 API 没有就绪');
    console.log('  ✓ /__pp/runtime：live，API 就绪');

    const index = await httpText(`${base}/`);
    check(index.status === 200, `首页返回 ${index.status}`);
    check(index.text.includes('<div id="root">'), '首页没有返回站点入口');
    const assetPath = (index.text.match(/\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0];
    check(assetPath, '首页没有引用 JS 构建产物');
    const asset = await httpText(`${base}${assetPath}`);
    check(asset.status === 200 && asset.text.length > 1000, `静态资源 ${assetPath} 不可用`);
    console.log(`  ✓ 首页与静态资源（${assetPath}）`);

    const spa = await httpText(`${base}/admin/theme`, { headers: { Accept: 'text/html' } });
    check(spa.status === 200 && spa.text.includes('<div id="root">'), 'SPA 路由没有回退到 index.html');
    console.log('  ✓ SPA 路由回退');

    const health = await httpJSON(`${base}/api/healthz`);
    check(health.status === 200 && health.body && health.body.status === 'ok', '/api/healthz 不正常');
    const ready = await httpJSON(`${base}/api/readyz`);
    check(ready.status === 200 && ready.body && ready.body.status === 'ready', '/api/readyz 不正常');
    console.log('  ✓ /api/healthz 与 /api/readyz');

    const email = `smoke+${Date.now()}@example.test`;
    const registered = await httpJSON(`${base}/api/v1/auth/register/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery', display_name: 'Smoke Test' }),
    });
    check(
      registered.status === 201 && registered.body && typeof registered.body.access_token === 'string',
      `注册失败（HTTP ${registered.status}）：${registered.text.slice(0, 300)}`,
    );
    const token = registered.body.access_token;
    console.log('  ✓ 真实环境注册');

    const draft = await httpJSON(`${base}/api/v1/articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'Smoke Test',
        source_body: '<h1>Hello</h1><script>alert(1)</script>',
      }),
    });

    check(draft.status === 201, `创建文章失败（HTTP ${draft.status}）：${draft.text.slice(0, 300)}`);
    const rendered = String((draft.body && draft.body.rendered_html) || '');
    check(/<h1[^>]*>\s*Hello\s*<\/h1>/i.test(rendered), 'Markdown/HTML 渲染不正确');
    check(!/<script/i.test(rendered), 'Go 安全清洗没有移除 <script>');
    console.log('  ✓ 文章创建 + Go 内容清洗');

      const published = await httpJSON(`${base}/api/v1/articles/${draft.body.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      check(
        published.status === 200 && published.body && published.body.status === 'published',
        `发布失败（HTTP ${published.status}）：${published.text.slice(0, 300)}`,
      );
      console.log('  ✓ 文章发布');

      const list = await httpJSON(`${base}/api/v1/articles?limit=5`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      check(
        list.status === 200 &&
          list.body &&
          Array.isArray(list.body.items) &&
          list.body.items.some((item) => item.id === draft.body.id),
        '文章列表里找不到刚发布的文章',
      );
      console.log('  ✓ 文章列表');

    check(fs.existsSync(path.join(dataDir, 'practacu.db')), '没有生成 data/practacu.db');
    console.log('  ✓ data/practacu.db 已生成');
    console.log('  自检通过。');
  } finally {
    await stopTree(child);
    rmrf(smokeRoot);
  }
}

function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function tail(text, lines = 15) {
  const parts = String(text).trim().split(/\r?\n/);
  return parts.slice(-lines).join('\n');
}

function check(condition, message) {
  if (!condition) throw new Error(`自检失败：${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(probe, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      if (err && err.fatal) throw err;
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const reason = lastError ? `：${lastError.message}` : '';
  throw new Error(`${label} 在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪${reason}`);
}

async function httpRequest(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'manual', ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, headers: response.headers, text, body };
  } finally {
    clearTimeout(timer);
  }
}

function httpJSON(url, init) {
  return httpRequest(url, init);
}

function httpText(url, init) {
  return httpRequest(url, init);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 进程可能已经退出。
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000),
  ]);
}
