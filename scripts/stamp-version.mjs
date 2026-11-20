#!/usr/bin/env node
/**
 * Stamp a release version into the built frontend manifest.
 *
 *   node scripts/stamp-version.mjs --dist web/dist --version v1.2.3
 *   node scripts/stamp-version.mjs --dist web/dist --version v1.2.4-beta1
 *   node scripts/stamp-version.mjs --dist web/dist --version 1.2.4-beta.2 --channel beta
 *
 * `web/public/version.json` is the single source of truth for the site version
 * (after a build it is served as `/version.json`). It carries exactly
 * `version` + `channel` + `version_code`; readers compute the channel/code from
 * the version when they are missing (see scripts/lib/version.mjs), but writes always use
 * the new shape.
 *
 * Parsing/normalisation lives in scripts/lib/version.mjs, the single Node
 * implementation of the scheme; this script never keeps a second regex.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseVersion } from './lib/version.mjs';

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
        console.log(
          'usage: stamp-version.mjs --dist <dir> --version <vX.Y.Z[-beta[.N]]> [--channel stable|beta]',
        );
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

try {
  const options = parseArgs(process.argv.slice(2));
  const parsed = parseVersion(options.version);
  if (!parsed) {
    throw new Error(`unsupported version: ${options.version} (want vX.Y.Z or vX.Y.Z-beta[.N])`);
  }
  // --channel may be passed explicitly, but it cannot contradict the version.
  if (options.channel && options.channel !== parsed.channel) {
    throw new Error(
      `--channel ${options.channel} conflicts with version ${parsed.version} (${parsed.channel})`,
    );
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
    version: parsed.version,
    channel: parsed.channel,
    version_code: parsed.code,
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`version.json -> ${parsed.version} (${parsed.channel}, ${parsed.code})`);
} catch (error) {
  console.error(`stamp-version: ${error.message}`);
  process.exit(1);
}
