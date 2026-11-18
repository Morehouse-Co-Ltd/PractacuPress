import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy the built SPA into the Go embed directory before `go build`.
 *
 * Go's //go:embed cannot reference files outside its package, so the release
 * build materialises apps/web/dist under apps/api/internal/web/dist. The target
 * is gitignored except for .gitkeep; keeping the marker means a later
 * `git status` in a development tree does not show a deleted file.
 */
export function syncEmbeddedWeb({ root, dist }) {
  const source = path.resolve(dist);
  const index = path.join(source, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error(`前端产物不存在：${index}（先运行 npm run build）`);
  }

  const target = path.join(root, 'apps', 'api', 'internal', 'web', 'dist');
  const marker = path.join(target, '.gitkeep');
  // Preserve the committed marker byte-for-byte. Overwriting it would make the
  // tracked file show a diff after every package build even though dist/ files
  // themselves are ignored.
  const markerBody = fs.existsSync(marker) ? fs.readFileSync(marker) : Buffer.alloc(0);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
  fs.writeFileSync(marker, markerBody);
  return target;
}
