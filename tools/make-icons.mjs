/* Generates the Nabla app icons — no dependencies, just zlib.
 *
 * The mark is the del operator drawn as a mitered outline triangle on warm
 * paper, inside a thin plate frame. Run: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const PAPER = [0xf4, 0xf1, 0xea];
const INK = [0x1b, 0x3a, 0x5c];
const RULE = [0xb9, 0xb1, 0xa0];

const SAMPLES = 4; // per axis, so 16 coverage samples per pixel

// ------------------------------------------------------------------ png ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- shapes ---

function triangle(cx, cy, radius) {
  const dx = radius * Math.cos(Math.PI / 6);
  const dy = radius * Math.sin(Math.PI / 6);
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx, cy + radius],
  ];
}

/** Scaling a triangle about its centroid is exactly a mitered offset. */
function scaleAbout(points, cx, cy, factor) {
  return points.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

function edgeSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function insideTriangle(px, py, tri) {
  const d1 = edgeSign(px, py, tri[0][0], tri[0][1], tri[1][0], tri[1][1]);
  const d2 = edgeSign(px, py, tri[1][0], tri[1][1], tri[2][0], tri[2][1]);
  const d3 = edgeSign(px, py, tri[2][0], tri[2][1], tri[0][0], tri[0][1]);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function insideFrame(px, py, inset, weight, size) {
  const outerLow = inset;
  const outerHigh = size - inset;
  const innerLow = inset + weight;
  const innerHigh = size - inset - weight;
  const inOuter = px >= outerLow && px <= outerHigh && py >= outerLow && py <= outerHigh;
  const inInner = px >= innerLow && px <= innerHigh && py >= innerLow && py <= innerHigh;
  return inOuter && !inInner;
}

function blend(target, offset, colour, alpha) {
  for (let c = 0; c < 3; c += 1) {
    target[offset + c] = Math.round(target[offset + c] * (1 - alpha) + colour[c] * alpha);
  }
}

function render(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = PAPER[0];
    rgba[i * 4 + 1] = PAPER[1];
    rgba[i * 4 + 2] = PAPER[2];
    rgba[i * 4 + 3] = 255;
  }

  const centre = size / 2;
  // Maskable icons lose their edges to the platform mask, so shrink the mark
  // into the safe zone and drop the frame entirely.
  const radius = size * (maskable ? 0.22 : 0.293);
  const stroke = radius * 0.32;
  const nominal = triangle(centre, centre, radius);
  const inradius = radius / 2;
  const outer = scaleAbout(nominal, centre, centre, (inradius + stroke / 2) / inradius);
  const inner = scaleAbout(nominal, centre, centre, (inradius - stroke / 2) / inradius);

  const frameInset = size * 0.066;
  const frameWeight = Math.max(1, size * 0.0055);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let markHits = 0;
      let frameHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (insideTriangle(px, py, outer) && !insideTriangle(px, py, inner)) markHits += 1;
          if (!maskable && insideFrame(px, py, frameInset, frameWeight, size)) frameHits += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (frameHits) blend(rgba, offset, RULE, frameHits / total);
      if (markHits) blend(rgba, offset, INK, markHits / total);
    }
  }
  return encodePng(size, rgba);
}

// ----------------------------------------------------------------- svg ----

function svg() {
  const size = 512;
  const centre = size / 2;
  const radius = size * 0.293;
  const stroke = radius * 0.32;
  const points = triangle(centre, centre, radius)
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const inset = size * 0.066;
  const span = size - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Nabla">
  <rect width="${size}" height="${size}" fill="#f4f1ea"/>
  <rect x="${inset.toFixed(2)}" y="${inset.toFixed(2)}" width="${span.toFixed(2)}" height="${span.toFixed(2)}"
        fill="none" stroke="#b9b1a0" stroke-width="${(size * 0.0055).toFixed(2)}"/>
  <polygon points="${points}" fill="none" stroke="#1b3a5c"
           stroke-width="${stroke.toFixed(2)}" stroke-linejoin="miter"/>
</svg>
`;
}

// ----------------------------------------------------------------- main ---

mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-180.png', 180, {}],
  ['icon-32.png', 32, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, options] of targets) {
  const bytes = render(size, options);
  writeFileSync(join(OUT, name), bytes);
  console.log(`${name.padEnd(24)} ${size}×${size}  ${(bytes.length / 1024).toFixed(1)} kB`);
}

writeFileSync(join(OUT, 'nabla.svg'), svg());
console.log('nabla.svg');
