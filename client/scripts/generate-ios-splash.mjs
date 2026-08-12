/**
 * Generate iOS PWA launch images (apple-touch-startup-image).
 * Without these, iPhone shows a white screen when opening an installed PWA
 * until the WebView paints — Android uses manifest background_color instead.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(rootDir, 'public');
const splashDir = join(publicDir, 'apple-splash');
const indexHtml = join(rootDir, 'index.html');
const BG = { r: 7, g: 13, b: 26 }; // #070d1a

/** CSS points × DPR → pixel splash. Portrait + landscape for each. */
const DEVICES = [
  // iPhone
  { w: 320, h: 568, dpr: 2 }, // SE (1st)
  { w: 375, h: 667, dpr: 2 }, // 6 / 7 / 8 / SE (2nd/3rd)
  { w: 414, h: 736, dpr: 3 }, // 6+ / 7+ / 8+
  { w: 375, h: 812, dpr: 3 }, // X / XS / 11 Pro / 12–13 mini
  { w: 390, h: 844, dpr: 3 }, // 12 / 13 / 14
  { w: 393, h: 852, dpr: 3 }, // 14 Pro / 15 / 15 Pro / 16
  { w: 402, h: 874, dpr: 3 }, // 16 Pro
  { w: 414, h: 896, dpr: 2 }, // XR / 11
  { w: 414, h: 896, dpr: 3 }, // XS Max / 11 Pro Max
  { w: 428, h: 926, dpr: 3 }, // 12/13 Pro Max / 14 Plus
  { w: 430, h: 932, dpr: 3 }, // 14 Pro Max / 15 Plus/Pro Max / 16 Plus
  { w: 440, h: 956, dpr: 3 }, // 16 Pro Max
  // iPad
  { w: 768, h: 1024, dpr: 2 },
  { w: 820, h: 1180, dpr: 2 },
  { w: 834, h: 1112, dpr: 2 },
  { w: 834, h: 1194, dpr: 2 },
  { w: 1024, h: 1366, dpr: 2 },
];

function media(device, orientation) {
  return (
    `screen and (device-width: ${device.w}px) and (device-height: ${device.h}px)` +
    ` and (-webkit-device-pixel-ratio: ${device.dpr}) and (orientation: ${orientation})`
  );
}

function fileName(pxW, pxH) {
  return `apple-splash-${pxW}-${pxH}.jpg`;
}

function entriesFor(device) {
  const portraitW = Math.round(device.w * device.dpr);
  const portraitH = Math.round(device.h * device.dpr);
  return [
    {
      file: fileName(portraitW, portraitH),
      width: portraitW,
      height: portraitH,
      media: media(device, 'portrait'),
    },
    {
      file: fileName(portraitH, portraitW),
      width: portraitH,
      height: portraitW,
      media: media(device, 'landscape'),
    },
  ];
}

const allEntries = DEVICES.flatMap(entriesFor);
// Dedupe identical pixel sizes (same file, multiple media queries still needed).
const uniqueFiles = [...new Map(allEntries.map((e) => [e.file, e])).values()];

const iconCandidates = [
  join(publicDir, 'app-icon-512.png'),
  join(publicDir, 'app-icon-192.png'),
  join(rootDir, 'brand', 'icon-source.png'),
];
const iconPath = iconCandidates.find((p) => existsSync(p));
if (!iconPath) {
  console.error('No app icon found to composite onto iOS splash images');
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (err) {
  const missing = uniqueFiles.some((e) => !existsSync(join(splashDir, e.file)));
  if (!missing) {
    console.warn('sharp unavailable; keeping committed apple-splash images');
    process.exit(0);
  }
  console.error('Install sharp to generate iOS splash images: npm install -D sharp -w client');
  console.error(String(err?.message || err));
  process.exit(1);
}

mkdirSync(splashDir, { recursive: true });

const iconMtime = statSync(iconPath).mtimeMs;
const iconBuf = readFileSync(iconPath);

let wrote = 0;
for (const entry of uniqueFiles) {
  const out = join(splashDir, entry.file);
  const stale =
    !existsSync(out) ||
    statSync(out).mtimeMs < iconMtime;
  if (!stale) continue;

  const mark = Math.max(96, Math.round(Math.min(entry.width, entry.height) * 0.18));
  const markBuf = await sharp(iconBuf)
    .resize(mark, mark, { fit: 'contain', background: { ...BG, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: entry.width,
      height: entry.height,
      channels: 3,
      background: BG,
    },
  })
    .composite([{ input: markBuf, gravity: 'centre' }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(out);
  wrote += 1;
  console.log(entry.file);
}

// Drop obsolete generated files not in the current set.
const keep = new Set(uniqueFiles.map((e) => e.file));
for (const name of readdirSync(splashDir)) {
  if (!keep.has(name) && name.endsWith('.jpg')) {
    rmSync(join(splashDir, name));
    console.log('removed', name);
  }
}

const linkBlock = [
  '    <!-- apple-touch-startup-image:begin -->',
  '    <!-- iPhone/iPad home-screen launch images (exact size match required by iOS). -->',
  ...allEntries.map(
    (e) =>
      `    <link rel="apple-touch-startup-image" media="${e.media}" href="/apple-splash/${e.file}" />`,
  ),
  '    <!-- apple-touch-startup-image:end -->',
].join('\n');

const html = readFileSync(indexHtml, 'utf8');
const begin = '<!-- apple-touch-startup-image:begin -->';
const end = '<!-- apple-touch-startup-image:end -->';
let nextHtml;
if (html.includes(begin) && html.includes(end)) {
  nextHtml = html.replace(
    new RegExp(`${begin}[\\s\\S]*?${end}`),
    linkBlock.trim(),
  );
} else {
  const anchor = '<link rel="apple-touch-icon" href="/app-icon-180.png" />';
  if (!html.includes(anchor)) {
    console.error('Could not find apple-touch-icon anchor in index.html');
    process.exit(1);
  }
  nextHtml = html.replace(anchor, `${anchor}\n${linkBlock}`);
}

if (nextHtml !== html) {
  writeFileSync(indexHtml, nextHtml);
  console.log('updated index.html apple-touch-startup-image links');
}

console.log(
  wrote === 0
    ? `apple-splash up to date (${uniqueFiles.length} images, ${allEntries.length} links)`
    : `wrote ${wrote} apple-splash images (${allEntries.length} links)`,
);
