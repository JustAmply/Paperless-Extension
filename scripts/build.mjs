import { cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await rm(path.join(root, '.build'), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', '.build'],
  { cwd: root, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

// Compile before replacing the distribution so type errors preserve the last usable build.
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await rename(path.join(root, '.build'), dist);
for (const name of ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, name), path.join(dist, name));
}
for (const name of await readdir(path.join(root, 'src'))) {
  if (/\.(html|css)$/.test(name))
    await cp(path.join(root, 'src', name), path.join(dist, name));
}
await rm(path.join(dist, 'assets'), { recursive: true, force: true });
await mkdir(path.join(dist, 'assets'), { recursive: true });
for (const name of await readdir(path.join(root, 'assets'))) {
  if (name !== 'icon-source.png')
    await cp(path.join(root, 'assets', name), path.join(dist, 'assets', name));
}
const manifest = JSON.parse(
  await readFile(path.join(dist, 'manifest.json'), 'utf8'),
);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version)
  throw new Error('Package and manifest versions must match.');
for (const icon of Object.values(manifest.icons))
  await readFile(path.join(dist, icon));
console.log(`Built Paperless Upload ${manifest.version} in dist/`);
