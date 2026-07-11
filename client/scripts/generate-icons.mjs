import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const source = join(publicDir, 'icon-source.png');
const outputs = [
  { file: 'icon-32.png', size: 32 },
  { file: 'icon-180.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon.png', size: 512 },
];

if (!existsSync(source)) {
  console.error('icon-source.png not found in client/public');
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('Install sharp to regenerate icons: npm install -D sharp -w client');
  process.exit(1);
}

const sourceMtime = statSync(source).mtimeMs;
const srcBuf = readFileSync(source);

for (const { file, size } of outputs) {
  const out = join(publicDir, file);
  const stale = !existsSync(out) || statSync(out).mtimeMs < sourceMtime;
  if (!stale) {
    console.log(`${file} up to date`);
    continue;
  }
  await sharp(srcBuf).resize(size, size).png().toFile(out);
  console.log(file);
}
