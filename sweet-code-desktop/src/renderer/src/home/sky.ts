import * as THREE from "three";

// A Makoto Shinkai style sky: deep blue zenith, glowing horizon, towering cumulus with
// blue-lavender shadows and golden silver linings, thin cirrus and a sea of clouds
// below the horizon. The clouds are ray-marched through a tiling 3D noise texture, and
// their light/shadow edge is sharpened into anime-like bands ("2.5D": real volume,
// painted look). Rendered at reduced resolution into a texture used as the background.

const NOISE_SIZE = 64;
/** Sky resolution relative to the canvas' CSS size. Clouds are soft, so half is plenty. */
const SCALE = 0.5;
/**
 * The sky is drawn tilted up from the stage camera (radians). It sits at infinity and the
 * stage floats, so nothing has to line up: this puts the horizon low, about two thirds down,
 * leaving most of the frame to blue sky and towering clouds, the way the films compose it.
 */
const SKY_PITCH = 0.2;

let noiseCache: THREE.Data3DTexture | null = null;

/** Tiling Perlin-Worley-ish noise: billowy Worley cells mixed with smooth value noise. */
export function cloudNoise(): THREE.Data3DTexture {
  if (noiseCache) return noiseCache;
  const N = NOISE_SIZE;
  let seed = 1337;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const wrap = (i: number, f: number) => ((i % f) + f) % f;

  // One random feature point per cell, per frequency; wrapping makes the texture tile.
  const worley = (f: number) => {
    const pts = Float32Array.from({ length: f * f * f * 3 }, rand);
    return (x: number, y: number, z: number) => {
      const cx = Math.floor(x * f), cy = Math.floor(y * f), cz = Math.floor(z * f);
      let best = 9;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const i = (wrap(cx + dx, f) + wrap(cy + dy, f) * f + wrap(cz + dz, f) * f * f) * 3;
            const px = (cx + dx + pts[i]) / f - x, py = (cy + dy + pts[i + 1]) / f - y, pz = (cz + dz + pts[i + 2]) / f - z;
            best = Math.min(best, px * px + py * py + pz * pz);
          }
      return Math.min(Math.sqrt(best) * f, 1);
    };
  };
  const value = (f: number) => {
    const g = Float32Array.from({ length: f * f * f }, rand);
    const at = (x: number, y: number, z: number) => g[wrap(x, f) + wrap(y, f) * f + wrap(z, f) * f * f];
    const s = (t: number) => t * t * (3 - 2 * t);
    return (x: number, y: number, z: number) => {
      const fx = x * f, fy = y * f, fz = z * f;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const ux = s(fx - ix), uy = s(fy - iy), uz = s(fz - iz);
      const l = (a: number, b: number, t: number) => a + (b - a) * t;
      return l(
        l(l(at(ix, iy, iz), at(ix + 1, iy, iz), ux), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), ux), uy),
        l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), ux), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), ux), uy),
        uz,
      );
    };
  };
  const w = [worley(4), worley(8), worley(16)];
  const v = [value(4), value(8), value(16), value(32)];

  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const px = x / N, py = y / N, pz = z / N;
        const billow = 1 - (w[0](px, py, pz) * 0.625 + w[1](px, py, pz) * 0.25 + w[2](px, py, pz) * 0.125);
        const smooth = (v[0](px, py, pz) * 0.5 + v[1](px, py, pz) * 0.25 + v[2](px, py, pz) * 0.125 + v[3](px, py, pz) * 0.0625) / 0.9375;
        const n = Math.min(Math.max((billow * 0.7 + smooth * 0.3 - 0.15) * 1.35, 0), 1);
        data[x + y * N + z * N * N] = Math.round(n * 255);
      }

  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  noiseCache = tex;
  return tex;
}

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

uniform sampler3D uNoise;
uniform float uTime;
uniform float uDusk;
uniform vec3 uSun;
uniform vec3 uOrigin;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;

const float BASE = 1.2;
const float TOP = 5.4;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 pick(vec3 day, vec3 dusk) { return mix(day, dusk, uDusk); }

