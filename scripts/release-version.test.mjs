import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareVersions, findVersion, parseVersion, versionCodeOf } from './lib/version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'release-version.mjs');
const stampScript = path.join(here, 'stamp-version.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [script, '--json', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runRaw(args) {
  return spawnSync(process.execPath, [script, '--json', ...args], { encoding: 'utf8' });
}

/* ------------------------------------------------------------------ */
/* release-version.mjs：从消息 / tag / --input 解析                     */
/* ------------------------------------------------------------------ */

test('stable release message', () => {
  const result = run(['--message', 'feat: prepare V1.2.3 for release']);
  assert.equal(result.should_release, true);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.base_version, '1.2.3');
  assert.equal(result.tag, 'v1.2.3');
  assert.equal(result.prerelease, false);
  assert.equal(result.channel, 'stable');
  assert.equal(result.version_code, 1020399);
  assert.equal(result.pkg_release, '1');
});

test('beta release message is normalised', () => {
  const result = run(['--message', 'release: v1.0.1-beta1']);
  assert.equal(result.version, '1.0.1-beta');
  assert.equal(result.base_version, '1.0.1');
  assert.equal(result.tag, 'v1.0.1-beta');
  assert.equal(result.prerelease, true);
  assert.equal(result.channel, 'beta');
  assert.equal(result.version_code, 1000101);
  assert.equal(result.pkg_release, 'beta1');
});

test('beta with a dot separator is normalised', () => {
  const result = run(['--message', 'chore: V2.0.0-beta.2']);
  assert.equal(result.version, '2.0.0-beta.2');
  assert.equal(result.tag, 'v2.0.0-beta.2');
  assert.equal(result.prerelease, true);
  assert.equal(result.version_code, 2000002);
  assert.equal(result.pkg_release, 'beta2');
});

test('v0.1.1-beta (bare beta) is beta 1', () => {
  const result = run(['--input', 'v0.1.1-beta']);
  assert.equal(result.version, '0.1.1-beta');
  assert.equal(result.tag, 'v0.1.1-beta');
  assert.equal(result.channel, 'beta');
  assert.equal(result.prerelease, true);
  assert.equal(result.version_code, 10101);
  assert.equal(result.pkg_release, 'beta1');
});

test('v1.0.1-beta2 → canonical -beta.2 tag', () => {
  const result = run(['--input', 'v1.0.1-beta2']);
  assert.equal(result.version, '1.0.1-beta.2');
  assert.equal(result.base_version, '1.0.1');
  assert.equal(result.tag, 'v1.0.1-beta.2');
  assert.equal(result.channel, 'beta');
  assert.equal(result.prerelease, true);
  assert.equal(result.version_code, 1000102);
  assert.equal(result.pkg_release, 'beta2');
});

test('every accepted beta spelling normalises to the same version', () => {
  for (const spelling of ['0.1.2-beta', 'v0.1.2-beta1', 'V0.1.2-beta.1', 'v0.1.2-beta.01']) {
    const result = run(['--input', spelling]);
    assert.equal(result.version, '0.1.2-beta', spelling);
    assert.equal(result.tag, 'v0.1.2-beta', spelling);
    assert.equal(result.version_code, 10201, spelling);
  }
  const second = run(['--input', 'v0.1.2-beta.02']);
  assert.equal(second.version, '0.1.2-beta.2');
  assert.equal(second.tag, 'v0.1.2-beta.2');
  assert.equal(second.version_code, 10202);
});

test('tag ref wins when the message has no version', () => {
  const result = run(['--ref', 'refs/tags/v3.4.5', '--message', 'no version here']);
  assert.equal(result.should_release, true);
  assert.equal(result.version, '3.4.5');
  assert.equal(result.tag, 'v3.4.5');
  assert.equal(result.version_code, 3040599);
});

test('explicit input is validated instead of ignored', () => {
  const result = run(['--input', 'V9.8.7-beta3']);
  assert.equal(result.version, '9.8.7-beta.3');
  assert.equal(result.version_code, 9080703);

  const bad = runRaw(['--input', 'not-a-version']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--input is not a supported version/);
});

test('invalid inputs are rejected (strict parity with Go/TS)', () => {
  for (const input of [
    'not-a-version',
    '1.2',
    '1.2.3.4',
    '1.2.3-rc1',
    '1.2.3-alpha',
    '1.2.3-beta.99',
    '1.2.3-beta.0',
    '1.2.100',
    '1.2.3+build',
    '1.2.3-BETA1',
  ]) {
    const result = runRaw(['--input', input]);
    assert.notEqual(result.status, 0, `${input} should be rejected`);
  }
});

test('a message without a version releases nothing', () => {
  const result = run(['--message', 'fix: no release marker']);
  assert.equal(result.should_release, false);
  assert.equal(result.version, '');
  assert.equal(result.tag, '');
  assert.equal(result.version_code, '');
  assert.equal(result.prerelease, false);
});

test('a version must be v-prefixed and complete inside a message', () => {
  assert.equal(run(['--message', 'build v1.2.3.4']).should_release, false);
  assert.equal(run(['--message', 'sha 1v1.2.3']).should_release, false);
  // 裸数字（例如 bump Node 22.12.3）不能触发发布。
  assert.equal(run(['--message', 'upgrade node 22.12.3']).should_release, false);
  // 大小写必须与 Go/TS 一致：-BETA 不是合法后缀。
  assert.equal(run(['--message', 'chore: V2.0.0-Beta.2']).should_release, false);
});

