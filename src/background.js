import * as THREE from 'three';

/**
 * One background function — bgColor(direction) — drives both:
 *  1. the visible backdrop (a full-screen pass behind everything, so the glass refracts it), and
 *  2. the equirect environment for reflections (same sky, plus a few HDR softboxes),
 * so what you see through the tooth and what it reflects always match.
 *
 * Sky = cropped photo (clouds), mapped by view angles; mountains = two procedural ridges,
 * deliberately soft-edged (they read as out-of-focus distance).
 */

export const PALETTE = {
  zenith: '#1f6fd6',
  haze: '#cfe2f2',
  far: '#8fb0d2',
  near: '#6a8fac',
  valley: '#8db872',
  ground: '#4f8a2a',
};

/** Where the photo sits around the viewer (degrees). main.js may change azim before creating. */
export const SKY = { azim: -6, span: 78, elev0: -1.5 };

const glslBackground = /* glsl */ `
  uniform sampler2D uSky;
  uniform float uSkyAspect;
  uniform float uSpanX;
  uniform float uAzim0;
  uniform float uElev0;
  uniform vec3 uZenith;
  uniform vec3 uHaze;
  uniform vec3 uFar;
  uniform vec3 uNear;
  uniform vec3 uValley;
  uniform vec3 uGround;

  #define DEG 0.01745329

  float hash1(float n) { return fract(sin(n) * 43758.5453123); }
  float noise1(float x) {
    float i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash1(i), hash1(i + 1.0), f);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash1(dot(i, vec2(1.0, 57.0)));
    float b = hash1(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
    float c = hash1(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
    float d = hash1(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float ridge(float x) {
    float s = 0.0, a = 0.55;
    for (int i = 0; i < 5; i++) {
      float n = noise1(x);
      s += a * (1.0 - abs(2.0 * n - 1.0));
      x *= 2.07;
      a *= 0.47;
    }
    return s;
  }

  vec3 skyPhoto(float az, float el) {
    float spanY = uSpanX / uSkyAspect;
    float u = 0.5 + (az - uAzim0) / uSpanX;
    u = 1.0 - abs(mod(u, 2.0) - 1.0); // mirrored repeat → seamless all the way round
    float v = (el - uElev0) / spanY;
    vec3 c = texture2D(uSky, vec2(u, clamp(v, 0.002, 0.995))).rgb;
    return mix(c, uZenith, smoothstep(0.88, 1.3, v));
  }

  vec3 bgColor(vec3 dir) {
    float el = asin(clamp(dir.y, -1.0, 1.0));
    float az = atan(dir.x, -dir.z);
    vec3 col = skyPhoto(az, el);
    // horizon haze
    col = mix(col, uHaze, smoothstep(5.0 * DEG, -0.5 * DEG, el) * 0.3);

    // far range: tall, pale, very soft edge
    float m1 = (0.4 + 3.4 * ridge(az * 3.1 + 1.7)) * DEG;
    float a1 = smoothstep(m1 + 0.45 * DEG, m1 - 0.35 * DEG, el);
    vec3 c1 = mix(uFar, uHaze, smoothstep(m1, -1.0 * DEG, el) * 0.4);
    col = mix(col, c1, a1 * 0.92);

    // nearer range: lower, a bit darker and greener at the foot
    float m2 = (-0.3 + 2.2 * ridge(az * 5.3 + 8.3)) * DEG;
    float a2 = smoothstep(m2 + 0.3 * DEG, m2 - 0.25 * DEG, el);
    vec3 c2 = mix(uNear, uValley, smoothstep(m2 - 0.5 * DEG, -2.5 * DEG, el) * 0.7);
    c2 = mix(c2, uHaze, 0.12);
    col = mix(col, c2, a2);

    // below the horizon: an out-of-focus valley — layered foothills, field patches, tree lines
    float g = smoothstep(-0.6 * DEG, -2.0 * DEG, el);
    vec3 land = mix(mix(uValley, uHaze, 0.3), uGround, smoothstep(-3.0 * DEG, -25.0 * DEG, el));
    col = mix(col, land, g);
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float near = fi / 5.0;
      float top = (-0.8 - fi * 1.25 + (1.1 + near * 0.8) * ridge(az * (1.8 + fi * 0.7) + 21.0 + fi * 13.7)) * DEG;
      float a = smoothstep(top + 0.3 * DEG, top - 0.3 * DEG, el);
      vec3 c = mix(mix(uValley, uHaze, 0.32 - near * 0.3), uGround, near * 0.7);
      c *= mod(fi, 2.0) < 1.0 ? 0.95 : 1.05;
      // field patches (soft, defocused) …
      float pt = noise2(vec2(az * (18.0 + fi * 6.0) + fi * 7.0, el * 70.0));
      c *= 0.92 + 0.14 * pt;
      // … and a darker band of trees along each crest
      float trees = smoothstep(1.4 * DEG, 0.1 * DEG, top - el) * (0.35 + 0.65 * noise1(az * 45.0 + fi * 5.0));
      c = mix(c, c * vec3(0.72, 0.8, 0.78), trees * (0.55 - near * 0.2));
      col = mix(col, c, a);
    }
    return col;
  }
`;

