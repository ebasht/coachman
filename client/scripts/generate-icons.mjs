import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = join(publicDir, 'icon.svg');
const sizes = [180, 192, 512];

const missing = sizes.filter((size) => !existsSync(join(publicDir, `icon-${size}.png`)));
if (missing.length === 0) {
  console.log('PNG icons already exist, skipping');
  process.exit(0);
}

if (!existsSync(svg)) {
  console.error('icon.svg not found');
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('Install sharp to regenerate icons: npm install -D sharp -w client');
  console.error('Missing:', missing.map((s) => `icon-${s}.png`).join(', '));
  process.exit(1);
}

const svgData = readFileSync(svg);
for (const size of sizes) {
  const out = join(publicDir, `icon-${size}.png`);
  if (existsSync(out)) continue;
  await sharp(svgData).resize(size, size).png().toFile(out);
  console.log(`icon-${size}.png`);
}
