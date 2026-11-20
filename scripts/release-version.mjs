#!/usr/bin/env node
/**
 * Extract one release version from a push message (or an explicit input/tag).
 *
 *   node scripts/release-version.mjs --message "feat: cut v1.2.0"
 *   node scripts/release-version.mjs --input V1.2.0-beta1 --json
 *   node scripts/release-version.mjs --github-output "$GITHUB_OUTPUT" --ref refs/tags/v1.2.0
 *
 * Accepted forms (a leading v/V is optional):
 *   v1.0.0   V1.0.0   v1.0.1-beta   v1.0.1-beta1   v1.0.1-beta.1   v1.0.1-beta.01
 *
 * Everything is normalised with scripts/lib/version.mjs — the single Node
 * implementation of the scheme shared with internal/version and
 * web/src/lib/version.ts. A bare `-beta` is beta 1, so `-beta1` prints as
 * `-beta` and `-beta.02` prints as `-beta.2`; the tag keeps a leading lower-case
 * `v` because Docker tags and GitHub release names are matched literally.
 *
 * Output fields:
 *   should_release  true when a version was found (otherwise every field is empty)
 *   version         canonical version without the v prefix, e.g. 0.1.2-beta.2
 *   base_version    MAJOR.MINOR.PATCH only, e.g. 0.1.2 (nfpm `version`)
 *   tag             canonical tag with the v prefix, e.g. v0.1.2-beta.2
 *   prerelease      true for betas (GitHub release flag)
 *   channel         stable | beta
 *   version_code    integer form used by the updater, e.g. 10202
 *   pkg_release     nfpm `release`: 1 for stable, betaN for betas
 */
import fs from 'node:fs';
import { findVersion, parseVersion } from './lib/version.mjs';

const VERSION_HINT = 'want X.Y.Z or X.Y.Z-beta[.N] (e.g. v1.0.1-beta2)';

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
        console.log(
          'usage: release-version.mjs [--message TEXT] [--input VERSION] [--ref REF] [--json] [--github-output FILE]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Turn a parsed version into the job-output shape. */
function releaseFields(parsed) {
  const betaIndex = parsed.version.indexOf('-beta');
  const baseVersion = betaIndex === -1 ? parsed.version : parsed.version.slice(0, betaIndex);
  return {
    should_release: true,
    version: parsed.version,
    base_version: baseVersion,
    tag: parsed.tag,
    prerelease: parsed.prerelease,
    channel: parsed.channel,
    version_code: parsed.code,
    // version_code 的低两位就是 STAGE；测试版即序号 N，稳定版固定 release=1。
    pkg_release: parsed.channel === 'beta' ? `beta${parsed.code % 100}` : '1',
  };
}

function noReleaseFields() {
  return {
    should_release: false,
    version: '',
    base_version: '',
    tag: '',
    prerelease: false,
    channel: '',
    version_code: '',
    pkg_release: '',
  };
}

function resolve(options) {
  // An explicit --input is authoritative and must be valid instead of ignored.
  const explicit = String(options.input || '').trim();
  if (explicit) {
    const parsed = parseVersion(explicit);
    if (!parsed) throw new Error(`--input is not a supported version: ${explicit} (${VERSION_HINT})`);
    return parsed;
  }

  // A pushed version tag wins when the commit message has no version.
  const ref = String(options.ref || '');
  if (ref.startsWith('refs/tags/')) {
    const parsed = parseVersion(ref.slice('refs/tags/'.length));
    if (parsed) return parsed;
  }

  // Otherwise look for a v-prefixed version anywhere in the commit message.
  return findVersion(options.message);
}

function writeGithubOutput(file, result) {
  const lines = Object.entries(result)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
  fs.appendFileSync(file, `${lines}\n`, 'utf8');
}

try {
  const options = readOptions(process.argv.slice(2));
  const parsed = resolve(options);
  const result = parsed ? releaseFields(parsed) : noReleaseFields();
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
