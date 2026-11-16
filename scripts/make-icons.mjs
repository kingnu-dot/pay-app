// ホーム画面用のアイコン（PNG）を作る。外部ライブラリを使わず、単純な図形だけを描く
// 使い方：node scripts/make-icons.mjs（出力：public/icons/）

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const BACKGROUND = [0x1f, 0x29, 0x37];
const FOREGROUND = [0xf9, 0xfa, 0xfb];
const ACCENT = [0x60, 0xa5, 0xfa];

// CRC32（PNG のチャンクに必要）
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 1辺 size_px の正方形のアイコンを描く。
 * 図柄：硬貨を表す輪と、その中の「おすすめ」を表すチェック印。
 * scale は図柄の大きさ（マスク用は、端を切り取られても欠けないよう小さくする）
 */
function drawIcon(size_px, scale) {
  const raw = Buffer.alloc(size_px * (size_px * 3 + 1));
  const center = (size_px - 1) / 2;
  const radius = (size_px / 2) * scale;
  const ring = radius * 0.16;
  // チェック印を作る2本の線分（中心からの相対位置、半径に対する比）
  const segments = [
    [-0.42, 0.02, -0.12, 0.32],
    [-0.12, 0.32, 0.44, -0.3],
  ];
  const distanceToSegment = (px, py, [x1, y1, x2, y2]) => {
    const [ax, ay, bx, by] = [x1 * radius, y1 * radius, x2 * radius, y2 * radius];
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
  };
  for (let y = 0; y < size_px; y += 1) {
    const row = y * (size_px * 3 + 1);
    raw[row] = 0; // フィルタなし
    for (let x = 0; x < size_px; x += 1) {
      const [dx, dy] = [x - center, y - center];
      const distance = Math.hypot(dx, dy);
      let color = BACKGROUND;
      if (distance <= radius && distance >= radius - ring) color = FOREGROUND;
      else if (segments.some((s) => distanceToSegment(dx, dy, s) <= ring * 0.6)) color = ACCENT;
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size_px, 0);
  header.writeUInt32BE(size_px, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 ビット、RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out_dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out_dir, { recursive: true });
for (const [name, size_px, scale] of [
  ["icon-192.png", 192, 0.8],
  ["icon-512.png", 512, 0.8],
  ["icon-maskable-512.png", 512, 0.58],
]) {
  const png = drawIcon(size_px, scale);
  writeFileSync(join(out_dir, name), png);
  console.log(`${name}: ${png.length} バイト`);
}
