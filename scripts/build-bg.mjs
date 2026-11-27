// Prepares the sky photo used by the background shader and the reflection environment.
// Source: Unsplash photo-1777087345558-ef9aac3bb401 ("Green hill under a bright blue sky with
// clouds", Space Nature / @uso12830, Unsplash License). The bushy hill and power lines at the
// bottom are cropped away: our own hill, mountains and grass are drawn in 3D/shader.
// Usage: node scripts/build-bg.mjs path/to/source.jpg
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/build-bg.mjs source.jpg');
const meta = await sharp(src).metadata();
const cropH = Math.round(meta.height * 0.768); // just above the hill crest
const base = sharp(src).extract({ left: 0, top: 0, width: meta.width, height: cropH })
  .modulate({ saturation: 1.06, brightness: 1.02 });
for (const [name, w, q] of [['sky.jpg', 3200, 86], ['sky-sm.jpg', 1600, 82]]) {
  const out = resolve(__dirname, '../public/bg', name);
  const info = await base.clone().resize(w).jpeg({ quality: q, mozjpeg: true }).toFile(out);
  console.log(name, info.width, 'x', info.height, (info.size / 1024).toFixed(0) + ' KB');
}
