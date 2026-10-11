import * as THREE from "three";
import type { CharacterDef } from "./characters";

// Chibi characters built from primitives with cel shading and inverted-hull outlines,
// so the whole cast ships as code: no model files, no textures to download.
// Units: about 1.6 tall, feet at y = 0, face looking down +z.

const SKIN = "#ffe7da";
const HEAD_R = 0.42;

let gradient: THREE.DataTexture | null = null;
/** Three-step ramp: the hard light/shadow bands that make it read as anime. */
function toonRamp(): THREE.DataTexture {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array([120, 195, 255]), 3, 1, THREE.RedFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;
  }
  return gradient;
}

const toon = (color: THREE.ColorRepresentation) => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp() });
const flat = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
const shade = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

/** Inverted hull: a slightly larger back-face copy draws the ink line around the shape. */
function outline(mesh: THREE.Mesh, color: THREE.ColorRepresentation, grow = 1.045): THREE.Mesh {
  const hull = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  hull.scale.setScalar(grow);
  mesh.add(hull);
  return mesh;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, castShadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = castShadow;
  return m;
}

/** Put a flat face decal (eye, blush, mouth) on the head sphere at (x, y), facing outward. */
function onFace(obj: THREE.Object3D, x: number, y: number, lift = 0.004) {
  const z = Math.sqrt(Math.max(HEAD_R * HEAD_R - x * x - y * y, 0));
  const n = new THREE.Vector3(x, y, z).normalize();
  obj.position.copy(n.clone().multiplyScalar(HEAD_R + lift));
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
}

function starShape(outer: number, inner: number, points = 5): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i <= points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const p = [Math.cos(a) * r, Math.sin(a) * r] as const;
    if (i === 0) s.moveTo(...p);
    else s.lineTo(...p);
  }
  return s;
}

/** Crescent: the outer circle minus an offset inner one, traced along both arcs. */
function crescentShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, 0.11, 0.938, Math.PI * 2 - 0.938, false);
  s.absarc(0.05, 0, 0.09, Math.PI * 2 - 1.403, 1.403, true);
  return s;
}

function whaleTailShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, -0.09);
  s.quadraticCurveTo(-0.02, 0, -0.11, 0.06);
  s.quadraticCurveTo(-0.04, 0.045, 0, 0.005);
  s.quadraticCurveTo(0.04, 0.045, 0.11, 0.06);
  s.quadraticCurveTo(0.02, 0, 0, -0.09);
  return s;
}

const extrude = (shape: THREE.Shape, depth = 0.03) =>
  new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize: 0.008,
    bevelThickness: 0.008,
    bevelSegments: 2,
    curveSegments: 16,
  }).center();

export interface Mood {
  focused: boolean;
  hovered: boolean;
}

export interface Chibi {
  root: THREE.Group;
  update(t: number, dt: number, mood: Mood): void;
  /** Hop and wave, e.g. when her card comes to the front. */
  cheer(): void;
  dispose(): void;
}

