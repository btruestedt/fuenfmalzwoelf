// Erzeugt die App-Icons (PNG) ohne Zusatzbibliotheken: ein elfenbeinfarbener Würfel
// mit fünf Augen auf dunkelgrünem Samt.   Aufruf: npm run icons

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v) => Math.max(0, Math.min(1, v));

/** Farbe an der Stelle (u,v) im Einheitsquadrat. */
function shade(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  let col = mix([24, 96, 62], [4, 26, 16], clamp(Math.hypot(dx, dy) * 1.5));

  // Abgerundetes Quadrat (Würfel) als Distanzfeld, dazu ein weicher Schatten.
  const half = 0.27;
  const rad = 0.075;
  const sd = (x, y) =>
    Math.hypot(Math.max(Math.abs(x) - half + rad, 0), Math.max(Math.abs(y) - half + rad, 0)) - rad;
  col = mix(col, [0, 8, 4], 0.55 * clamp(1 - sd(dx - 0.02, dy - 0.035) / 0.06));
  if (sd(dx, dy) <= 0) {
    col = mix([252, 247, 235], [226, 212, 182], clamp((dx + dy) * 1.4 + 0.5));
    for (const [px, py] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (Math.hypot(dx - px * 0.135, dy - py * 0.135) < 0.05) col = px || py ? [22, 22, 22] : [142, 28, 20];
    }
  }
  return col;
}

function png(size) {
  const SS = 3; // Kantenglättung durch Überabtastung
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      const o = row + 1 + x * 4;
      raw[o] = acc[0] / (SS * SS);
      raw[o + 1] = acc[1] / (SS * SS);
      raw[o + 2] = acc[2] / (SS * SS);
      raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 Bit, RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), png(size));
  console.log(`${name} (${size}×${size})`);
}
