'use strict';

/**
 * Generates build/icon.png (512x512) with no native deps — a rounded gradient
 * tile with a white "send" arrow. Rendered at 4x and downsampled for clean
 * antialiased edges. electron-builder derives the .ico / Linux icons from it.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 512;
const SS = 4; // supersample factor
const HI = SIZE * SS;

const C1 = [91, 140, 255]; // blue
const C2 = [124, 92, 255]; // purple
const WHITE = [255, 255, 255];

function insideRoundRect(x, y, W, r) {
  // corner-rounded square covering [0,W)
  const nx = Math.min(x, W - x);
  const ny = Math.min(y, W - y);
  if (nx >= r || ny >= r) return x >= 0 && y >= 0 && x < W && y < W;
  const dx = r - nx;
  const dy = r - ny;
  return dx * dx + dy * dy <= r * r;
}

function insideArrow(x, y, W) {
  const cx = W / 2;
  const hw = 0.22 * W; // arrow head half-width
  const sw = 0.082 * W; // stem half-width
  const tipY = 0.28 * W;
  const headBaseY = 0.52 * W;
  const stemBottomY = 0.74 * W;

  // stem
  if (x >= cx - sw && x <= cx + sw && y >= 0.45 * W && y <= stemBottomY) return true;

  // head triangle: tip (cx, tipY) -> (cx-hw, headBaseY) -> (cx+hw, headBaseY)
  if (y >= tipY && y <= headBaseY) {
    const frac = (y - tipY) / (headBaseY - tipY);
    const halfAtY = frac * hw;
    if (x >= cx - halfAtY && x <= cx + halfAtY) return true;
  }
  return false;
}

function hiPixel(x, y) {
  // returns [r,g,b,a]
  if (!insideRoundRect(x, y, HI, 0.235 * HI)) return [0, 0, 0, 0];
  if (insideArrow(x, y, HI)) return [WHITE[0], WHITE[1], WHITE[2], 255];
  const t = (x + y) / (2 * HI);
  return [
    Math.round(C1[0] + (C2[0] - C1[0]) * t),
    Math.round(C1[1] + (C2[1] - C1[1]) * t),
    Math.round(C1[2] + (C2[2] - C1[2]) * t),
    255,
  ];
}

function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [r, g, b, a] = hiPixel(x * SS + sx, y * SS + sy);
          const af = a / 255;
          pr += r * af;
          pg += g * af;
          pb += b * af;
          pa += a;
        }
      }
      const n = SS * SS;
      const aAvg = pa / n; // 0..255
      const idx = (y * SIZE + x) * 4;
      if (aAvg <= 0) {
        out[idx] = out[idx + 1] = out[idx + 2] = out[idx + 3] = 0;
      } else {
        const aSum = pa / 255; // sum of alpha fractions
        out[idx] = Math.round(pr / aSum);
        out[idx + 1] = Math.round(pg / aSum);
        out[idx + 2] = Math.round(pb / aSum);
        out[idx + 3] = Math.round(aAvg);
      }
    }
  }
  return out;
}

// --- minimal PNG encoder -----------------------------------------------------
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // filter byte 0 per scanline
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rgba = render();
  const png = encodePng(SIZE, SIZE, rgba);
  fs.writeFileSync(OUT, png);
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE})`);
}

main();