export function buildChibi(def: CharacterDef): Chibi {
  const ink = shade(def.hair, 0.42);
  const skinInk = new THREE.Color("#c98b78");
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // ---- body -----------------------------------------------------------
  for (const s of [-1, 1]) {
    const leg = mesh(new THREE.CapsuleGeometry(0.062, 0.16, 4, 12), toon("#ffffff"));
    leg.position.set(s * 0.085, 0.17, 0);
    body.add(leg);
    const shoe = mesh(new THREE.SphereGeometry(0.075, 16, 12), toon(def.accent));
    shoe.scale.set(1, 0.6, 1.35);
    shoe.position.set(s * 0.085, 0.045, 0.03);
    body.add(outline(shoe, shade(def.accent, 0.5), 1.08));
  }

  const dress = mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.001, 0.24),
        new THREE.Vector2(0.3, 0.255),
        new THREE.Vector2(0.28, 0.33),
        new THREE.Vector2(0.21, 0.5),
        new THREE.Vector2(0.16, 0.66),
        new THREE.Vector2(0.14, 0.75),
        new THREE.Vector2(0.001, 0.77),
      ],
      28,
    ),
    toon(def.outfit),
  );
  body.add(outline(dress, shade(def.outfit, 0.55), 1.035));

  const hem = mesh(new THREE.TorusGeometry(0.292, 0.02, 8, 40), toon(def.accent));
  hem.rotation.x = Math.PI / 2;
  hem.position.y = 0.27;
  body.add(hem);

  // Ribbon bow at the collar.
  const bow = new THREE.Group();
  for (const s of [-1, 1]) {
    const wing = mesh(new THREE.SphereGeometry(0.06, 14, 10), toon(def.accent));
    wing.scale.set(1.2, 0.8, 0.6);
    wing.position.set(s * 0.065, 0, 0);
    bow.add(wing);
  }
  bow.add(mesh(new THREE.SphereGeometry(0.035, 12, 10), toon(shade(def.accent, 0.85))));
  bow.position.set(0, 0.72, 0.15);
  body.add(bow);

  const arms: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.17, 0.7, 0);
    const arm = mesh(new THREE.CapsuleGeometry(0.048, 0.18, 4, 10), toon(def.outfit));
    arm.position.y = -0.12;
    pivot.add(outline(arm, shade(def.outfit, 0.55), 1.06));
    const hand = mesh(new THREE.SphereGeometry(0.052, 14, 10), toon(SKIN));
    hand.position.y = -0.255;
    pivot.add(hand);
    pivot.rotation.z = s * 0.25;
    body.add(pivot);
    arms.push(pivot);
  }

  // ---- head -----------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = 1.13;
  body.add(head);
  head.add(outline(mesh(new THREE.SphereGeometry(HEAD_R, 48, 36), toon(SKIN)), skinInk, 1.03));

  // Big anime eyes: iris, pupil, two catch-lights and a top lash line.
  const eyes: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    onFace(eye, s * 0.15, -0.035);
    const inner = new THREE.Group(); // scaled for blinking, so the face placement stays put
    inner.scale.set(1, 1.3, 1);
    eye.add(inner);
    inner.add(mesh(new THREE.CircleGeometry(0.085, 32), flat(def.eye), false));
    const pupil = mesh(new THREE.CircleGeometry(0.048, 24), flat(shade(def.eye, 0.45)), false);
    pupil.position.set(0, -0.012, 0.001);
    inner.add(pupil);
    const glint = mesh(new THREE.CircleGeometry(0.03, 16), flat("#ffffff"), false);
    glint.position.set(-s * 0.025, 0.035, 0.002);
    inner.add(glint);
    const glint2 = mesh(new THREE.CircleGeometry(0.014, 12), flat("#ffffff"), false);
    glint2.position.set(s * 0.03, -0.04, 0.002);
    inner.add(glint2);
    const lash = mesh(new THREE.TorusGeometry(0.094, 0.013, 6, 24, Math.PI * 0.78), flat(ink), false);
    lash.rotation.z = Math.PI / 2 - Math.PI * 0.39;
    lash.position.z = 0.003;
    inner.add(lash);
    head.add(eye);
    eyes.push(inner);

    const blush = mesh(new THREE.CircleGeometry(0.055, 20), flat("#ff8fa3", 0.5), false);
    onFace(blush, s * 0.25, -0.15, 0.006);
    blush.scale.set(1.35, 0.7, 1);
    head.add(blush);
  }
  const mouth = mesh(new THREE.TorusGeometry(0.032, 0.009, 6, 16, Math.PI), flat("#c2185b"), false);
  const mouthHolder = new THREE.Group();
  onFace(mouthHolder, 0, -0.175, 0.006);
  mouth.rotation.z = Math.PI; // lower half of the ring: a smile
  mouthHolder.add(mouth);
  head.add(mouthHolder);

  // ---- hair -----------------------------------------------------------
  const hairMat = toon(def.hair);
  const hair = (geo: THREE.BufferGeometry, grow = 1.04) => outline(mesh(geo, hairMat), ink, grow);

  // Cap over the skull, tipped back so the forehead shows.
  const cap = hair(new THREE.SphereGeometry(0.455, 40, 24, 0, Math.PI * 2, 0, Math.PI * 0.56), 1.03);
  cap.rotation.x = -0.45;
  head.add(cap);

  // Bangs: a row of soft locks across the forehead, alternating lengths.
  for (let i = 0; i < 7; i++) {
    const a = -0.95 + (i / 6) * 1.9;
    const e = 0.42;
    const lock = hair(new THREE.SphereGeometry(0.1, 16, 12), 1.06);
    lock.scale.set(0.8, i % 2 ? 1.1 : 1.3, 0.55);
    lock.position.set(Math.sin(a) * Math.cos(e) * 0.43, Math.sin(e) * 0.43, Math.cos(a) * Math.cos(e) * 0.43);
    lock.rotation.set(0.3, a, -a * 0.25);
    head.add(lock);
  }
  for (const s of [-1, 1]) {
    const side = hair(new THREE.CapsuleGeometry(0.065, 0.3, 4, 12), 1.07);
    side.position.set(s * 0.39, -0.14, 0.09);
    side.rotation.z = s * 0.12;
    head.add(side);
  }
  const ahoge = mesh(new THREE.TorusGeometry(0.08, 0.018, 6, 16, Math.PI * 1.2), hairMat);
  ahoge.position.set(0.02, 0.5, 0);
  ahoge.rotation.set(0, 0.3, 0.7);
  head.add(ahoge);

  const back = new THREE.Group();
  head.add(back);
  const backHair = (sx: number, sy: number, sz: number, y: number, z: number) => {
    const m = hair(new THREE.SphereGeometry(0.47, 36, 24), 1.03);
    m.scale.set(sx, sy, sz);
    m.position.set(0, y, z);
    back.add(m);
  };
  switch (def.style) {
    case "long":
      backHair(1.05, 1.55, 0.62, -0.42, -0.17);
      break;
    case "bob":
      backHair(1.1, 0.85, 0.92, -0.14, -0.05);
      break;
    case "short":
      backHair(1.0, 0.72, 0.85, -0.07, -0.06);
      break;
    case "twin":
      backHair(1.0, 0.72, 0.85, -0.07, -0.06);
      for (const s of [-1, 1]) {
        const bun = hair(new THREE.SphereGeometry(0.14, 20, 16), 1.06);
        bun.position.set(s * 0.33, 0.3, -0.08);
        head.add(bun);
        const tail = hair(new THREE.CapsuleGeometry(0.075, 0.42, 4, 12), 1.06);
        tail.position.set(s * 0.45, -0.08, -0.12);
        tail.rotation.z = s * 0.22;
        back.add(tail);
        const tie = mesh(new THREE.TorusGeometry(0.05, 0.02, 8, 16), toon(def.accent));
        tie.position.set(s * 0.4, 0.2, -0.1);
        tie.rotation.y = Math.PI / 2;
        head.add(tie);
      }
      break;
    case "fluffy":
      backHair(1.0, 0.75, 0.88, -0.08, -0.06);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const puff = hair(new THREE.SphereGeometry(0.12, 16, 12), 1.06);
        puff.position.set(Math.cos(a) * 0.44, 0.08 + Math.sin(a) * 0.3, -0.12 + Math.abs(Math.sin(a)) * 0.05);
        if (puff.position.y < -0.05 && Math.abs(puff.position.x) < 0.3) continue; // keep the face clear
        head.add(puff);
      }
      break;
  }

  // ---- signature accessory ---------------------------------------------
  let spinner: THREE.Object3D | null = null;
  const accentMat = toon(def.accent);
  const accentInk = shade(def.accent, 0.45);
  switch (def.accessory) {
    case "star": {
      const star = outline(mesh(extrude(starShape(0.1, 0.045)), accentMat), accentInk, 1.1);
      star.position.set(0.3, 0.3, 0.24);
      star.rotation.z = 0.3;
      head.add(star);
      break;
    }
    case "headphones": {
      const band = outline(mesh(new THREE.TorusGeometry(0.485, 0.035, 10, 48, Math.PI), toon("#ffffff")), ink, 1.08);
      head.add(band);
      for (const s of [-1, 1]) {
        const cup = outline(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 28), accentMat), accentInk, 1.08);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(s * 0.475, 0, 0);
        head.add(cup);
      }
      break;
    }
    case "whale": {
      const tail = outline(mesh(extrude(whaleTailShape()), accentMat), accentInk, 1.1);
      tail.position.set(-0.31, 0.3, 0.22);
      tail.rotation.z = -0.35;
      head.add(tail);
      break;
    }
    case "moon": {
      const moon = outline(mesh(extrude(crescentShape()), accentMat), accentInk, 1.1);
      moon.position.set(0.31, 0.32, 0.2);
      moon.rotation.z = -0.5;
      head.add(moon);
      break;
    }
    case "glasses": {
      const frame = flat("#2c2f5a");
      for (const s of [-1, 1]) {
        const ring = new THREE.Group();
        onFace(ring, s * 0.15, -0.035, 0.05);
        ring.add(mesh(new THREE.TorusGeometry(0.105, 0.013, 8, 36), frame, false));
        head.add(ring);
      }
      const bridge = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 8), frame, false);
      bridge.rotation.z = Math.PI / 2;
      bridge.position.set(0, -0.01, 0.455);
      head.add(bridge);
      break;
    }
    case "cap": {
      const crown = outline(
        mesh(new THREE.SphereGeometry(0.48, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.42), accentMat),
        accentInk,
        1.03,
      );
      crown.rotation.x = -0.32;
      head.add(crown);
      const brim = outline(mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.03, 32), accentMat), accentInk, 1.06);
      brim.scale.set(1, 1, 0.7);
      brim.position.set(0, 0.28, 0.36);
      brim.rotation.x = 0.28;
      head.add(brim);
      const button = mesh(new THREE.SphereGeometry(0.04, 12, 10), toon("#ffffff"));
      button.position.set(0, 0.47, -0.12);
      head.add(button);
      break;
    }
    case "llama": {
      for (const s of [-1, 1]) {
        const ear = outline(mesh(new THREE.ConeGeometry(0.085, 0.28, 18), hairMat), ink, 1.08);
        ear.position.set(s * 0.28, 0.45, -0.02);
        ear.rotation.z = -s * 0.5;
        head.add(ear);
        const inner = mesh(new THREE.ConeGeometry(0.045, 0.17, 14), toon(def.accent));
        inner.position.set(0, -0.03, 0.045);
        ear.add(inner);
      }
      break;
    }
    case "question": {
      const q = new THREE.Group();
      const hook = mesh(new THREE.TorusGeometry(0.09, 0.028, 10, 28, Math.PI * 1.4), accentMat);
      hook.rotation.z = -Math.PI * 0.45;
      hook.position.y = 0.09;
      q.add(hook);
      const stem = mesh(new THREE.CapsuleGeometry(0.028, 0.05, 4, 8), accentMat);
      stem.position.y = -0.03;
      q.add(stem);
      const dot = mesh(new THREE.SphereGeometry(0.035, 12, 10), accentMat);
      dot.position.y = -0.14;
      q.add(dot);
      // Off to one side, so it doesn't cover the name on her card.
      q.position.set(0.42, 0.55, 0.1);
      q.rotation.z = -0.25;
      head.add(q);
      spinner = q;
      break;
    }
    case "none":
      break;
  }

  // ---- animation --------------------------------------------------------
  const phase = Math.random() * Math.PI * 2;
  let nextBlink = 1 + Math.random() * 3;
  let blinkT = -1;
  let hopT = -1;
  let waveT = -1;
  let idleCheer = 3 + Math.random() * 3;

  return {
    root,
    cheer() {
      hopT = 0;
      waveT = 0;
    },
    update(t, dt, mood) {
      // Breathing bob and a gentle head sway.
      let y = Math.sin(t * 2.2 + phase) * 0.012;
      head.rotation.z = Math.sin(t * 0.8 + phase) * 0.07;
      head.rotation.y = mood.focused ? Math.sin(t * 0.55 + phase) * 0.18 : 0;
      back.rotation.x = Math.sin(t * 1.4 + phase) * 0.05;
      if (spinner) spinner.rotation.y = t * 1.5;

      // Blink every few seconds.
      nextBlink -= dt;
      if (nextBlink <= 0 && blinkT < 0) {
        blinkT = 0;
        nextBlink = 2.5 + Math.random() * 3;
      }
      let lid = 1;
      if (blinkT >= 0) {
        blinkT += dt;
        lid = Math.abs(Math.cos((blinkT / 0.16) * Math.PI));
        if (blinkT > 0.16) blinkT = -1;
      }
      for (const e of eyes) e.scale.y = 1.3 * Math.max(lid, 0.08);

      // The partner at the front says hi now and then.
      if (mood.focused) {
        idleCheer -= dt;
        if (idleCheer <= 0) {
          waveT = 0;
          idleCheer = 5 + Math.random() * 3;
        }
      }
      if (hopT >= 0) {
        hopT += dt;
        const k = hopT / 0.55;
        y += Math.sin(Math.min(k, 1) * Math.PI) * 0.2;
        body.scale.set(1 + Math.sin(k * Math.PI * 2) * 0.03, 1 - Math.sin(k * Math.PI * 2) * 0.03, 1);
        if (k >= 1) {
          hopT = -1;
          body.scale.set(1, 1, 1);
        }
      }
      let right = 0.25 + Math.sin(t * 2 + phase) * 0.03;
      if (waveT >= 0) {
        waveT += dt;
        const up = Math.min(waveT / 0.25, 1, (1.8 - waveT) / 0.25);
        right = THREE.MathUtils.lerp(right, 2.5 + Math.sin(waveT * 14) * 0.3, Math.max(up, 0));
        if (waveT > 1.8) waveT = -1;
      } else if (mood.hovered) {
        right = THREE.MathUtils.lerp(right, 0.6, 0.5);
      }
      arms[1].rotation.z = right;
      arms[0].rotation.z = -(0.25 + Math.sin(t * 2 + phase + 1) * 0.03);
      body.position.y = y;
    },
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
    },
  };
}
