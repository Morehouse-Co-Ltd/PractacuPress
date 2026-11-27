#!/usr/bin/env node
/**
 * Shared product-version helpers.
 *
 * `VERSION` in the repository root is the only place a release version is
 * edited. Everything else is either stamped from it at build time or generated
 * by `scripts/version.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const VERSION_PACKAGE = 'github.com/practacu/practacu-press/internal/version.Version';

const VERSION_RE = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta(?:[.-]?(\d+))?)?$/i;

/** Normalise a version into the form written to manifests and Go. */
export function normalizeVersion(raw) {
  const value = String(raw || '').trim();
  const match = value.match(VERSION_RE);
  if (!match) {
    throw new Error(`unsupported version: ${value || '(empty)'} (want X.Y.Z or X.Y.Z-beta[N])`);
  }
  const [, major, minor, patch, betaNumber] = match;
  const base = `${Number(major)}.${Number(minor)}.${Number(patch)}`;
  const beta = /-beta/i.test(value);
  const version = beta ? `${base}-beta${betaNumber ? Number(betaNumber) : ''}` : base;
  return {
    version,
    base,
    channel: beta ? 'beta' : 'stable',
    tag: `v${version}`,
  };
}

export function readProjectVersion(root) {
  const file = path.join(root, 'VERSION');
  if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(root, file)}`);
  return normalizeVersion(fs.readFileSync(file, 'utf8')).version;
}

/** Go linker flag that overrides the generated default in release builds. */
export function goVersionLdflags(version) {
  return `-s -w -X ${VERSION_PACKAGE}=${version}`;
}

/** First `info.version` value in an OpenAPI YAML document. */
export function readOpenAPIVersion(text) {
  const lines = String(text).split(/\r?\n/);
  let inInfo = false;
  for (const line of lines) {
    if (line === 'info:') {
      inInfo = true;
      continue;
    }
    if (!inInfo) continue;
    const match = line.match(/^\s{2}version:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (match) return match[1];
    if (/^\S/.test(line)) break;
  }
  throw new Error('openapi.yaml: info.version is missing');
}

/** Replace the first `info.version` line and leave the rest byte-for-byte alone. */
export function stampOpenAPIVersion(text, version) {
  const lines = String(text).split(/\r?\n/);
  let inInfo = false;
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === 'info:') {
      inInfo = true;
      continue;
    }
    if (!inInfo) continue;
    if (/^\s{2}version:\s*/.test(lines[i])) {
      lines[i] = `  version: ${version}`;
      replaced = true;
      break;
    }
    if (/^\S/.test(lines[i])) break;
  }
  if (!replaced) throw new Error('openapi.yaml: info.version is missing');
  return lines.join('\n');
}

/** Two root entries carry the package version in package-lock.json. */
export function readPackageLockVersions(text) {
  const versions = [];
  const pattern = /"version"\s*:\s*"([^"]+)"/g;
  let match;
  while (versions.length < 2 && (match = pattern.exec(text)) !== null) {
    versions.push(match[1]);
  }
  return versions;
}

export function replaceFirstVersions(text, version, count) {
  let remaining = count;
  return String(text).replace(/("version"\s*:\s*")[^"]+(")/g, (whole, before, after) => {
    if (remaining <= 0) return whole;
    remaining -= 1;
    return `${before}${version}${after}`;
  });
}
