import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { CharacterDef } from "./characters";
import { buildChibi, type Chibi } from "./chibi";
import { ShinkaiSky } from "./sky";

// The home screen: a ring of character cards on a soft neumorphic stage. The card in
// front is the selected partner; arrows, dragging or clicking a side card turns the ring.

export interface HomeSceneCallbacks {
  /** The ring turned to another card (by click or drag). */
  onFocus(index: number): void;
  /** The card already in front was clicked. */
  onPick(index: number): void;
}

export interface HomeTheme {
  /** Page background; the stage, fog and card bodies are tinted from it. */
  bg: string;
  dark: boolean;
}

interface Slot {
  holder: THREE.Group;
  /** Tilts toward the mouse when the card is in front, like a holographic trading card. */
  tilt: THREE.Group;
  /** 3D chibi for partners without an illustration. */
  chibi?: Chibi;
  /** Light sweep across an illustrated card. */
  shine?: THREE.ShaderMaterial;
  /** Seconds since the last sweep started. */
  sweep: number;
  hits: THREE.Object3D[];
}

/** A diagonal band of light that sweeps across the card art (additive, masked to the art's corners). */
const SHINE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SHINE_FRAG = /* glsl */ `
uniform float uPos;
uniform sampler2D uMask;
varying vec2 vUv;
void main() {
  float x = vUv.x + vUv.y * 0.55 - uPos;
  float band = exp(-x * x * 90.0) * 0.55 + exp(-x * x * 900.0) * 0.35;
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * band * texture2D(uMask, vUv).r, 1.0);
}`;

