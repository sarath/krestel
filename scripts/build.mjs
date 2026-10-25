import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const xpiPath = path.join(rootDir, 'kestrel.xpi');

const args = new Set(process.argv.slice(2));
const isWatch = args.has('--watch');
const isServe = args.has('--serve');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(srcRel, destRel) {
  const src = path.join(rootDir, srcRel);
  const dest = path.join(distDir, destRel);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

export function resolveEsbuildBin() {
  const candidates = [
    path.join(
      rootDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
    ),
    path.join(rootDir, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    path.join(rootDir, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'esbuild';
}

// Precompute standard IEEE 802.3 CRC-32 table for ZIP archive creation
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFilesForXpi(baseDir, relItems) {
  const results = [];
  const walk = (relPath) => {
    const fullPath = path.join(baseDir, relPath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(fullPath).sort();
      for (const child of children) {
        walk(path.posix.join(relPath.replace(/\\/g, '/'), child));
      }
    } else if (stat.isFile()) {
      results.push({
        zipPath: relPath.replace(/\\/g, '/'),
        data: fs.readFileSync(fullPath),
      });
    }
  };
  for (const item of relItems) {
    walk(item);
  }
  return results;
}

/**
 * Pure Node.js cross-platform ZIP archive builder for `.xpi` packaging.
 * Guarantees forward-slash entry paths (`manifest.json` at root) required by Mozilla / Thunderbird Add-ons.
 */
function buildZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.zipPath, 'utf8');
    const rawData = entry.data;
    const uncompressedSize = rawData.length;
    const crc = crc32(rawData);
    const deflated = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const payload = useDeflate ? deflated : rawData;
    const method = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x554b, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(0x031e, 4); // version made by (Unix 3.0)
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x554b, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (-rw-r--r--)
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
const esbuildBin = resolveEsbuildBin();

const entries = [
  { in: 'src/background.ts', out: 'dist/background.js' },
  { in: 'src/popup/popup.ts', out: 'dist/popup/popup.js' },
  { in: 'src/options/options.ts', out: 'dist/options/options.js' },
  { in: 'src/dev/harness.ts', out: 'dist/dev/harness.js' },
];

export function runFullBuild(clean = true) {
  const started = Date.now();
  console.log('1/4 Running TypeScript strict typecheck (tsc --noEmit)...');
  execFileSync(process.execPath, [tscPath, '--noEmit'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (clean) {
    console.log('2/4 Cleaning and preparing dist/ directory...');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }
  ensureDir(distDir);
  ensureDir(path.join(distDir, 'popup'));
  ensureDir(path.join(distDir, 'options'));
  ensureDir(path.join(distDir, 'assets'));
  ensureDir(path.join(distDir, 'dev'));

  console.log('3/4 Bundling TypeScript entry points with esbuild...');
  for (const entry of entries) {
    execFileSync(
      esbuildBin,
      [
        path.join(rootDir, entry.in),
        '--bundle',
        '--format=iife',
        '--target=firefox115',
        '--charset=utf8',
        `--outfile=${path.join(rootDir, entry.out)}`,
      ],
      { cwd: rootDir, stdio: 'inherit' }
    );
  }

  console.log('4/4 Copying static manifest, HTML, CSS, SVG, and Dev Harness...');
  copyFile('manifest.json', 'manifest.json');
  copyFile('assets/icon.svg', 'assets/icon.svg');
  copyFile('src/popup/popup.html', 'popup/popup.html');
  copyFile('src/popup/popup.css', 'popup/popup.css');
  copyFile('src/options/options.html', 'options/options.html');
  copyFile('src/options/options.css', 'options/options.css');
  copyFile('src/dev/harness.html', 'dev/harness.html');
  copyFile('src/dev/harness.css', 'dev/harness.css');

  // Package dist/ into kestrel.xpi using cross-platform Node ZIP builder
  const xpiFiles = collectFilesForXpi(distDir, [
    'manifest.json',
    'background.js',
    'assets',
    'popup',
    'options',
  ]);
  const zipBuffer = buildZipArchive(xpiFiles);
  
  // Write atomically with retry in case Thunderbird or Windows file indexer holds a temporary read handle
  const tmpXpi = `${xpiPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpXpi, zipBuffer);
  let replaced = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (fs.existsSync(xpiPath)) {
        fs.unlinkSync(xpiPath);
      }
      fs.renameSync(tmpXpi, xpiPath);
      replaced = true;
      break;
    } catch {
      const waitTill = Date.now() + 80;
      while (Date.now() < waitTill) {}
    }
  }
  if (!replaced) {
    try {
      fs.writeFileSync(xpiPath, zipBuffer);
    } finally {
      if (fs.existsSync(tmpXpi)) fs.unlinkSync(tmpXpi);
    }
  }

  const elapsed = Date.now() - started;
  console.log(`\n✓ Build complete in ${elapsed}ms!`);
  console.log(`  • Unpacked extension: ${distDir}`);
  console.log(
    `  • Installable XPI:    ${xpiPath} (${(zipBuffer.length / 1024).toFixed(1)} KB ZIP, ${xpiFiles.length} files)`
  );
  console.log(
    `  • Dev Harness File:   ${path.join(distDir, 'dev', 'harness.html')}`
  );
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runFullBuild(true);

  if (isServe) {
    const port = Number(process.env.PORT || 4173);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    };

    const server = http.createServer((req, res) => {
      const rawUrl = (req.url || '/').split('?')[0];
      const relPath = rawUrl === '/' ? '/dev/harness.html' : rawUrl;
      const safePath = path.normalize(path.join(distDir, relPath));
      if (
        !safePath.startsWith(distDir) ||
        !fs.existsSync(safePath) ||
        fs.statSync(safePath).isDirectory()
      ) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(safePath));
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(
        `\n🚀 Kestrel Dev Harness running at: http://localhost:${port}/dev/harness.html`
      );
    });
  }

  if (isWatch) {
    console.log(
      '\n👀 Watching src/ and manifest.json for changes (auto-rebuilds dist/ & kestrel.xpi)...'
    );
    let debounceTimer = null;
    const triggerRebuild = (filename) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(
          `\n🔄 Change detected (${filename || 'file'}) — rebuilding...`
        );
        try {
          runFullBuild(false);
        } catch (err) {
          console.error('✗ Rebuild failed:', err?.message || err);
        }
      }, 150);
    };

    fs.watch(path.join(rootDir, 'src'), { recursive: true }, (_evt, file) =>
      triggerRebuild(file)
    );
    fs.watch(path.join(rootDir, 'manifest.json'), (_evt, file) =>
      triggerRebuild(file)
    );
  }
}
