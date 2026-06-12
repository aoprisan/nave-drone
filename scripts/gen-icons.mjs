// Dependency-free PWA icon generator.
//
// Draws NAVE's mark — a gothic pointed-arch window in amber on a near-black
// ground — at the sizes the manifest needs, and encodes them as PNGs using only
// node:zlib. No image libraries, no binary assets checked into the repo; run via
// `npm run icons` (part of `npm run build`).

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const BG = [16, 12, 9]; // #100c09
const AMBER = [201, 123, 61]; // #c97b3d
const AMBER_HI = [230, 170, 110];

// ── PNG encoding ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the mark ────────────────────────────────────────────────
// A filled pointed (ogival) arch, then an inner arch carved out of it, leaving
// a thick ring — a lit window. Geometry is expressed in fractions of the canvas
// so it scales cleanly and stays inside the maskable safe zone.
function archHit(nx, ny, half, cx, ySpring, yBase, R) {
  if (ny > yBase || nx < cx - half || nx > cx + half) return false;
  if (ny >= ySpring) return true; // straight body (the pillars)
  // pointed top: intersection of two arcs of radius R centred at the springers
  const dL = Math.hypot(nx - (cx - half), ny - ySpring);
  const dR = Math.hypot(nx - (cx + half), ny - ySpring);
  return dL <= R && dR <= R;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = 0.5, half = 0.2, ySpring = 0.5, yBase = 0.82;
  const R = 2 * half; // ogive radius = arch width
  const b = 0.052; // ring thickness (in normalized units)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
      const outer = archHit(nx, ny, half, cx, ySpring, yBase, R);
      const inner = archHit(nx, ny, half - b, cx, ySpring + b, yBase - b, R - 2 * b);
      let col = BG;
      if (outer && !inner) {
        // vertical amber gradient: brighter toward the apex
        const t = Math.min(1, Math.max(0, (yBase - ny) / (yBase - 0.1)));
        col = [
          Math.round(AMBER[0] + (AMBER_HI[0] - AMBER[0]) * t),
          Math.round(AMBER[1] + (AMBER_HI[1] - AMBER[1]) * t),
          Math.round(AMBER[2] + (AMBER_HI[2] - AMBER[2]) * t),
        ];
      }
      const i = (y * size + x) * 4;
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ["pwa-192.png", 192],
  ["pwa-512.png", 512],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of targets) {
  writeFileSync(join(OUT, name), drawIcon(size));
  console.log(`  ✓ ${name} (${size}×${size})`);
}
console.log("icons generated →", OUT);
