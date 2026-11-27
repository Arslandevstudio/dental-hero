import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Loads the procedural molar (scripts/build-tooth.mjs): H = 1, root tips at y = 0.
 * Format 'TTH2': u32 nVerts, u32 nIdx, f32 min[3], f32 max[3], u16 positions, u32 indices.
 */
export async function loadToothGeometry(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'TTH2') throw new Error(`tooth.bin: unexpected format "${magic}"`);
  const dv = new DataView(buf);
  const nV = dv.getUint32(4, true), nI = dv.getUint32(8, true);
  const min = [0, 1, 2].map((k) => dv.getFloat32(12 + k * 4, true));
  const max = [0, 1, 2].map((k) => dv.getFloat32(24 + k * 4, true));
  const head = 36;
  const q = new Uint16Array(buf, head, nV * 3);
  const posBytes = Math.ceil((nV * 6) / 4) * 4;
  const idx = new Uint32Array(buf, head + posBytes, nI);
  const pos = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) {
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = min[k] + (q[i * 3 + k] / 65535) * (max[k] - min[k]);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // shared vertices are what make computeVertexNormals() average across faces (smooth shading)
  g = mergeVertices(g, 1e-6);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Thick clear glass (values carried over from the AQ TIS scene, mapped onto MeshPhysicalMaterial). */
export function createGlass(envMap, { clay = false, chrome = false } = {}) {
  // ?chrome: mirror finish — exposes any ripple in the normals
  if (chrome) return new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.03, envMap, flatShading: false });
  if (clay) return new THREE.MeshStandardMaterial({ color: '#e9e6e0', roughness: 0.5, envMap, envMapIntensity: 0.9, flatShading: false });
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    metalness: 0,
    roughness: 0.05, // a touch of blur in the refraction softens hard internal edges
    transmission: 1,
    thickness: 0.9,
    ior: 1.45,
    attenuationColor: new THREE.Color('#e3f2ff'),
    attenuationDistance: 2.2,
    dispersion: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.1, // soft, wide edge sheen instead of a hairline
    iridescence: 0.1, // faint; switched off on the lowest quality tier (≈5 fps on integrated GPUs)
    iridescenceIOR: 1.3,
    iridescenceThicknessMinimum: 200,
    iridescenceThicknessMaximum: 400,
    specularIntensity: 1,
    specularColor: new THREE.Color('#ffffff'),
    envMap,
    envMapIntensity: 1.25,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  // Soft Fresnel edge: towards the silhouette (grazing view) the refraction offset fades out,
  // so the glass melts into the backdrop instead of ending on a hard refracted seam.
  glass.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <transmission_fragment>',
      THREE.ShaderChunk.transmission_fragment.replace(
        'vec4 transmitted = getIBLVolumeRefraction(',
        'material.thickness *= mix(0.15, 1.0, smoothstep(0.0, 0.5, abs(dot(n, v))));\n\tvec4 transmitted = getIBLVolumeRefraction(',
      ),
    );
  };
  glass.customProgramCacheKey = () => 'tooth-soft-fresnel';
  return glass;
}
