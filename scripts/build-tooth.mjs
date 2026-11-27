// Procedural lower molar → public/models/tooth.bin
//
// The shape is a signed distance field in "tooth units": total height H = 1, root tips at
// y ≈ 0, cusp tips at y ≈ 1. Axes: x = mesio-distal (width as seen from the front),
// z = bucco-lingual (front/back), y = up.
//
//   crown  = superellipsoid ∪ₖ 4 cusp spheres, cross fissure carved by soft subtraction
//   neck   = rounded slab slightly narrower than the crown (cervical waist)
//   roots  = 4 rounded cones swept along gently curved Bézier paths, tapering to a round tip
//   tooth  = everything stitched with smooth-min (k ≈ 0.06–0.1)
//
// Meshing: marching cubes (200 cells over the height) → vertex weld → Taubin smoothing.
// In the browser: mergeVertices() + computeVertexNormals() (smooth shading).
// File: 'TTH2', u32 nVerts, u32 nIdx, f32 min[3], f32 max[3], u16 quantised positions, u32 indices.
//
// Run:      npm run tooth                         (options: --res 160)
// Preview:  npm run tooth -- --preview out.png    (raymarched SDF: front / side / ¾ / top, ~3 s)
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import iso from 'isosurface';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/tooth.bin');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const RES = Number(arg('--res', 200)); // cells across the height (192–256 → glassy-smooth silhouettes)
const PREVIEW = arg('--preview', null);

// ---------- helpers ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}
const smax = (a, b, k) => -smin(-a, -b, k);

/** Superellipsoid: radii (a,b,c), horizontal exponent n, vertical exponent m.
 *  Implicit F = ((|x/a|^n + |z/c|^n)^(m/n) + |y/b|^m)^(1/m); distance ≈ (F-1)/|∇F| */
