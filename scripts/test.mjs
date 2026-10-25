import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEsbuildBin } from './build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const esbuildBin = resolveEsbuildBin();

const tmpOut = path.join(
  os.tmpdir(),
  `kestrel-classifier-test-${process.pid}.mjs`
);

try {
  execFileSync(
    esbuildBin,
    [
      path.join(rootDir, 'tests', 'classifier.test.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${tmpOut}`,
    ],
    { cwd: rootDir, stdio: 'inherit' }
  );

  execFileSync(process.execPath, ['--test', tmpOut], {
    cwd: rootDir,
    stdio: 'inherit',
  });
} finally {
  if (fs.existsSync(tmpOut)) {
    fs.rmSync(tmpOut, { force: true });
  }
}