test('--github-output writes every field consumed by the release workflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  try {
    const file = path.join(dir, 'github-output');
    run(['--input', 'v1.0.1-beta2', '--github-output', file]);
    const output = fs.readFileSync(file, 'utf8');
    for (const line of [
      'should_release=true',
      'version=1.0.1-beta.2',
      'base_version=1.0.1',
      'tag=v1.0.1-beta.2',
      'prerelease=true',
      'channel=beta',
      'version_code=1000102',
      'pkg_release=beta2',
    ]) {
      assert.match(output, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* scripts/lib/version.mjs：唯一实现的表驱动检查                         */
/* ------------------------------------------------------------------ */

test('parseVersion follows the documented version_code formula', () => {
  const cases = [
    // raw, version, channel, code, prerelease, tag
    ['1.2.3', '1.2.3', 'stable', 1020399, false, 'v1.2.3'],
    ['0.1.2', '0.1.2', 'stable', 10299, false, 'v0.1.2'],
    ['V1.0.0', '1.0.0', 'stable', 1000099, false, 'v1.0.0'],
    ['v0.1.2-beta', '0.1.2-beta', 'beta', 10201, true, 'v0.1.2-beta'],
    ['0.1.2-beta.2', '0.1.2-beta.2', 'beta', 10202, true, 'v0.1.2-beta.2'],
    ['0.1.2-beta.02', '0.1.2-beta.2', 'beta', 10202, true, 'v0.1.2-beta.2'],
    ['0.1.2-beta.98', '0.1.2-beta.98', 'beta', 10298, true, 'v0.1.2-beta.98'],
    ['0.2.0-beta', '0.2.0-beta', 'beta', 20001, true, 'v0.2.0-beta'],
    ['0.1.99', '0.1.99', 'stable', 19999, false, 'v0.1.99'],
    ['1.0.1-beta2', '1.0.1-beta.2', 'beta', 1000102, true, 'v1.0.1-beta.2'],
    ['1.0.1-beta.1', '1.0.1-beta', 'beta', 1000101, true, 'v1.0.1-beta'],
    [' 0.1.2-beta1 ', '0.1.2-beta', 'beta', 10201, true, 'v0.1.2-beta'],
  ];
  for (const [raw, version, channel, code, prerelease, tag] of cases) {
    assert.deepEqual(parseVersion(raw), { version, channel, code, prerelease, tag }, raw);
  }
  for (const raw of [
    '',
    '1.2',
    '1.2.3.4',
    '1.2.3-rc1',
    '1.2.3-alpha',
    '1.2.3+build',
    '1.2.3-beta.0',
    '1.2.3-beta.99',
    '1.2.3-beta.x',
    '1.2.3-beta1.2',
    '1.2.100',
    '1.100.0',
    'x1.2.3',
    '1.2.3-BETA1',
    null,
    undefined,
  ]) {
    assert.equal(parseVersion(raw), null, String(raw));
  }
});

test('versionCodeOf and compareVersions only use version_code', () => {
  assert.equal(versionCodeOf('0.1.2-beta'), 10201);
  assert.equal(versionCodeOf('0.1.2'), 10299);
  assert.equal(versionCodeOf('not-a-version'), 0);

  assert.equal(compareVersions('0.1.2', '0.1.2-beta.2'), 1, 'stable beats beta');
  assert.equal(compareVersions('0.1.2-beta.2', '0.1.2-beta'), 1);
  assert.equal(compareVersions('0.1.2-beta1', '0.1.2-beta.1'), 0, 'same version_code');
  assert.equal(compareVersions('0.2.0-beta', '0.1.2'), 1);
  assert.equal(compareVersions('bad', '0.1.2'), 0, 'invalid compares as 0');
});

test('findVersion only accepts v-prefixed versions in free text', () => {
  assert.equal(findVersion('release: v1.0.1-beta1')?.version, '1.0.1-beta');
  assert.equal(findVersion('upgrade node 22.12.3'), null);
  assert.equal(findVersion('v1.2.3.4'), null);
  assert.equal(findVersion('sha 1v1.2.3'), null);
});

/* ------------------------------------------------------------------ */
/* stamp-version.mjs：清单只写 version/channel/version_code              */
/* ------------------------------------------------------------------ */

test('stamp-version writes the three-field manifest and drops style', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-version-'));
  try {
    const file = path.join(dir, 'version.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ title: 'Practacu Press', describe: '说明', version: '0.1.0', style: 'stable' }),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      [stampScript, '--dist', dir, '--version', 'v1.0.1-beta2'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      title: 'Practacu Press',
      describe: '说明',
      version: '1.0.1-beta.2',
      channel: 'beta',
      version_code: 1000102,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp-version accepts a matching --channel but rejects a conflicting one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-version-'));
  try {
    const ok = spawnSync(
      process.execPath,
      [stampScript, '--dist', dir, '--version', 'v1.0.1-beta', '--channel', 'beta'],
      { encoding: 'utf8' },
    );
    assert.equal(ok.status, 0, ok.stderr);

    const bad = spawnSync(
      process.execPath,
      [stampScript, '--dist', dir, '--version', 'v1.0.1-beta', '--channel', 'stable'],
      { encoding: 'utf8' },
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /conflicts with version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