vec3 sunColor() { return pick(vec3(1.0, 0.93, 0.80), vec3(1.0, 0.62, 0.36)); }

vec3 skyColor(vec3 d) {
  float e = d.y;
  vec3 zen = pick(vec3(0.07, 0.27, 0.78), vec3(0.09, 0.08, 0.29));
  vec3 mid = pick(vec3(0.26, 0.58, 0.97), vec3(0.47, 0.27, 0.60));
  vec3 hor = pick(vec3(0.80, 0.92, 1.00), vec3(1.00, 0.60, 0.50));
  vec3 c = mix(hor, mid, smoothstep(-0.02, 0.22, e));
  c = mix(c, zen, smoothstep(0.2, 0.9, e));
  float s = max(dot(d, uSun), 0.0);
  vec3 sc = sunColor();
  c += sc * (pow(s, 5.0) * 0.22 + pow(s, 40.0) * 0.45);
  // Warm band along the horizon on the sun's side.
  c += sc * 0.18 * pow(s, 2.0) * (1.0 - smoothstep(0.0, 0.35, abs(e)));
  // Dusk: stars fade in high up.
  if (uDusk > 0.0 && e > 0.05) {
    vec2 sp = vec2(atan(d.z, d.x), asin(clamp(e, -1.0, 1.0))) * 110.0;
    vec2 cell = floor(sp);
    float h = hash12(cell);
    float star = step(0.986, h) * smoothstep(0.32, 0.0, length(fract(sp) - 0.5));
    star *= 0.6 + 0.4 * sin(uTime * 2.5 + h * 60.0);
    c += vec3(1.0, 0.95, 0.9) * star * smoothstep(0.12, 0.5, e) * uDusk;
  }
  return c;
}

// The baked noise spans about 0.26..0.65 (measured); stretch it to 0..1 so thresholds mean what they say.
float N(vec3 p) { return clamp((texture(uNoise, p).r - 0.26) / 0.39, 0.0, 1.0); }

float density(vec3 p) {
  vec3 wind = vec3(uTime * 0.035, 0.0, uTime * 0.012);
  float h = (p.y - BASE) / (TOP - BASE);
  // Big clusters first, so the sky keeps open blue gaps between cloud masses (about a third covered).
  float cover = smoothstep(0.4, 0.75, N(vec3(p.xz * 0.028 + wind.xz * 0.2, 0.37)));
  // Thicker clusters tower higher, like summer cumulonimbus.
  float topH = mix(0.3, 1.0, cover);
  float prof = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(topH * 0.55, topH, h));
  // Billows: dense cores inside clusters, thin wisps at their edges.
  float d = smoothstep(0.35, 0.65, cover * prof * (0.25 + N(p * 0.085 + wind)));
  float detail = N(p * 0.31 + wind * 2.0);
  return clamp(d - (1.0 - detail) * 0.25 * (1.0 - d * 0.6), 0.0, 1.0);
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5) / 12.566;
}

vec4 clouds(vec3 o, vec3 d, vec3 sky) {
  if (d.y < 0.012) return vec4(0.0);
  float t0 = (BASE - o.y) / d.y;
  if (t0 > 80.0) return vec4(0.0);
  float t1 = min((TOP - o.y) / d.y, t0 + 18.0);
  const int STEPS = 48;
  float dt = (t1 - t0) / float(STEPS);
  float t = t0 + dt * hash12(gl_FragCoord.xy + fract(uTime) * 61.0);
  float cosT = dot(d, uSun);
  float phase = mix(hg(cosT, 0.65), hg(cosT, -0.25), 0.35);
  vec3 sc = sunColor();
  vec3 shadowBase = pick(vec3(0.55, 0.64, 0.90), vec3(0.50, 0.36, 0.64));
  vec3 litC = pick(vec3(1.0, 0.985, 0.95), vec3(1.0, 0.80, 0.66));
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = o + d * t;
    float den = density(p);
    if (den > 0.01) {
      float ld = 0.0;
      for (int j = 1; j <= 3; j++) ld += density(p + uSun * (0.32 * float(j)));
      float trans = exp(-ld * 1.5);
      // Anime terminator: mostly a crisp band, a little of the soft gradient kept.
      float lit = mix(trans, smoothstep(0.18, 0.48, trans), 0.7);
      float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
      vec3 c = mix(shadowBase * (0.78 + 0.32 * h), litC, lit);
      // Silver lining: thin edges facing the backlight glow gold.
      c += sc * phase * trans * (1.0 - den) * 2.2;
      c *= mix(0.86, 1.0, 1.0 - exp(-den * 3.0));
      c = mix(c, sky, (1.0 - exp(-t * 0.022)) * 0.85);
      float a = 1.0 - exp(-den * dt * 2.4);
      col += T * a * c;
      T *= 1.0 - a;
      if (T < 0.03) break;
    }
    t += dt;
  }
  return vec4(col, 1.0 - T);
}

