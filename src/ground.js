import * as THREE from 'three';
import { PALETTE } from './background.js';

/** Hill height: rounded crest at the origin (where the tooth stands), falling away behind. */
export function hillY(x, z) {
  return -(0.1 * x * x + (z < 0 ? 0.24 : 0.05) * z * z);
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clump = (x, z) =>
  (Math.sin(x * 3.7 + z * 1.9) * 0.5 + Math.sin(x * 1.33 - z * 2.61 + 1.7) * 0.35 + Math.sin(x * 7.9 + z * 6.3) * 0.15) * 0.5 + 0.5;

const SUN = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();

// ---------- hill surface ----------
function createHill() {
  const geo = new THREE.PlaneGeometry(90, 90, 260, 260);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -35);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, hillY(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: {
      uDark: { value: new THREE.Color('#2f6a17') },
      uMid: { value: new THREE.Color('#5c9c2c') },
      uLight: { value: new THREE.Color('#97c64a') },
      uHaze: { value: new THREE.Color(PALETTE.valley).lerp(new THREE.Color(PALETTE.haze), 0.3) },
      uSun: { value: SUN },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normal;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uDark, uMid, uLight, uHaze, uSun;
      varying vec3 vWorld;
      varying vec3 vNormal;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * n2(p); p *= 2.1; a *= 0.5; } return s; }
      // scattered flower specks (yellow / white), fading out where they'd alias
      vec3 specks(vec2 p, float scale, float lod, vec3 col) {
        vec2 q = p * scale;
        vec2 c = floor(q);
        float r = h2(c);
        vec2 o = vec2(h2(c + 3.1), h2(c + 7.7)) * 0.7 + 0.15;
        float d = length(fract(q) - o);
        float on = step(0.82, r) * smoothstep(0.16, 0.08, d) * (1.0 - lod);
        return vec3(on * (r > 0.95 ? 1.0 : 0.0), on * (r <= 0.95 ? 1.0 : 0.0), 0.0);
      }
      void main() {
        vec2 p = vWorld.xz;
        float dist = distance(cameraPosition, vWorld);
        float big = fbm(p * 0.45);
        float mid = fbm(p * 2.3 + 4.0);
        float fine = n2(p * 38.0);
        float lod = smoothstep(2.0, 9.0, dist);
        vec3 col = mix(uDark, uMid, smoothstep(0.25, 0.7, big));
        col = mix(col, uLight, smoothstep(0.45, 0.85, mid) * 0.55);
        col *= 0.82 + 0.36 * mix(fine, 0.5, lod);
        // light: sun + sky, grass is rough so keep it soft
        float ndl = max(dot(normalize(vNormal), uSun), 0.0);
        col *= 0.72 + 0.38 * ndl;
        // contact shadow around the tooth
        col *= mix(0.62, 1.0, smoothstep(0.12, 0.7, length(p)));
        // flowers
        vec3 s1 = specks(p, 9.0, smoothstep(3.0, 10.0, dist), col);
        vec3 s2 = specks(p + 13.7, 5.0, smoothstep(5.0, 16.0, dist), col);
        float yel = max(s1.x, s2.x), wht = max(s1.y, s2.y);
        col = mix(col, vec3(1.0, 0.82, 0.12), yel * 0.85);
        col = mix(col, vec3(0.95, 0.95, 0.9), wht * 0.8);
        // aerial perspective
        col = mix(col, uHaze, smoothstep(4.0, 40.0, dist) * 0.8);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  return mesh;
}

// ---------- grass blades ----------
const FIELD = { x0: -3.6, x1: 3.6, z0: -2.4, z1: 3.6 };
function fieldFade(x, z) {
  const ex = Math.min(x - FIELD.x0, FIELD.x1 - x) / 1.2;
  const ez = Math.min((z - FIELD.z0) / 1.6, (FIELD.z1 - z) / 0.6);
  return THREE.MathUtils.clamp(Math.min(ex, ez), 0, 1);
}

function createGrass(count) {
  const SEG = 4;
  const base = new THREE.BufferGeometry();
  const pos = [];
  const idx = [];
  for (let i = 0; i < SEG; i++) {
    const h = i / SEG;
    const w = 0.5 * (1 - h * 0.85);
    pos.push(-w, h, 0, w, h, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < SEG - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  idx.push((SEG - 1) * 2, (SEG - 1) * 2 + 1, SEG * 2);
  base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  base.setIndex(idx);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  const rnd = mulberry32(7);
  const offset = new Float32Array(count * 4);
  const scale = new Float32Array(count * 2);
  const rand = new Float32Array(count);
  let n = 0;
  let guard = 0;
  while (n < count && guard < count * 10) {
    guard++;
    // denser towards the tooth
    const near = rnd() < 0.35;
    let x, z;
    if (near) {
      const a = rnd() * Math.PI * 2;
      const r = 0.12 + Math.pow(rnd(), 1.4) * 1.1;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
    } else {
      x = THREE.MathUtils.lerp(FIELD.x0, FIELD.x1, rnd());
      z = THREE.MathUtils.lerp(FIELD.z0, FIELD.z1, rnd());
    }
    const fade = fieldFade(x, z);
    const c = clump(x, z);
    if (rnd() > fade * (0.5 + c * 0.6)) continue;
    offset[n * 4] = x;
    offset[n * 4 + 1] = hillY(x, z) - 0.005;
    offset[n * 4 + 2] = z;
    offset[n * 4 + 3] = rnd() * Math.PI * 2;
    const tall = 0.055 + rnd() * 0.06 + c * 0.04;
    // shorter turf right at the tooth, so the rounded root tips peek out
    const nearTooth = THREE.MathUtils.smoothstep(Math.hypot(x, z), 0.25, 0.9);
    scale[n * 2] = tall * (0.45 + 0.55 * fade) * (0.5 + 0.5 * nearTooth);
    scale[n * 2 + 1] = 0.006 + rnd() * 0.005;
    rand[n] = rnd();
    n++;
  }
  geo.instanceCount = n;
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offset, 4));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 2));
  geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));

  const mat = new THREE.ShaderMaterial({
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uBase: { value: new THREE.Color('#1f4a0e') },
      uMid: { value: new THREE.Color('#4f8f23') },
      uTip: { value: new THREE.Color('#a6d150') },
      uDry: { value: new THREE.Color('#d8cd72') },
      uSun: { value: SUN },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec4 aOffset;
      attribute vec2 aScale;
      attribute float aRand;
      varying float vH;
      varying float vRand;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float h = p.y;
        p.x *= aScale.y;
        p.y *= aScale.x;
        p.z += ((aRand - 0.5) * 0.8 + 0.1) * h * h * aScale.x;
        float c = cos(aOffset.w), s = sin(aOffset.w);
        p.xz = mat2(c, -s, s, c) * p.xz;
        vec3 world = aOffset.xyz + p;
        float w = sin(uTime * 1.3 + world.x * 2.1 + world.z * 1.2) * 0.6
                + sin(uTime * 2.4 + world.x * 6.0 - world.z * 4.0 + aRand * 6.28) * 0.25;
        float bend = w * 0.14 * h * h * aScale.x;
        world.x += bend;
        world.z += bend * 0.4;
        vH = h;
        vRand = aRand;
        vWorld = world;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uMid, uTip, uDry, uSun;
      varying float vH;
      varying float vRand;
      varying vec3 vWorld;
      void main() {
        vec3 col = mix(uBase, uMid, smoothstep(0.0, 0.5, vH));
        col = mix(col, uTip, smoothstep(0.45, 1.0, vH));
        col = mix(col, uDry, step(0.92, vRand) * 0.5 * vH);
        col *= 0.8 + 0.4 * vRand;
        vec3 V = normalize(cameraPosition - vWorld);
        col += uTip * pow(max(dot(-V, uSun), 0.0), 2.0) * 0.3 * vH;
        // contact shade near the tooth
        col *= mix(0.6, 1.0, smoothstep(0.1, 0.6, length(vWorld.xz)));
        col *= mix(0.55, 1.0, smoothstep(0.0, 0.6, vH));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- flowers ----------
function flowerGeometry() {
  const shape = new THREE.Shape();
  const N = 50;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos(a * 2.5)), 0.8);
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ShapeGeometry(shape, 8);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    const t = THREE.MathUtils.smoothstep(r, 0.12, 0.36);
    colors[i * 3] = 1;
    colors[i * 3 + 1] = THREE.MathUtils.lerp(0.55, 1, t);
    colors[i * 3 + 2] = THREE.MathUtils.lerp(0.08, 1, t);
    pos.setY(i, r * r * 0.25);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function createFlowers(count) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.InstancedMesh(flowerGeometry(), mat, count);
  const rnd = mulberry32(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const yellow = new THREE.Color('#ffd83a');
  const white = new THREE.Color('#f4f4ec');
  let n = 0;
  let guard = 0;
  while (n < count && guard < count * 30) {
    guard++;
    const x = THREE.MathUtils.lerp(FIELD.x0, FIELD.x1, rnd());
    const z = THREE.MathUtils.lerp(FIELD.z0, FIELD.z1, rnd());
    const fade = fieldFade(x, z);
    if (rnd() > fade || Math.hypot(x, z) < 0.35) continue;
    const s = 0.011 + rnd() * 0.01;
    const y = hillY(x, z) + 0.035 + rnd() * 0.06;
    e.set(-0.35 + rnd() * 0.5, rnd() * Math.PI * 2, -0.25 + rnd() * 0.5);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, rnd() < 0.7 ? yellow : white);
    n++;
  }
  mesh.count = n;
  mesh.frustumCulled = false;
  return mesh;
}

export function createGround({ blades = 60000, flowers = 900 } = {}) {
  const group = new THREE.Group();
  const hill = createHill();
  const grass = createGrass(blades);
  group.add(hill, grass, createFlowers(flowers));
  const fullCount = grass.geometry.instanceCount;
  group.userData.setDensity = (f) => {
    grass.geometry.instanceCount = Math.round(fullCount * f); // blades are stored in random order
  };
  group.userData.update = (t) => {
    grass.material.uniforms.uTime.value = t;
  };
  return group;
}
