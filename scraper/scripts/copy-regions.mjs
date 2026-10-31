/**
 * Copy the region polygons into `dist/`.
 *
 * `tsc` emits JavaScript and nothing else, so the checked-in `*.json` under
 * `src/ranking/regions/` would be absent from the Lambda bundle - and the
 * loader treats a missing directory as "no polygons drawn yet", which is a
 * *valid* state. So forgetting this step would not fail the build or the
 * deploy: production would simply refit with every scene null, which looks
 * exactly like a map nobody has drawn. Hence a build step rather than a note.
 *
 * `resolveJsonModule` plus a static import was the alternative. It was declined
 * because it would require naming each continent file in code, and the point of
 * a directory is that a drawing pass can add `oceania.json` without a code
 * change.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'ranking', 'regions');
const to = join(root, 'dist', 'ranking', 'regions');

let names = [];
try {
  names = (await readdir(from)).filter(name => name.endsWith('.json'));
} catch {
  // No regions directory at all. Nothing to copy, and the loader says so.
}

await mkdir(to, { recursive: true });
for (const name of names) await cp(join(from, name), join(to, name));
console.log(`[build] copied ${names.length} region file(s) into dist/ranking/regions`);