function uniforms(skyTex) {
  return {
    uSky: { value: skyTex },
    uSkyAspect: { value: skyTex.image ? skyTex.image.width / skyTex.image.height : 2.08 },
    uSpanX: { value: THREE.MathUtils.degToRad(SKY.span) },
    uAzim0: { value: THREE.MathUtils.degToRad(SKY.azim) },
    uElev0: { value: THREE.MathUtils.degToRad(SKY.elev0) },
    uZenith: { value: new THREE.Color(PALETTE.zenith) },
    uHaze: { value: new THREE.Color(PALETTE.haze) },
    uFar: { value: new THREE.Color(PALETTE.far) },
    uNear: { value: new THREE.Color(PALETTE.near) },
    uValley: { value: new THREE.Color(PALETTE.valley) },
    uGround: { value: new THREE.Color(PALETTE.ground) },
  };
}

/** Full-screen backdrop rendered first; it is an ordinary opaque mesh, so the
 *  transmission pass of the glass sees (and refracts) it. */
export function createBackdrop(skyTex) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const vertexShader = /* glsl */ `
    varying vec2 vNdc;
    void main() {
      vNdc = position.xy;
      gl_Position = vec4(position.xy, 1.0, 1.0);
    }
  `;
  // The backdrop depends only on view direction, and the camera never rotates (parallax just
  // translates it), so the expensive shader is baked once per resize into a screen-sized
  // texture; every frame (and the glass's transmission pass) only copies it.
  const bakeMat = new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms(skyTex),
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
    },
    vertexShader,
    fragmentShader: /* glsl */ `
      ${glslBackground}
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      varying vec2 vNdc;
      void main() {
        vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
        vec3 dir = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
        gl_FragColor = vec4(bgColor(dir), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const blitMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: rt.texture } },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vNdc;
      void main() {
        gl_FragColor = texture2D(uMap, vNdc * 0.5 + 0.5);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, blitMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  const bakeScene = new THREE.Scene();
  const bakeQuad = new THREE.Mesh(geo, bakeMat);
  bakeQuad.frustumCulled = false;
  bakeScene.add(bakeQuad);
  const orient = new THREE.Matrix4();
  /** Call after the camera's projection changes (resize / layout). */
  mesh.userData.bake = (renderer, camera) => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    rt.setSize(size.x, size.y);
    bakeMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    // rotation only: translation doesn't change directions to an infinitely far backdrop
    orient.extractRotation(camera.matrixWorld);
    bakeMat.uniforms.uCamWorld.value.copy(orient);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, camera);
    renderer.setRenderTarget(prev);
  };
  return mesh;
}

/**
 * Equirect environment from the same bgColor(), plus HDR light shapes that give the glass
 * its bright edge streaks: a sun behind the viewer's left shoulder and two tall softboxes.
 */
export function createEnvironment(renderer, skyTex) {
  const W = 1024, H = 512;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms(skyTex),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      ${glslBackground}
      varying vec2 vUv;
      float box(float az, float el, float az0, float w, float e0, float e1) {
        float da = abs(atan(sin(az - az0), cos(az - az0)));
        return smoothstep(w, w * 0.55, da) * smoothstep(e0, e0 + 0.08, el) * smoothstep(e1, e1 - 0.08, el);
      }
      void main() {
        float phi = (vUv.x - 0.5) * 6.2831853;
        float lat = (vUv.y - 0.5) * 3.1415927;
        vec3 dir = vec3(cos(lat) * cos(phi), sin(lat), cos(lat) * sin(phi));
        vec3 col = bgColor(dir);
        float az = atan(dir.x, -dir.z);
        float el = lat;
        // sun: up-left behind the camera (the photo is lit from the upper left)
        vec3 sun = normalize(vec3(-0.55, 0.62, 0.56));
        float s = max(dot(dir, sun), 0.0);
        col += vec3(1.0, 0.95, 0.86) * (pow(s, 900.0) * 60.0 + pow(s, 24.0) * 0.9);
        // tall softboxes behind the camera, left & right → long vertical streaks on the glass
        col += vec3(1.0) * 3.2 * box(az, el, 2.55, 0.16, -0.05, 0.95);
        col += vec3(0.92, 0.96, 1.0) * 2.0 * box(az, el, -2.45, 0.11, 0.05, 0.85);
        // rim lights at the sides → bright outlines
        col += vec3(1.0) * 1.6 * box(az, el, 1.45, 0.12, -0.1, 0.7);
        col += vec3(1.0) * 1.2 * box(az, el, -1.5, 0.1, 0.0, 0.6);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  rt.texture.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(rt.texture).texture;
  pmrem.dispose();
  rt.dispose();
  mat.dispose();
  quad.geometry.dispose();
  return env;
}
