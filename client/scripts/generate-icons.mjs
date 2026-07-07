import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(join(publicDir, 'icon.svg'));

for (const size of [180, 192, 512]) {
  await sharp(svg).resize(size, size).png().toFile(join(publicDir, `icon-${size}.png`));
  console.log(`icon-${size}.png`);
}
