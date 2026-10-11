import * as THREE from "three/webgpu";
import {
  Fn,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from "three/tsl";

// The opening scene: a dusk sea, a whale that breaches and dives, and the spray gathering into the
// sikeoop heart. The water follows the approach of real-time ocean kits like Tidewater, cut down
// to what a two-second shot needs: summed Gerstner waves with analytic normals, foam where the
// surface is compressed (the Jacobian), Fresnel-weighted sky reflection, a crest scatter tint, and
// ring waves where the whale breaks the surface. Rendered with three's node materials (TSL), on
// WebGPU when the machine has it and WebGL2 otherwise.

// TSL node types are too strict for building sums in a loop; the shader compiler checks the graph.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V3 = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type F = any;

/** Seconds; the shot is driven by the caller's clock, not wall time, so it can't drift. */
export const SHOT = {
  whaleIn: 0.1,
  whaleOut: 0.85,
  gather: 0.9,
  formed: 1.3,
  end: 1.55,
};

const WAVES = [
  { dir: [1, 0.25], len: 7.5, steep: 0.28 },
  { dir: [0.55, 1], len: 4.4, steep: 0.24 },
  { dir: [-0.75, 0.55], len: 2.7, steep: 0.2 },
  { dir: [0.2, -1], len: 1.7, steep: 0.16 },
  { dir: [-0.4, -0.9], len: 1.1, steep: 0.12 },
];

const SUN = new THREE.Vector3(0.32, 0.035, -1).normalize();

/** Dusk sky along a direction: deep navy overhead, a thin violet-to-pink band at the horizon, the low sun. */
const skyBase = Fn(([dir]: [V3]) => {
  const y = dir.y;
  const top = vec3(0.01, 0.012, 0.045);
  const mid = vec3(0.075, 0.03, 0.115);
  const low = vec3(0.6, 0.24, 0.36);
  const up = mix(mid, top, smoothstep(0.05, 0.45, y));
  // Output goes through sRGB encoding, which lifts darks a lot: keep the gradient low.
  const col = mix(low, up, smoothstep(-0.01, 0.13, y)).mul(0.4).toVar();
  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const s = max(dot(dir, sun), 0);
  col.addAssign(vec3(1, 0.5, 0.58).mul(pow(s, 32).mul(0.22)));
  col.addAssign(vec3(1, 0.86, 0.82).mul(pow(s, 2600).mul(2.2)));
  return col;
});

/** The sky dome adds a few stars; reflections leave them out (they'd smear into streaks). */
const sky = Fn(([dir]: [V3]) => {
  const y = dir.y;
  const cell: V3 = floor(dir.xz.div(max(y, 0.05)).mul(70));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  return skyBase(dir).add(vec3(0.9, 0.85, 1).mul(step(0.996, h).mul(smoothstep(0.25, 0.6, y)).mul(0.7)));
});

export interface Ocean {
  /** Draw the shot at time t (seconds). */
  render(t: number): void;
  resize(): void;
  dispose(): void;
  backend: "webgpu" | "webgl";
}

export async function createOcean(canvas: HTMLCanvasElement, whaleSvg: string): Promise<Ocean> {
  // Development: ?webgl tries the WebGL2 fallback that machines without WebGPU get.
  const forceWebGL = import.meta.env.DEV && new URLSearchParams(location.search).has("webgl");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
  camera.position.set(0, 0.95, 9);
  camera.lookAt(0, 0.8, 0);

  // ---- sky dome
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  skyMat.colorNode = sky(normalize(positionWorld.sub(cameraPosition)));
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), skyMat);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);

  // ---- water
  const uT = uniform(0);
  // Ring waves where the whale leaves and re-enters: (x, z, start time, strength).
  const ripples = [uniform(new THREE.Vector4(0, 0, -99, 0)), uniform(new THREE.Vector4(0, 0, -99, 0))];

  const p = positionLocal.xz;
  let dx: F = float(0);
  let dz: F = float(0);
  let dy: F = float(0);
  let nx: F = float(0);
  let nz: F = float(0);
  let ny: F = float(1);
  let jac: F = float(1);
  for (const w of WAVES) {
    const len = Math.hypot(w.dir[0], w.dir[1]);
    const d = [w.dir[0] / len, w.dir[1] / len];
    const k = (2 * Math.PI) / w.len;
    const c = Math.sqrt(9.8 / k) * 0.75;
    const a = (w.steep / k) * 0.42;
    const f = dot(p, vec2(d[0], d[1])).sub(uT.mul(c)).mul(k);
    const cf = cos(f);
    const sf = sin(f);
    dx = dx.add(cf.mul(a * d[0]));
    dz = dz.add(cf.mul(a * d[1]));
    dy = dy.add(sf.mul(a));
    nx = nx.sub(cf.mul(k * a * d[0]));
    nz = nz.sub(cf.mul(k * a * d[1]));
    ny = ny.sub(sf.mul(k * a));
    jac = jac.sub(sf.mul(k * a));
  }
  let foam: F = smoothstep(0.62, 0.3, jac).mul(0.55);
  for (const r of ripples) {
    const off = p.sub(vec2(r.x, r.y));
    const dist = length(off);
    const age = uT.sub(r.z);
    const alive = step(0, age);
    const front = age.mul(3.4);
    const inside = smoothstep(front.add(0.35), front.sub(0.5), dist);
    const env = exp(age.mul(-1.5)).mul(exp(dist.mul(-0.32))).mul(r.w).mul(alive).mul(inside);
    const phase = dist.mul(5.5).sub(age.mul(15));
    dy = dy.add(sin(phase).mul(env).mul(0.22));
    const slope = cos(phase).mul(env).mul(0.22 * 5.5);
    const dir2 = off.div(max(dist, 0.001));
    nx = nx.sub(dir2.x.mul(slope));
    nz = nz.sub(dir2.y.mul(slope));
    foam = foam.add(env.mul(smoothstep(0.6, 1, sin(phase))).mul(0.35));
    // A ring of white right at the splash.
    foam = foam.add(r.w.mul(alive).mul(exp(age.mul(-3.5))).mul(smoothstep(0.7, 0.15, dist)).mul(0.6));
  }

  const waterMat = new THREE.MeshBasicNodeMaterial();
  waterMat.positionNode = positionLocal.add(vec3(dx, dy, dz));
  const vNormal = varying(vec3(nx, ny, nz));
  const vFoam = varying(clamp(foam, 0, 1));
  const vHeight: F = varying(dy);
  waterMat.colorNode = Fn(() => {
    const n = normalize(vNormal);
    const v = normalize(cameraPosition.sub(positionWorld));
    const fres = float(0.02).add(pow(float(1).sub(max(dot(n, v), 0)), 5).mul(0.98));
    const r = reflect(v.negate(), n).toVar();
    r.y.assign(max(r.y, 0.01));
    const deep = vec3(0.002, 0.004, 0.012);
    // Light through thin crests, tinted toward the sky's pink.
    const scatter = vec3(0.5, 0.16, 0.32).mul(smoothstep(0.0, 0.2, vHeight).mul(0.22));
    const col = mix(deep.add(scatter), skyBase(r), fres.mul(0.85)).toVar();
    const sun = vec3(SUN.x, SUN.y, SUN.z);
    col.addAssign(vec3(1, 0.8, 0.78).mul(pow(max(dot(r, sun), 0), 420).mul(2.2)));
    col.assign(mix(col, vec3(0.75, 0.68, 0.76), vFoam.mul(0.7)));
    // Into the haze toward the horizon.
    const far = length(positionWorld.xz.sub(cameraPosition.xz));
    return mix(col, vec3(0.6, 0.24, 0.36).mul(0.4), smoothstep(16, 65, far));
  })();
  const water = new THREE.Mesh(new THREE.PlaneGeometry(140, 140, 360, 360).rotateX(-Math.PI / 2), waterMat);
  water.position.z = -30;
  scene.add(water);

  // ---- whale: the app's whale illustration on a card that faces the camera
  const whaleTex = await svgTexture(whaleSvg, 512, 320);
  const whaleMat = new THREE.MeshBasicNodeMaterial({ map: whaleTex, alphaTest: 0.5, side: THREE.DoubleSide });
  const whale = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.19), whaleMat);
  whale.quaternion.copy(camera.quaternion);
  scene.add(whale);
  const whaleAt = (s: number) => ({ x: -2.5 + 5 * s, y: -1.0 + 4 * s * (1 - s) * 3.3 });
  // Where the path crosses the water: 13.2 s(1-s) = 1.
  const sCross = (1 - Math.sqrt(1 - 4 / 13.2)) / 2;
  const tExit = SHOT.whaleIn + sCross * (SHOT.whaleOut - SHOT.whaleIn);
  const tEntry = SHOT.whaleIn + (1 - sCross) * (SHOT.whaleOut - SHOT.whaleIn);
  ripples[0].value.set(whaleAt(sCross).x, 0, tExit, 1);
  ripples[1].value.set(whaleAt(1 - sCross).x, 0, tEntry, 1.25);
  // The ripples are in water-local coordinates (the plane is shifted back).
  ripples.forEach((r) => (r.value.y -= water.position.z));

  // ---- spray that becomes the heart
  const N = 900;
  const dotMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  // The accent pink; overlapping dots add up toward white at the heart's core.
  dotMat.colorNode = vec3(0.94, 0.36, 0.55);
  dotMat.opacityNode = smoothstep(0.5, 0.05, length(uv().sub(0.5))).mul(0.85);
  const dots = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dotMat, N);
  dots.frustumCulled = false;
  scene.add(dots);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const heartCenter = camera.position.clone().addScaledVector(fwd, 5.2);
  const rand = mulberry(7);
  const parts = Array.from({ length: N }, (_, i) => {
    const second = i % 3 !== 0; // the dive throws more spray than the breach
    const at = whaleAt(second ? 1 - sCross : sCross);
    const [hx, hy] = heartPoint(rand);
    return {
      t0: (second ? tEntry : tExit) + rand() * 0.06,
      origin: new THREE.Vector3(at.x + (rand() - 0.5) * 0.5, 0.02, (rand() - 0.5) * 0.4),
      vel: new THREE.Vector3((rand() - 0.5) * 2.2 + (second ? -0.4 : 0.5), 2.2 + rand() * 3, (rand() - 0.5) * 1.4),
      target: heartCenter.clone().addScaledVector(right, hx * 0.62).addScaledVector(up, hy * 0.62),
      delay: rand() * 0.14,
      size: 0.025 + rand() * 0.035,
    };
  });
  const m = new THREE.Matrix4();
  const q = camera.quaternion.clone();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const flight = new THREE.Vector3();

  function render(t: number) {
    uT.value = t;
    // Whale: breach, a roll at the top, and back in.
    const s = clamp01((t - SHOT.whaleIn) / (SHOT.whaleOut - SHOT.whaleIn));
    const w = whaleAt(s);
    whale.position.set(w.x, w.y, 0);
    whale.visible = t > SHOT.whaleIn && t < SHOT.whaleOut + 0.05;
    const heading = Math.atan2(13.2 * (1 - 2 * s), 5);
    whale.quaternion.copy(camera.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), heading - Math.PI * 2 * smooth(0.38, 0.62, s)));

    const g = (t - SHOT.gather) / (SHOT.formed - SHOT.gather);
    const pulse = t > SHOT.formed ? 1 + 0.12 * Math.sin(Math.min(1, (t - SHOT.formed) / 0.22) * Math.PI) : 1;
    for (let i = 0; i < N; i++) {
      const pt = parts[i];
      const age = t - pt.t0;
      if (age < 0) {
        m.makeScale(0, 0, 0);
        dots.setMatrixAt(i, m);
        continue;
      }
      // Ballistic until the gather, then eased onto its place in the heart.
      const fa = Math.min(age, Math.max(0, SHOT.gather + pt.delay - pt.t0));
      flight.copy(pt.origin).addScaledVector(pt.vel, fa).add(new THREE.Vector3(0, -4.6 * fa * fa, 0));
      if (flight.y < 0) flight.y = 0;
      const k = easeInOut(clamp01((g * (SHOT.formed - SHOT.gather) - pt.delay) / (SHOT.formed - SHOT.gather - 0.14)));
      pos.lerpVectors(flight, pt.target, k);
      if (k >= 1) pos.sub(heartCenter).multiplyScalar(pulse).add(heartCenter);
      const sz = pt.size * (1 + k * 0.6) * (age < 0.05 ? age / 0.05 : 1);
      m.compose(pos, q, scl.set(sz, sz, sz));
      dots.setMatrixAt(i, m);
    }
    dots.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function resize() {
    const wpx = canvas.clientWidth;
    const hpx = canvas.clientHeight;
    renderer.setSize(wpx, hpx, false);
    camera.aspect = wpx / hpx;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    renderer.dispose();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    whaleTex.dispose();
  }

  return { render, resize, dispose, backend };
}

// ---- helpers ------------------------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** A point inside the heart (x² + y² − 1)³ − x²y³ ≤ 0, roughly in [-1.15, 1.15]. */
function heartPoint(rand: () => number): [number, number] {
  for (;;) {
    const x = (rand() * 2 - 1) * 1.15;
    const y = (rand() * 2 - 1) * 1.15 + 0.1;
    const a = x * x + y * y - 1;
    // Mostly the outline, some fill: keeps the shape readable as spray.
    const v = a * a * a - x * x * y * y * y;
    if (v <= 0 && (v > -0.06 || rand() < 0.35)) return [x, y - 0.1];
  }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function svgTexture(svg: string, w: number, h: number): Promise<THREE.Texture> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
