import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(
  await readFile(path.join(root, 'manifest.json'), 'utf8'),
);
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Invalid manifest version.');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const filename = `paperless-upload-${version}.zip`;
const destination = path.join(root, 'artifacts', filename);
await rm(destination, { force: true });
const result =
  process.platform === 'win32'
    ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $PWD 'dist'), (Join-Path $PWD 'artifacts\\${filename}'))`,
        ],
        { cwd: root, stdio: 'inherit' },
      )
    : spawnSync(
        'zip',
        ['-q', '-r', path.join('..', 'artifacts', filename), '.'],
        { cwd: path.join(root, 'dist'), stdio: 'inherit' },
      );
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if ((await stat(destination)).size === 0)
  throw new Error('The package is empty.');
console.log(`Created artifacts/${filename}`);
