#!/usr/bin/env node
/**
 * Stamp a release version into the built frontend manifest.
 *
 *   node scripts/stamp-version.mjs --dist web/dist --version v1.2.3
 *   node scripts/stamp-version.mjs --dist web/dist --version v1.2.4-beta1
 *
 * `web/public/version.json` is the source manifest used by the launcher's
 * "check for updates" screen and by the site footer. A release build must not keep
 * the repository's development version, otherwise every downloaded package claims
 * to be the same old build.
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = { dist: '', version: '', channel: '' };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--dist':
        options.dist = argv[++i] || '';
        break;
      case '--version':
        options.version = argv[++i] || '';
        break;
      case '--channel':
        options.channel = argv[++i] || '';
        break;
      case '--help':
      case '-h':
        console.log('usage: stamp-version.mjs --dist <dir> --version <vX.Y.Z[-betaN]> [--channel stable|beta]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!options.dist) throw new Error('--dist is required');
  if (!options.version) throw new Error('--version is required');
  return options;
}

function normalizeVersion(raw) {
  const match = String(raw).trim().match(/^v?(\d+\.\d+\.\d+)(?:-beta[.-]?(\d+))?$/i);
  if (!match) throw new Error(`unsupported version: ${raw} (want vX.Y.Z or vX.Y.Z-betaN)`);
  return {
    version: match[2] ? `${match[1]}-beta${Number(match[2])}` : match[1],
    channel: match[2] ? 'beta' : 'stable',
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const normalized = normalizeVersion(options.version);
  const channel = options.channel || normalized.channel;
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`unsupported channel: ${channel}`);
  }

  const file = path.join(path.resolve(options.dist), 'version.json');
  let manifest = {};
  if (fs.existsSync(file)) {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const next = {
    title: manifest.title || 'Practacu Press',
    describe:
      manifest.describe ||
      '自托管内容站点：文章、页面、主题与扩展都在你自己的机器上。',
    version: normalized.version,
    style: channel,
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`version.json -> ${normalized.version} (${channel})`);
} catch (error) {
  console.error(`stamp-version: ${error.message}`);
  process.exit(1);
}
