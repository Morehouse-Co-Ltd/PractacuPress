import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-version.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [script, '--json', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('stable release message', () => {
  const result = run(['--message', 'feat: prepare V1.2.3 for release']);
  assert.equal(result.should_release, true);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.tag, 'v1.2.3');
  assert.equal(result.prerelease, false);
  assert.equal(result.channel, 'stable');
  assert.equal(result.pkg_release, '1');
});

test('beta release message', () => {
  const result = run(['--message', 'release: v1.0.1-beta1']);
  assert.equal(result.version, '1.0.1-beta1');
  assert.equal(result.tag, 'v1.0.1-beta1');
  assert.equal(result.prerelease, true);
  assert.equal(result.channel, 'beta');
  assert.equal(result.pkg_release, 'beta1');
});

test('beta without a number is valid', () => {
  const result = run(['--message', 'release: v0.1.2-beta']);
  assert.equal(result.version, '0.1.2-beta');
  assert.equal(result.tag, 'v0.1.2-beta');
  assert.equal(result.prerelease, true);
  assert.equal(result.channel, 'beta');
  assert.equal(result.pkg_release, 'beta');
});

test('beta with a dot separator is normalised', () => {
  const result = run(['--message', 'chore: V2.0.0-Beta.2']);
  assert.equal(result.version, '2.0.0-beta2');
  assert.equal(result.tag, 'v2.0.0-beta2');
});

test('tag ref wins when the message has no version', () => {
  const result = run(['--ref', 'refs/tags/v3.4.5', '--message', 'no version here']);
  assert.equal(result.should_release, true);
  assert.equal(result.version, '3.4.5');
});

test('explicit input is validated instead of ignored', () => {
  const result = run(['--input', 'V9.8.7-beta3']);
  assert.equal(result.version, '9.8.7-beta3');

  const bad = spawnSync(process.execPath, [script, '--input', 'not-a-version', '--json'], {
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);
});

test('a message without a version releases nothing', () => {
  const result = run(['--message', 'fix: no release marker']);
  assert.equal(result.should_release, false);
});

test('a longer number is not a version', () => {
  assert.equal(run(['--message', 'build v1.2.3.4']).should_release, false);
  assert.equal(run(['--message', 'sha 1v1.2.3']).should_release, false);
});