void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 o = uOrigin;
  vec3 sky = skyColor(d);
  vec3 sc = sunColor();

  if (d.y > 0.0) {
    // High cirrus: long thin streaks on a plane far above.
    float tc = (11.0 - o.y) / d.y;
    vec2 q = (o + d * tc).xz * 0.012;
    float n = N(vec3(q.x * 0.5 + uTime * 0.002, 0.71, q.y * 3.5));
    float streak = smoothstep(0.6, 0.9, n) * 0.4 * smoothstep(0.03, 0.25, d.y);
    sky = mix(sky, pick(vec3(0.97, 0.98, 1.0), vec3(1.0, 0.78, 0.74)), streak);
    vec4 cl = clouds(o, d, sky);
    sky = sky * (1.0 - cl.a) + cl.rgb;
  } else {
    // Sea of clouds below the horizon, lit from above.
    float tp = (-1.4 - o.y) / d.y;
    vec2 q = (o + d * tp).xz * 0.07 + vec2(uTime * 0.01, 0.0);
    float tops = smoothstep(0.35, 0.75, N(vec3(q, 0.5)));
    vec3 sea = mix(pick(vec3(0.66, 0.74, 0.94), vec3(0.56, 0.42, 0.66)), pick(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.80, 0.70)), tops);
    sky = mix(sea, sky, exp(-tp * 0.05));
  }

  // Sun glare on top of everything, the way it blooms through a lens.
  float s = max(dot(d, uSun), 0.0);
  sky += sc * (smoothstep(0.9994, 0.9998, s) * 1.5 + pow(s, 900.0) * 0.8);
  outColor = vec4(sky, 1.0);
}`;

export class ShinkaiSky {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.Camera();
  private readonly material: THREE.ShaderMaterial;
  private readonly tilt = new THREE.Matrix4().makeRotationX(SKY_PITCH);

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
    // The shader writes display colors; marking the texture sRGB makes the background pass show them as-is.
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uNoise: { value: cloudNoise() },
        uTime: { value: 0 },
        uDusk: { value: 0 },
        uSun: { value: new THREE.Vector3() },
        uOrigin: { value: new THREE.Vector3() },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /** Day sky for light mode, dusk with stars for dark mode. */
  setDusk(dusk: boolean): void {
    this.material.uniforms.uDusk.value = dusk ? 1 : 0;
    // The sun hangs behind the stage, upper left: backlit clouds, Shinkai's favorite angle.
    (this.material.uniforms.uSun.value as THREE.Vector3)
      .set(-0.3, dusk ? 0.06 : 0.3, -0.9)
      .normalize();
  }

  /** Haze color at the horizon, for fogging distant cards into the sky. */
  horizon(dusk: boolean): THREE.Color {
    return new THREE.Color(dusk ? "#f0a090" : "#cfe6ff");
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.target.setSize(Math.max(1, Math.round(cssWidth * SCALE)), Math.max(1, Math.round(cssHeight * SCALE)));
  }

  render(camera: THREE.PerspectiveCamera, time: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    // Rotation only: the sky is at infinity, the camera position feeds a gentle parallax below.
    (u.uCamWorld.value as THREE.Matrix4).extractRotation(camera.matrixWorld).multiply(this.tilt);
    (u.uOrigin.value as THREE.Vector3).set(camera.position.x * 0.6, 0, camera.position.z * 0.2);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}