/** The stage: a translucent disc of light under the ring that dissolves into the sky at its edge. */
const STAGE_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vXZ = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const STAGE_FRAG = /* glsl */ `
uniform vec2 uCenter;
uniform float uR;
uniform float uRing;
uniform float uTime;
uniform vec3 uInner;
uniform vec3 uOuter;
uniform vec3 uGlow;
uniform float uAlpha;
varying vec2 vXZ;
float line(float d, float w) { return exp(-d * d / (w * w)); }
void main() {
  vec2 p = vXZ - uCenter;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec3 col = mix(uInner, uOuter, smoothstep(0.0, uR, r));
  float alpha = uAlpha * (1.0 - smoothstep(uR * 0.55, uR, r));
  // The track the cards stand on: a bright line with a soft halo.
  float track = line(r - uRing, 0.025) + line(r - uRing, 0.22) * 0.35;
  // A slow dotted ring just inside, and a fine one outside.
  float dots = line(r - (uRing - 0.55), 0.02) * step(0.5, fract(a * 24.0 / 6.2832 + uTime * 0.03));
  float outer = line(r - (uRing + 0.6), 0.012) * 0.6;
  // Faint concentric ripples toward the middle.
  float ripples = line(fract(r / 0.7 - uTime * 0.05) - 0.5, 0.03) * 0.18 * (1.0 - smoothstep(0.0, uRing - 0.6, r));
  // Pool of light where the front card stands (world origin).
  float pool = exp(-dot(vXZ, vXZ) * 0.9);
  float glow = track + dots * 0.7 + outer + ripples + pool * 0.9;
  col += uGlow * glow;
  alpha = clamp(alpha + glow * 0.6 * (1.0 - smoothstep(uR * 0.8, uR, r)), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

const CAM_Y = 0.2;
const LOOK_Y = -0.6;
const CARD_H = 2.35;
/** Frame width around the art: a thin bezel, so the illustration is the card. */
const BEZEL = 0.07;
const ART_H = CARD_H - BEZEL * 2;
const ART_W = ART_H * (2 / 3);
const CARD_W = ART_W + BEZEL * 2;
const CARD_D = 0.05;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export class HomeScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  private readonly ring = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly step: number;
  private readonly radius: number;
  private readonly stage: THREE.ShaderMaterial;
  private readonly cardMat: THREE.MeshPhysicalMaterial;
  private readonly env: THREE.Texture;
  private readonly petals: THREE.Points;
  private readonly petalSpeed: Float32Array;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(9, 9);
  private readonly parallax = new THREE.Vector2();
  private focus = 0;
  private hovered = -1;
  private ringAngle = 0;
  private targetAngle = 0;
  private frame = 0;
  private last = performance.now();
  private readonly start = performance.now();
  private downAt: { x: number; y: number } | null = null;
  private readonly reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly ro: ResizeObserver;
  private readonly sky: ShinkaiSky;
  private readonly hemi: THREE.HemisphereLight;
  private readonly rim: THREE.DirectionalLight;
  /** Camera distance; further back on narrow windows. */
  private camZ = 8.4;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    defs: CharacterDef[],
    private readonly cb: HomeSceneCallbacks,
    theme: HomeTheme,
    initialFocus = 0,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Aimed below the cards, so they sit in the upper part of the screen, clear of the info panel.
    this.camera.position.set(0, CAM_Y, this.camZ);
    this.camera.lookAt(0, LOOK_Y, 0);

    this.sky = new ShinkaiSky(this.renderer);

    // Soft sky light, a key light from the front for readable faces, and a warm rim from the sun behind.
    this.hemi = new THREE.HemisphereLight("#ffffff", "#e8d5df", 1.6);
    this.scene.add(this.hemi);
    const key = new THREE.DirectionalLight("#ffffff", 1.6);
    key.position.set(-3.5, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 6;
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    this.scene.add(key);
    this.rim = new THREE.DirectionalLight("#ffd9a8", 1.1);
    this.rim.position.set(-5.5, 3, -8);
    this.scene.add(this.rim);

    const n = defs.length;
    this.step = (Math.PI * 2) / Math.max(n, 1);
    this.radius = Math.max(3.2, (n * (CARD_W + 0.55)) / (Math.PI * 2));
    this.ring.position.z = -this.radius;
    this.scene.add(this.ring);

    // A disc of light under the whole ring, centered on it, fading out into the sky.
    const stageR = this.radius + 2.4;
    this.stage = new THREE.ShaderMaterial({
      vertexShader: STAGE_VERT,
      fragmentShader: STAGE_FRAG,
      uniforms: {
        uCenter: { value: new THREE.Vector2(0, -this.radius) },
        uR: { value: stageR },
        uRing: { value: this.radius },
        uTime: { value: 0 },
        uInner: { value: new THREE.Color() },
        uOuter: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uAlpha: { value: 0.8 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const stage = new THREE.Mesh(new THREE.CircleGeometry(stageR, 128), this.stage);
    stage.rotation.x = -Math.PI / 2;
    stage.position.set(0, -1.38, -this.radius);
    stage.renderOrder = -1;
    this.scene.add(stage);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(stageR, 64), new THREE.ShadowMaterial({ opacity: 0.12 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.37, -this.radius);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Cards: a thin glossy pearl frame. A studio environment gives the clearcoat something to reflect.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.cardMat = new THREE.MeshPhysicalMaterial({
      roughness: 0.32,
      metalness: 0.15,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      iridescence: 0.5,
      iridescenceIOR: 1.6,
      envMap: this.env,
      envMapIntensity: 0.9,
    });

    const cardGeo = roundedSlab(CARD_W, CARD_H, CARD_D, 0.11);
    const loader = new THREE.TextureLoader();
    const mask = roundedMask();
    const artH = ART_H;
    defs.forEach((def, i) => {
      const holder = new THREE.Group();
      const a = i * this.step;
      holder.position.set(Math.sin(a) * this.radius, 0, Math.cos(a) * this.radius);
      holder.rotation.y = a;
      const tilt = new THREE.Group();
      holder.add(tilt);
      const card = new THREE.Mesh(cardGeo, this.cardMat);
      card.castShadow = true;
      card.receiveShadow = true;
      card.position.y = 0.05;
      tilt.add(card);

      const slot: Slot = { holder, tilt, sweep: 99, hits: [card] };
      if (def.art) {
        // Full-art card: the illustration fills the window at its own 2:3 shape, corners rounded.
        const artW = ART_W;
        const mat = new THREE.MeshBasicMaterial({ color: "#f4eef4", alphaMap: mask, transparent: true, toneMapped: false });
        loader.load(def.art, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          mat.map = tex;
          mat.color.set("#ffffff");
          mat.needsUpdate = true;
        });
        const art = new THREE.Mesh(new THREE.PlaneGeometry(artW, artH), mat);
        art.position.set(0, 0.05, CARD_D / 2 + 0.002);
        tilt.add(art);
        slot.shine = new THREE.ShaderMaterial({
          vertexShader: SHINE_VERT,
          fragmentShader: SHINE_FRAG,
          uniforms: { uPos: { value: -1 }, uMask: { value: mask } },
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const shine = new THREE.Mesh(art.geometry, slot.shine);
        shine.position.set(0, 0.05, CARD_D / 2 + 0.004);
        tilt.add(shine);
        slot.hits.push(art);
      } else {
        const window_ = new THREE.Mesh(
          new THREE.PlaneGeometry(ART_W, artH),
          new THREE.MeshBasicMaterial({ map: cardFace(def), toneMapped: false }),
        );
        window_.position.set(0, 0.05, CARD_D / 2 + 0.002);
        tilt.add(window_);
        slot.chibi = buildChibi(def);
        slot.chibi.root.scale.setScalar(0.92);
        slot.chibi.root.position.set(0, -1.0, 0.16);
        tilt.add(slot.chibi.root);
        slot.hits.push(window_);
      }

      for (const o of slot.hits) o.userData.index = i;
      this.slots.push(slot);
      this.ring.add(holder);
    });

    // Drifting sakura petals.
    const count = this.reduceMotion ? 0 : 70;
    const pos = new Float32Array(count * 3);
    this.petalSpeed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos.set([(Math.random() - 0.5) * 14, Math.random() * 7 - 2, -Math.random() * 9 + 2], i * 3);
      this.petalSpeed[i] = 0.25 + Math.random() * 0.35;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.petals = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ size: 0.14, map: petalTexture(), transparent: true, depthWrite: false, opacity: 0.85 }),
    );
    this.scene.add(this.petals);

    this.setTheme(theme);
    this.focus = Math.min(initialFocus, n - 1);
    this.ringAngle = this.targetAngle = -this.focus * this.step;

    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointerleave", this.onLeave);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.loop();
    this.greet(this.focus);
  }

  setTheme(theme: HomeTheme): void {
    const bg = new THREE.Color(theme.bg);
    // Light mode: a summer day. Dark mode: dusk with the first stars.
    this.sky.setDusk(theme.dark);
    this.scene.background = this.sky.target.texture;
    // Distant cards fade into the horizon haze, like air perspective in the paintings.
    this.scene.fog = new THREE.Fog(this.sky.horizon(theme.dark), 9, 9 + this.radius * 2.6);
    this.hemi.color.set(theme.dark ? "#ffd6e6" : "#e4f0ff");
    this.hemi.groundColor.set(theme.dark ? "#6a4a66" : "#f3e2ea");
    this.rim.color.set(theme.dark ? "#ff9a6a" : "#ffe2b0");
    // The stage: pearly white by day, a violet glass disc at dusk; both glow pink along the track.
    const u = this.stage.uniforms;
    u.uInner.value.set(theme.dark ? "#a77fb4" : "#ffffff");
    u.uOuter.value.set(theme.dark ? "#6a4f86" : "#fbe3ef");
    u.uGlow.value.set(theme.dark ? "#ff8fc8" : "#ff9cc8").multiplyScalar(theme.dark ? 0.7 : 0.45);
    u.uAlpha.value = theme.dark ? 0.55 : 0.75;
    // Pearl frames, warmer at dusk, so the art is framed rather than boxed in.
    this.cardMat.color.copy(bg).lerp(new THREE.Color(theme.dark ? "#f3d3e4" : "#ffffff"), theme.dark ? 0.85 : 0.75);
    (this.petals.material as THREE.PointsMaterial).color.set(theme.dark ? "#ff9cc5" : "#ffc2da");
  }

  /** Turn the ring so card `index` is in front, the short way round. */
  setFocus(index: number): void {
    const n = this.slots.length;
    if (!n || index === this.focus) return;
    let diff = (index - this.focus) % n;
    if (diff > n / 2) diff -= n;
    if (diff < -n / 2) diff += n;
    this.focus = index;
    this.targetAngle -= diff * this.step;
    this.greet(index);
  }

  /** The card that just came to the front says hi: the chibi hops and waves, an art card shines. */
  private greet(index: number): void {
    const s = this.slots[index];
    if (!s) return;
    s.chibi?.cheer();
    s.sweep = 0;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.sky.dispose();
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.slots.forEach((s) => s.chibi?.dispose());
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          (m as THREE.MeshBasicMaterial).alphaMap?.dispose();
          m.dispose();
        }
      }
    });
    this.env.dispose();
    this.renderer.dispose();
  }

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.sky.resize(w, h);
    this.camera.aspect = w / h;
    // Narrow windows: step back so the front card still fits.
    this.camZ = w / h < 1.1 ? 10.5 : 8.4;
    this.camera.position.z = this.camZ;
    this.camera.updateProjectionMatrix();
  }

  private hit(): number {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.slots.flatMap((s) => s.hits),
      false,
    );
    return hits.length ? (hits[0].object.userData.index as number) : -1;
  }

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.parallax.set(this.pointer.x, this.pointer.y);
    this.hovered = this.hit();
    this.canvas.style.cursor = this.hovered >= 0 ? "pointer" : "grab";
  };

  private onDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent) => {
    if (!this.downAt) return;
    const dx = e.clientX - this.downAt.x;
    this.downAt = null;
    const n = this.slots.length;
    // A horizontal drag turns the ring by one card.
    if (Math.abs(dx) > 40) {
      const next = (this.focus + (dx < 0 ? 1 : -1) + n) % n;
      this.setFocus(next);
      this.cb.onFocus(next);
      return;
    }
    const i = this.hit();
    if (i < 0) return;
    if (i === this.focus) this.cb.onPick(i);
    else {
      this.setFocus(i);
      this.cb.onFocus(i);
    }
  };

  private onLeave = () => {
    this.pointer.set(9, 9);
    this.hovered = -1;
    this.downAt = null;
  };

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    const t = (now - this.start) / 1000;
    const ease = 1 - Math.pow(0.0015, dt); // frame-rate independent damping

    this.ringAngle += (this.targetAngle - this.ringAngle) * ease;
    this.ring.rotation.y = this.ringAngle;

    this.slots.forEach((s, i) => {
      const focused = i === this.focus;
      const hovered = i === this.hovered;
      // Art cards have no chibi stepping out of them, so the front one comes a little closer instead.
      // Cards turning away shrink out of sight, so the far side of the ring never shows blank backs.
      const facing = Math.cos(i * this.step + this.ringAngle);
      const away = THREE.MathUtils.smoothstep(facing, -0.05, 0.45);
      const scale = (focused ? 1 : hovered ? 0.9 : 0.84) * Math.max(away, 0.001);
      s.holder.visible = away > 0.01;
      const lift = focused ? 0.06 + Math.sin(t * 1.6) * 0.03 : hovered ? 0.08 : 0;
      s.holder.scale.lerp(new THREE.Vector3(scale, scale, scale), ease);
      s.holder.position.y += (lift - s.holder.position.y) * ease;
      s.chibi?.update(t, dt, { focused, hovered });

      // The front card leans toward the mouse; the others settle flat.
      const tx = focused && !this.reduceMotion ? -this.parallax.y * 0.1 : 0;
      const ty = focused && !this.reduceMotion ? this.parallax.x * 0.16 : 0;
      s.tilt.rotation.x += (tx - s.tilt.rotation.x) * ease;
      s.tilt.rotation.y += (ty - s.tilt.rotation.y) * ease;

      // Light sweep: once on arriving in front, then again every few seconds.
      if (s.shine) {
        s.sweep += dt;
        if (focused && s.sweep > 5.5) s.sweep = 0;
        s.shine.uniforms.uPos.value = -0.6 + (s.sweep / 1.1) * 2.6;
      }
    });

    // Petals fall and sway, wrapping back to the top.
    const p = this.petals.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - this.petalSpeed[i] * dt;
      if (y < -2) y = 5;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(t + i) * 0.003);
    }
    p.needsUpdate = true;

    // A little parallax so the stage feels alive under the mouse.
    if (!this.reduceMotion) {
      this.camera.position.x += (this.parallax.x * 0.35 - this.camera.position.x) * ease * 0.5;
      this.camera.position.y += (CAM_Y + this.parallax.y * 0.15 - this.camera.position.y) * ease * 0.5;
      this.camera.lookAt(0, LOOK_Y, 0);
    }
    this.stage.uniforms.uTime.value = this.reduceMotion ? 0 : t;
    this.camera.updateMatrixWorld();
    // Reduced motion: the clouds hold still.
    this.sky.render(this.camera, this.reduceMotion ? 0 : t);
    this.renderer.render(this.scene, this.camera);
  };
}

/** The card's inner window: gradient, polka dots, name and title, drawn once to a canvas. */
function cardFace(def: CharacterDef): THREE.CanvasTexture {
  const w = 512;
  const h = Math.round((w * ART_H) / ART_W);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const r = 44;
  g.beginPath();
  g.roundRect(0, 0, w, h, r);
  g.clip();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, def.card[0]);
  grad.addColorStop(1, def.card[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,0.28)";
  for (let y = 24; y < h; y += 40) {
    for (let x = (y / 40) % 2 ? 24 : 44; x < w; x += 40) {
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Soft spotlight behind where the character stands.
  const spot = g.createRadialGradient(w / 2, h * 0.62, 10, w / 2, h * 0.62, w * 0.55);
  spot.addColorStop(0, "rgba(255,255,255,0.7)");
  spot.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = spot;
  g.fillRect(0, 0, w, h);

  // Name in her hair color with a white outline: readable on every card color.
  g.textAlign = "center";
  g.lineJoin = "round";
  g.font = `800 66px ${FONT}`;
  g.lineWidth = 12;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.strokeText(def.name, w / 2, 100);
  g.fillStyle = def.hair;
  g.fillText(def.name, w / 2, 100);
  g.font = `600 26px ${FONT}`;
  g.fillStyle = "rgba(60,30,50,0.6)";
  g.fillText(def.title, w / 2, 148);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A thin card body: a rounded rectangle extruded with a small bevel, centered on the origin. */
function roundedSlab(w: number, h: number, d: number, r: number): THREE.ExtrudeGeometry {
  const bevel = d * 0.35;
  const x = -w / 2 + bevel;
  const y = -h / 2 + bevel;
  const iw = w - bevel * 2;
  const ih = h - bevel * 2;
  const ir = r - bevel;
  const shape = new THREE.Shape();
  shape.moveTo(x + ir, y);
  shape.lineTo(x + iw - ir, y);
  shape.quadraticCurveTo(x + iw, y, x + iw, y + ir);
  shape.lineTo(x + iw, y + ih - ir);
  shape.quadraticCurveTo(x + iw, y + ih, x + iw - ir, y + ih);
  shape.lineTo(x + ir, y + ih);
  shape.quadraticCurveTo(x, y + ih, x, y + ih - ir);
  shape.lineTo(x, y + ir);
  shape.quadraticCurveTo(x, y, x + ir, y);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 10,
  });
  geo.translate(0, 0, -(d - bevel * 2) / 2);
  return geo;
}

/** Rounded-rectangle alpha mask for card art, shared by every illustrated card. */
let maskCache: THREE.CanvasTexture | null = null;
function roundedMask(): THREE.CanvasTexture {
  if (maskCache) return maskCache;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 384;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 18);
  g.fill();
  maskCache = new THREE.CanvasTexture(c);
  return maskCache;
}

function petalTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.translate(32, 32);
  g.rotate(-0.6);
  const grad = g.createRadialGradient(0, -4, 2, 0, 0, 26);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(1, "#ffd1e3");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, 24);
  g.bezierCurveTo(22, 8, 16, -20, 4, -24);
  g.lineTo(0, -16);
  g.lineTo(-4, -24);
  g.bezierCurveTo(-16, -20, -22, 8, 0, 24);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
