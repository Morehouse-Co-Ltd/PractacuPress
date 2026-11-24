#!/usr/bin/env node
/**
 * Extract one release version from a push message (or an explicit input/tag).
 *
 *   node scripts/release-version.mjs --message "feat: cut v1.2.0"
 *   node scripts/release-version.mjs --input V1.2.0-beta1 --json
 *   node scripts/release-version.mjs --github-output "$GITHUB_OUTPUT" --ref refs/tags/v1.2.0
 *
 * Accepted forms (case-insensitive `v`, optional beta suffix):
 *   v1.0.0   V1.0.0   v1.0.1-beta   v1.0.1-beta1   V1.0.1-beta.1
 *
 * The tag is canonicalised to a lower-case `v` prefix because Docker tags and
 * GitHub release names are usually matched literally, and a mixed-case tag would
 * make `v1.0.0` and `V1.0.0` two different releases.
 */
import fs from 'node:fs';

const VERSION_RE =
  /(?<![0-9A-Za-z])v(\d+)\.(\d+)\.(\d+)(?:-beta(?:[.-]?(\d+))?)?(?![-.0-9A-Za-z])/i;

function parseVersion(raw) {
  const match = String(raw || '').match(VERSION_RE);
  if (!match) return null;
  const [, major, minor, patch, betaNumber] = match;
  const base = `${Number(major)}.${Number(minor)}.${Number(patch)}`;
  const beta = /-beta/i.test(match[0]);
  const suffix = beta ? `-beta${betaNumber ? Number(betaNumber) : ''}` : '';
  return {
    should_release: true,
    version: `${base}${suffix}`,
    base_version: base,
    tag: `v${base}${suffix}`,
    prerelease: beta,
    channel: beta ? 'beta' : 'stable',
    pkg_release: beta ? `beta${betaNumber ? Number(betaNumber) : ''}` : '1',
  };
}

function readOptions(argv) {
  const options = { message: '', input: '', ref: '', json: false, githubOutput: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--message':
        options.message = argv[++i] || '';
        break;
      case '--input':
        options.input = argv[++i] || '';
        break;
      case '--ref':
        options.ref = argv[++i] || '';
        break;
      case '--github-output':
        options.githubOutput = argv[++i] || '';
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        console.log('usage: release-version.mjs [--message TEXT] [--input VERSION] [--ref REF] [--json] [--github-output FILE]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolve(options) {
  const explicit = String(options.input || '').trim();
  if (explicit) {
    const parsed = parseVersion(explicit);
    if (!parsed) throw new Error(`--input is not a supported version: ${explicit}`);
    return parsed;
  }

  const tag = String(options.ref || '').match(/^refs\/tags\/(.+)$/);
  if (tag) {
    const parsed = parseVersion(tag[1]);
    if (parsed) return parsed;
  }

  const parsed = parseVersion(options.message);
  return parsed || { should_release: false };
}

function writeGithubOutput(file, result) {
  const lines = Object.entries(result)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
  fs.appendFileSync(file, `${lines}\n`, 'utf8');
}

try {
  const options = readOptions(process.argv.slice(2));
  const result = resolve(options);
  if (!result.should_release) {
    result.version = '';
    result.base_version = '';
    result.tag = '';
    result.prerelease = false;
    result.channel = '';
    result.pkg_release = '';
  }
  if (options.githubOutput) {
    writeGithubOutput(options.githubOutput, result);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.githubOutput) {
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(`release-version: ${error.message}`);
  process.exit(1);
}
