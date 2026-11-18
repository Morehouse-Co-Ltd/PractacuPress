#!/usr/bin/env node
/**
 * Copy apps/web/dist into apps/api/internal/web/dist so a plain `go build`
 * includes the SPA. Release/package scripts call the same helper automatically.
 *
 *   node scripts/sync-web-embed.mjs
 *   node scripts/sync-web-embed.mjs --dist path/to/dist
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncEmbeddedWeb } from './lib/embed-web.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--dist');
const dist = index >= 0 ? process.argv[index + 1] : path.join(root, 'apps', 'web', 'dist');

try {
  const target = syncEmbeddedWeb({ root, dist });
  console.log(`embedded web: ${path.relative(root, target)}`);
} catch (error) {
  console.error(`sync-web-embed: ${error.message}`);
  process.exit(1);
}
