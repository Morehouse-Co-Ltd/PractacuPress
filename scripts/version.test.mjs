import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeVersion } from './lib/project-version.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return result;
}

function fixture(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-version-'));
  fs.mkdirSync(path.join(root, 'internal', 'version'), { recursive: true });
  fs.mkdirSync(path.join(root, 'internal', 'packages', 'contracts', 'openapi'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web', 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  fs.writeFileSync(
    path.join(root, 'internal', 'version', 'version.go'),
    `package version\n\nvar Version = "${version}"\n`,
  );
  fs.writeFileSync(
    path.join(root, 'web', 'package.json'),
    `${JSON.stringify({ name: 'fixture', version }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'web', 'package-lock.json'),
    `${JSON.stringify({ name: 'fixture', version, lockfileVersion: 3, packages: { '': { version } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'web', 'public', 'version.json'),
    `${JSON.stringify({ title: 'Fixture', version, style: 'stable' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'internal', 'packages', 'contracts', 'openapi', 'openapi.yaml'),
    `openapi: 3.1.0\ninfo:\n  title: Fixture API\n  version: ${version}\n  description: |\n    fixture\nservers:\n  - url: /api/v1\n`,
  );
  return root;
}

test('normalizes stable and beta versions', () => {
  assert.deepEqual(normalizeVersion('v1.2.3'), {
    version: '1.2.3',
    base: '1.2.3',
    channel: 'stable',
    tag: 'v1.2.3',
  });
  assert.deepEqual(normalizeVersion('V2.0.0-Beta.2'), {
    version: '2.0.0-beta2',
    base: '2.0.0',
    channel: 'beta',
    tag: 'v2.0.0-beta2',
  });
  assert.throws(() => normalizeVersion('1.2'), /unsupported version/);
});

test('set synchronizes every declaration and check detects drift', () => {
  const root = fixture('1.0.0');
  const set = run(['set', '2.1.0-beta1', '--root', root]);
  assert.equal(set.status, 0, set.stderr);

  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(), '2.1.0-beta1');
  assert.match(fs.readFileSync(path.join(root, 'internal', 'version', 'version.go'), 'utf8'), /2\.1\.0-beta1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'web', 'public', 'version.json'), 'utf8')).style, 'beta');

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'web', 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '2.1.0-beta1');
  assert.equal(lock.packages[''].version, '2.1.0-beta1');

  const yaml = fs.readFileSync(
    path.join(root, 'internal', 'packages', 'contracts', 'openapi', 'openapi.yaml'),
    'utf8',
  );
  assert.match(yaml, /info:\n  title: Fixture API\n  version: 2\.1\.0-beta1\n/);

  assert.equal(run(['check', '--root', root]).status, 0);

  const packageFile = path.join(root, 'web', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  packageJson.version = '9.9.9';
  fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  const check = run(['check', '--root', root]);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /web\/package\.json=9\.9\.9/);
});