function superF(x, y, z, a, b, c, n, m) {
  const h = Math.pow(Math.pow(Math.abs(x / a), n) + Math.pow(Math.abs(z / c), n), m / n);
  return Math.pow(h + Math.pow(Math.abs(y / b), m), 1 / m);
}
function sdSuper(x, y, z, a, b, c, n, m) {
  const e = 1e-3;
  const f = superF(x, y, z, a, b, c, n, m);
  const gx = (superF(x + e, y, z, a, b, c, n, m) - superF(x - e, y, z, a, b, c, n, m)) / (2 * e);
  const gy = (superF(x, y + e, z, a, b, c, n, m) - superF(x, y - e, z, a, b, c, n, m)) / (2 * e);
  const gz = (superF(x, y, z + e, a, b, c, n, m) - superF(x, y, z - e, a, b, c, n, m)) / (2 * e);
  return (f - 1) / Math.max(len3(gx, gy, gz), 1e-4);
}
function sdRoundBox(px, py, pz, bx, by, bz, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r, qz = Math.abs(pz) - bz + r;
  return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
/** Capsule a→b, radius r */
function sdCapsule(px, py, pz, a, b, r) {
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  return len3(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}
/** Cone from sphere (a, r1) to sphere (b, r2), i.e. rounded at both ends (iq, exact) */
function sdRoundCone(px, py, pz, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// ---------- shape parameters (H ≈ 1) ----------
const CROWN = { y: 0.7, a: 0.43, b: 0.25, c: 0.37, n: 2.4, m: 2.0 };
// 4 cusps: 2 buccal (front, +z) and 2 lingual (back, −z); lingual ones a touch taller
const CUSPS = [
  [-0.19, 0.84, 0.14, 0.19],
  [0.19, 0.84, 0.14, 0.19],
  [-0.19, 0.85, -0.14, 0.19],
  [0.19, 0.85, -0.14, 0.19],
];
const K_CUSP = 0.15;
// cross fissure: along x (between front & back cusps) and along z (the deep "M" valley)
const GROOVE_X = { a: [-0.6, 1.0, 0], b: [0.6, 1.0, 0], r: 0.06, k: 0.12 };
const GROOVE_Z = { a: [0, 1.015, -0.6], b: [0, 1.015, 0.6], r: 0.12, k: 0.12 };
// neck / root trunk: ~0.75 of the crown width
const NECK = { y: 0.5, a: 0.31, b: 0.085, c: 0.27, n: 2.4, m: 2.0 };
const K_NECK = 0.17;
// roots: quadratic Bézier start → control → tip, radius 0.11 → 0.04 (Ø 0.22H → 0.08H)
const ROOT_R0 = 0.11;
const ROOT_R1 = 0.04;
const ROOT_SEGS = 24;
function rootPath(sx, sz) {
  return {
    p0: [0.165 * sx, 0.5, 0.125 * sz],
    p1: [0.285 * sx, 0.23, 0.215 * sz],
    p2: [0.275 * sx, 0.03, 0.2 * sz],
  };
}
const ROOTS = [rootPath(-1, 1), rootPath(1, 1), rootPath(-1, -1), rootPath(1, -1)];
const K_ROOT = 0.14;

function bez(p, t) {
  const u = 1 - t;
  return [0, 1, 2].map((i) => u * u * p.p0[i] + 2 * u * t * p.p1[i] + t * t * p.p2[i]);
}
// Each root is one continuous tube: the curve is sampled into a fine polyline, and the
// distance is |p − closest point| − r(t) with the radius interpolated along the curve.
// The last sample is a sphere of radius ROOT_R1 → a round tip, no bulb.
const rootR = (t) => mix(ROOT_R0, ROOT_R1, Math.pow(t, 0.75));
const ROOT_POLYS = ROOTS.map((p) => {
  const pts = [];
  for (let i = 0; i <= ROOT_SEGS; i++) pts.push([...bez(p, i / ROOT_SEGS), rootR(i / ROOT_SEGS)]);
  return pts;
});
function sdRoot(x, y, z, pts) {
  // closest point on the centre curve first (pure distance), then subtract the radius there:
  // the level set is a smooth tube with no ridges at the polyline joints
  let best = 1e9, r = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
    const qx = pax - bax * h, qy = pay - bay * h, qz = paz - baz * h;
    const d2 = qx * qx + qy * qy + qz * qz;
    if (d2 < best) {
      best = d2;
      r = mix(a[3], b[3], h);
    }
  }
  return Math.sqrt(best) - r;
}

function sdTooth(x, y, z) {
  // crown body
  let d = sdSuper(x, y - CROWN.y, z, CROWN.a, CROWN.b, CROWN.c, CROWN.n, CROWN.m);
  // cusps
  for (const [cx, cy, cz, r] of CUSPS) d = smin(d, len3(x - cx, y - cy, z - cz) - r, K_CUSP);
  // fissures (soft subtraction)
  d = smax(d, -sdCapsule(x, y, z, GROOVE_Z.a, GROOVE_Z.b, GROOVE_Z.r), GROOVE_Z.k);
  d = smax(d, -sdCapsule(x, y, z, GROOVE_X.a, GROOVE_X.b, GROOVE_X.r), GROOVE_X.k);
  // neck
  d = smin(d, sdSuper(x, y - NECK.y, z, NECK.a, NECK.b, NECK.c, NECK.n, NECK.m), K_NECK);
  // roots
  let rd = 1e9;
  for (const pts of ROOT_POLYS) rd = Math.min(rd, sdRoot(x, y, z, pts));
  return smin(d, rd, K_ROOT);
}

const BOUNDS = [
  [-0.56, -0.06, -0.5],
  [0.56, 1.12, 0.5],
];

// ---------- preview: orthographic raymarch of the SDF ----------
async function preview(file) {
  const sharp = (await import('sharp')).default;
  const S = 360;
  const views = [
    { name: 'front', dir: [0, 0, -1], up: [0, 1, 0] },
    { name: 'side', dir: [-1, 0, 0], up: [0, 1, 0] },
    { name: '3/4', dir: norm([-0.6, -0.35, -0.75]), up: [0, 1, 0] },
    { name: 'top', dir: [0, -1, 0], up: [0, 0, -1] },
  ];
  const img = Buffer.alloc(S * views.length * S * 3);
  const L = norm([-0.4, 0.7, 0.6]);
  views.forEach((v, vi) => {
    const f = v.dir;
    const r = norm(cross(f, v.up));
    const u = cross(r, f);
    const c = [0, 0.5, 0];
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const sx = ((i + 0.5) / S - 0.5) * 1.25, sy = (0.5 - (j + 0.5) / S) * 1.25;
        let p = [c[0] + r[0] * sx + u[0] * sy - f[0] * 2, c[1] + r[1] * sx + u[1] * sy - f[1] * 2, c[2] + r[2] * sx + u[2] * sy - f[2] * 2];
        let hit = false;
        let t = 0;
        for (let k = 0; k < 160 && t < 4; k++) {
          const d = sdTooth(p[0], p[1], p[2]);
          if (d < 4e-4) { hit = true; break; }
          const s = Math.max(d * 0.8, 1e-4);
          t += s;
          p = [p[0] + f[0] * s, p[1] + f[1] * s, p[2] + f[2] * s];
        }
        const o = (j * S * views.length + vi * S + i) * 3;
        // grid lines every 0.1 H in the background
        let col = [235, 238, 242];
        if (!hit) {
          const gy = sy + 0.5 * (v.name === 'top' ? 0 : 1);
          if (Math.abs(gy * 10 - Math.round(gy * 10)) < 0.012) col = [210, 214, 222];
        } else {
          const e = 1e-3;
          const n = norm([
            sdTooth(p[0] + e, p[1], p[2]) - sdTooth(p[0] - e, p[1], p[2]),
            sdTooth(p[0], p[1] + e, p[2]) - sdTooth(p[0], p[1] - e, p[2]),
            sdTooth(p[0], p[1], p[2] + e) - sdTooth(p[0], p[1], p[2] - e),
          ]);
          const dif = Math.max(0, dot(n, L));
          const rim = Math.pow(1 - Math.abs(dot(n, f)), 3);
          const val = 40 + 170 * dif + 60 * rim;
          col = [val * 0.95, val * 0.97, val];
        }
        img[o] = clamp(col[0], 0, 255);
        img[o + 1] = clamp(col[1], 0, 255);
        img[o + 2] = clamp(col[2], 0, 255);
      }
    }
  });
  await sharp(img, { raw: { width: S * views.length, height: S, channels: 3 } }).png().toFile(file);
  console.log('preview →', file);
}
function norm(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ---------- mesh ----------
function buildMesh() {
  const t0 = Date.now();
  const h = (BOUNDS[1][1] - BOUNDS[0][1]) / RES;
  const dims = [0, 1, 2].map((i) => Math.ceil((BOUNDS[1][i] - BOUNDS[0][i]) / h) + 1);
  const mc = iso.marchingCubes(dims, (x, y, z) => sdTooth(x, y, z), BOUNDS);
  console.log(`marching cubes ${dims.join('×')}: ${mc.positions.length} verts, ${mc.cells.length} tris (${Date.now() - t0} ms)`);

  // weld coincident vertices
  const map = new Map();
  const pos = [];
  const remap = new Int32Array(mc.positions.length);
  const q = 1e5;
  mc.positions.forEach((p, i) => {
    const key = `${Math.round(p[0] * q)},${Math.round(p[1] * q)},${Math.round(p[2] * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length;
      map.set(key, id);
      pos.push([p[0], p[1], p[2]]);
    }
    remap[i] = id;
  });
  const tris = [];
  for (const c of mc.cells) {
    const a = remap[c[0]], b = remap[c[1]], d = remap[c[2]];
    if (a !== b && b !== d && a !== d) tris.push([a, b, d]);
  }

  // Taubin smoothing (λ|μ), uniform Laplacian
  const nb = pos.map(() => new Set());
  for (const [a, b, c] of tris) {
    nb[a].add(b).add(c);
    nb[b].add(a).add(c);
    nb[c].add(a).add(b);
  }
  const nbs = nb.map((s) => [...s]);
  const step = (f) => {
    const next = pos.map((p, i) => {
      const n = nbs[i];
      if (!n.length) return p;
      let x = 0, y = 0, z = 0;
      for (const j of n) {
        x += pos[j][0];
        y += pos[j][1];
        z += pos[j][2];
      }
      const k = 1 / n.length;
      return [p[0] + f * (x * k - p[0]), p[1] + f * (y * k - p[1]), p[2] + f * (z * k - p[2])];
    });
    for (let i = 0; i < pos.length; i++) pos[i] = next[i];
  };
  for (let i = 0; i < 20; i++) {
    step(0.5);
    step(-0.53);
  }

  // normalise: root tips at y = 0, height exactly 1, centred in x/z
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of pos) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  const H = max[1] - min[1];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  for (const p of pos) {
    p[0] = (p[0] - cx) / H;
    p[1] = (p[1] - min[1]) / H;
    p[2] = (p[2] - cz) / H;
  }
  console.log(`size W×H×D = ${((max[0] - min[0]) / H).toFixed(3)} × 1 × ${((max[2] - min[2]) / H).toFixed(3)}`);

  // binary (see header comment): positions quantised to 16 bit within the bounding box
  const nV = pos.length, nI = tris.length * 3;
  const bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
  for (const p of pos) for (let k = 0; k < 3; k++) {
    bmin[k] = Math.min(bmin[k], p[k]);
    bmax[k] = Math.max(bmax[k], p[k]);
  }
  const posBytes = Math.ceil((nV * 6) / 4) * 4; // keep the index block 4-byte aligned
  const head = 4 + 8 + 24;
  const buf = Buffer.alloc(head + posBytes + nI * 4);
  buf.write('TTH2', 0, 'ascii');
  buf.writeUInt32LE(nV, 4);
  buf.writeUInt32LE(nI, 8);
  for (let k = 0; k < 3; k++) {
    buf.writeFloatLE(bmin[k], 12 + k * 4);
    buf.writeFloatLE(bmax[k], 24 + k * 4);
  }
  let o = head;
  for (const p of pos) {
    for (let k = 0; k < 3; k++) buf.writeUInt16LE(Math.round(((p[k] - bmin[k]) / (bmax[k] - bmin[k])) * 65535), o + k * 2);
    o += 6;
  }
  o = head + posBytes;
  for (const t of tris) {
    buf.writeUInt32LE(t[0], o);
    buf.writeUInt32LE(t[1], o + 4);
    buf.writeUInt32LE(t[2], o + 8);
    o += 12;
  }
  writeFileSync(OUT, buf);
  console.log(`→ ${OUT}: ${nV} verts, ${tris.length} tris, ${(buf.length / 1024).toFixed(0)} KB (${Date.now() - t0} ms)`);
}

if (PREVIEW) await preview(resolve(process.cwd(), PREVIEW));
else buildMesh();
