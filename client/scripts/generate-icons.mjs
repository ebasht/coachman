import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(rootDir, 'public');
const source = join(rootDir, 'brand', 'icon-source.png');
const outputs = [
  { file: 'app-icon-32.png', size: 32 },
  { file: 'app-icon-180.png', size: 180 },
  { file: 'app-icon-192.png', size: 192 },
  { file: 'app-icon-512.png', size: 512 },
];

const missingOutputs = outputs.filter(({ file }) => !existsSync(join(publicDir, file)));
const sourceExists = existsSync(source);
const sourceMtime = sourceExists ? statSync(source).mtimeMs : 0;
const staleOutputs = sourceExists
  ? outputs.filter(({ file }) => {
      const out = join(publicDir, file);
      return existsSync(out) && statSync(out).mtimeMs < sourceMtime;
    })
  : [];

const needsRegen = missingOutputs.length > 0 || staleOutputs.length > 0;

if (!needsRegen) {
  console.log('icons up to date');
  process.exit(0);
}

if (!sourceExists) {
  console.error('brand/icon-source.png not found and some icons are missing:');
  for (const { file } of missingOutputs) console.error(`  ${file}`);
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (err) {
  if (missingOutputs.length === 0) {
    console.warn('sharp unavailable; keeping committed icons');
    console.warn(String(err?.message || err));
    process.exit(0);
  }
  console.error('Install sharp to generate missing icons: npm install -D sharp -w client');
  console.error(String(err?.message || err));
  process.exit(1);
}

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
