import '@fontsource/anton/latin-400.css';
import './style.css';
import * as THREE from 'three';
import { createBackdrop, createEnvironment, SKY } from './background.js';
import { createGround } from './ground.js';
import { loadToothGeometry, createGlass } from './tooth.js';

const qs = new URLSearchParams(location.search);
const CLAY = qs.has('clay'); // matte material to judge the shape
const STILL = qs.has('still'); // freeze animation (screenshots)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- text reveal ----------
document.fonts.ready.then(() => requestAnimationFrame(() => document.body.classList.add('is-ready')));

// ---------- renderer / scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// ACES rolls bright glass highlights off instead of clipping them to flat white.
// Only the glass is tone-mapped: backdrop, hill, grass and flowers opt out (toneMapped: false).
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8; // ACES lifts mid-tones; 0.8 keeps the refracted sky as blue as the backdrop

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 300);
const mobile = matchMedia('(max-width: 760px)');

const TOOTH_H = 1;
const SINK = 0.045; // root tips this far below the turf
const EYE = 0.44; // camera height: horizon at the lower third of the tooth → heroic, looking slightly up
const YAW0 = THREE.MathUtils.degToRad(qs.get('yaw') ? Number(qs.get('yaw')) : 12);
const SWAY = THREE.MathUtils.degToRad(15);
const PERIOD = 8;

const skyTex = await new THREE.TextureLoader().loadAsync(mobile.matches ? '/bg/sky-sm.jpg' : '/bg/sky.jpg');
skyTex.colorSpace = THREE.SRGBColorSpace;
skyTex.anisotropy = 4;
skyTex.generateMipmaps = true;
skyTex.minFilter = THREE.LinearMipmapLinearFilter;

// on a narrow portrait screen only a sliver of the panorama shows: put blue sky behind the headline
if (mobile.matches) SKY.azim = 13;
const env = createEnvironment(renderer, skyTex);
scene.environment = env;
const backdrop = createBackdrop(skyTex);
scene.add(backdrop);
const ground = createGround({ blades: mobile.matches ? 38000 : 60000 });
scene.add(ground);
scene.add(new THREE.HemisphereLight('#dcecff', '#4d7a2a', 0.6));

const tooth = new THREE.Group();
const pivot = new THREE.Group(); // rotates around the root base so the roots stay planted
tooth.add(pivot);
scene.add(tooth);
const geometry = await loadToothGeometry('/models/tooth.bin');
const glass = new THREE.Mesh(geometry, createGlass(env, { clay: CLAY, chrome: qs.has('chrome') }));
glass.scale.setScalar(TOOTH_H);
pivot.add(glass);
tooth.position.set(0, -SINK, 0);

// ---------- adaptive quality ----------
// The glass costs most: three.js re-renders the opaque scene into a transmission buffer, and a
// double-sided glass adds a back-face pass. Start at full quality and step down once if the
// first ~60 frames are slow (integrated GPUs). Force a level with ?q=0|1|2.
const QUALITY = [
  { tscale: 1, side: THREE.DoubleSide, pr: 2, disp: 0.04, grass: 1 },
  { tscale: 0.6, side: THREE.DoubleSide, pr: 1.5, disp: 0.04, grass: 1 },
  { tscale: 0.5, side: THREE.FrontSide, pr: 1, disp: 0, grass: 0.6 },
];
let level = -1;
let laidOut = false; // layout() needs the framing state below
function setQuality(l) {
  level = Math.min(l, QUALITY.length - 1);
  const q = QUALITY[level];
  renderer.transmissionResolutionScale = q.tscale;
  if (!CLAY) glass.material.dispersion = q.disp;
  if (!CLAY && !qs.has('chrome')) glass.material.iridescence = level < 2 ? 0.1 : 0;
  ground.userData.setDensity(q.grass);
  window.__quality = level;
  if (glass.material.side !== q.side) {
    glass.material.side = q.side;
    glass.material.needsUpdate = true;
  }
  const pr = Math.min(devicePixelRatio, q.pr);
  if (renderer.getPixelRatio() !== pr) {
    renderer.setPixelRatio(pr);
    if (laidOut) layout();
  }
}
const FORCED = qs.has('q') ? Number(qs.get('q')) : null;
setQuality(FORCED ?? 0);
const perf = { frames: 0, time: 0 };
function watchPerf(dt) {
  if (FORCED !== null || level >= QUALITY.length - 1) return;
  perf.frames++;
  if (perf.frames <= 20) return; // skip warm-up (shader compile, uploads)
  perf.time += dt;
  if (perf.frames < 80) return;
  const fps = 60 / perf.time;
  perf.frames = 0;
  perf.time = 0;
  if (fps < 40) setQuality(level + 1);
}

// ---------- framing: fit the tooth into the .tooth-slot box ----------
const slot = document.querySelector('.tooth-slot');
const base = new THREE.Vector3();
let dist = 3;
function layout() {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  const r = slot.getBoundingClientRect();
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // the visible tooth (above the turf) spans the slot height
  const visibleH = TOOTH_H - SINK;
  dist = (visibleH * H) / (r.height * 2 * t);
  base.set(0, EYE, dist);
  // shift the principal point so the tooth's centre lands on the slot's centre
  const cy = visibleH / 2;
  const ndcX = ((r.left + r.width / 2) / W) * 2 - 1;
  const ndcY = 1 - ((r.top + r.height / 2) / H) * 2;
  const offX = ndcX;
  const offY = ndcY - (cy - EYE) / (dist * t);
  camera.projectionMatrix.elements[8] = -offX;
  camera.projectionMatrix.elements[9] = -offY;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  backdrop.userData.bake(renderer, camera);
}
layout();
laidOut = true;
addEventListener('resize', layout);
mobile.addEventListener('change', layout);

// ---------- pointer parallax ----------
const pointer = new THREE.Vector2();
const eased = new THREE.Vector2();
addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
});

// ---------- loop ----------
const clock = new THREE.Timer();
let running = true;
document.addEventListener('visibilitychange', () => {
  running = !document.hidden;
  if (running) {
    requestAnimationFrame(frame);
  }
});

function frame() {
  if (!running) return;
  clock.update();
  const raw = clock.getDelta();
  watchPerf(raw);
  const dt = Math.min(raw, 0.05);
  const t = STILL ? 0 : clock.getElapsed();
  const anim = !(STILL || reduceMotion);
  const k = 1 - Math.exp(-dt * 3);
  eased.lerp(pointer, anim ? k : 1);

  // camera drifts a little with the pointer (orientation fixed → sky stays put, tooth shifts)
  camera.position.set(base.x - eased.x * 0.06 * dist, base.y + eased.y * 0.025 * dist, base.z);
  camera.updateMatrixWorld();

  // slow sway around Y (±15°, 8 s) + a gentle rock, pivoting at the roots
  const ph = (t / PERIOD) * Math.PI * 2;
  pivot.rotation.y = YAW0 + (anim ? Math.sin(ph) * SWAY : 0) + eased.x * 0.12;
  pivot.rotation.z = anim ? Math.sin(ph * 0.5 + 1.1) * 0.018 : 0;
  pivot.rotation.x = 0.05 + (anim ? Math.sin(ph + 0.6) * 0.012 : 0) + eased.y * 0.03;

  ground.userData.update(t);
  renderer.render(scene, camera);
  window.__frames = (window.__frames || 0) + 1; // read by the screenshot script
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
