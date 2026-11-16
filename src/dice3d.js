// 3D-Darstellung: Samtfläche, sechs Würfel, Physik-Wurf.
//
// Das Würfelergebnis steht schon vor der Animation fest (es kommt aus der Spiellogik
// bzw. vom Mitspieler). Deshalb wird der Wurf vorab komplett simuliert, geprüft, welche
// Seite oben landet, und der Würfel dann so "umetikettiert", dass die gewünschte Zahl
// oben liegt. Abgespielt wird die aufgezeichnete Bahn.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as CANNON from 'cannon-es';

const NDICE = 6;
const FACE_VALUES = [1, 6, 2, 5, 3, 4]; // Materialreihenfolge der Box: +x -x +y -y +z -z
const AXES = {
  1: new THREE.Vector3(1, 0, 0),
  6: new THREE.Vector3(-1, 0, 0),
  2: new THREE.Vector3(0, 1, 0),
  5: new THREE.Vector3(0, -1, 0),
  3: new THREE.Vector3(0, 0, 1),
  4: new THREE.Vector3(0, 0, -1),
};
const UP = new THREE.Vector3(0, 1, 0);
const TRAY_SCALE = 0.62;
const FPS = 60;
const rand = (a, b) => a + Math.random() * (b - a);

function pipTexture(value) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const bg = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.75);
  bg.addColorStop(0, '#fbf6e9');
  bg.addColorStop(1, '#ebdfc6');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  const P = [0.26, 0.5, 0.74];
  const spots = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  }[value];
  for (const [ix, iy] of spots) {
    const x = P[ix] * S;
    const y = P[iy] * S;
    const r = (value === 1 ? 0.12 : 0.088) * S;
    const pip = g.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    if (value === 1) {
      pip.addColorStop(0, '#b3342a');
      pip.addColorStop(1, '#6e120c');
    } else {
      pip.addColorStop(0, '#3a3a3a');
      pip.addColorStop(1, '#0c0c0c');
    }
    g.fillStyle = pip;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function feltTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = (Math.random() - 0.5) * 26 + (Math.random() < 0.04 ? 14 : 0);
    img.data[i * 4] = 10 + n * 0.4;
    img.data[i * 4 + 1] = 64 + n;
    img.data[i * 4 + 2] = 41 + n * 0.7;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  return t;
}

/** Quaternion, mit der die Seite `value` nach oben zeigt (achsenparallel). */
const faceUpQuat = (value) => new THREE.Quaternion().setFromUnitVectors(AXES[value], UP);

export class DiceView {
  constructor(el, { onImpact } = {}) {
    this.el = el;
    this.onImpact = onImpact || (() => {});
    this.playback = null;
    this.tweens = [];
    this.dirty = true;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    el.appendChild(r.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#04170f');
    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 100);

    scene.add(new THREE.HemisphereLight(0xfff1d6, 0x06200f, 0.55));
    const spot = new THREE.SpotLight(0xfff0d2, 3.4, 0, 0.62, 1, 0);
    spot.position.set(-3, 17, 5);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0004;
    spot.shadow.radius = 5;
    scene.add(spot, spot.target);

    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshPhysicalMaterial({
        map: feltTexture(),
        roughness: 1,
        metalness: 0,
        sheen: 1,
        sheenRoughness: 0.55,
        sheenColor: new THREE.Color('#58b888'),
      }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    scene.add(felt);

    // Feine goldene Linie, die die Ablage der herausgelegten Würfel abtrennt.
    this.trayLine = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.035),
      new THREE.MeshBasicMaterial({ color: '#c9a45c', transparent: true, opacity: 0.55 }),
    );
    this.trayLine.rotation.x = -Math.PI / 2;
    this.trayLine.position.y = 0.01;
    scene.add(this.trayLine);

    const geo = new RoundedBoxGeometry(1, 1, 1, 5, 0.13);
    const mats = FACE_VALUES.map(
      (v) =>
        new THREE.MeshPhysicalMaterial({
          map: pipTexture(v),
          roughness: 0.32,
          clearcoat: 0.7,
          clearcoatRoughness: 0.25,
        }),
    );
    this.dice = [];
    for (let i = 0; i < NDICE; i++) {
      const mesh = new THREE.Mesh(geo, mats);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.dice.push({ mesh, v: null, where: null });
    }

    this.resize();
    this.dice.forEach((d, i) => this.place(d, i, i + 1));
    new ResizeObserver(() => this.resize()).observe(el);
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  // ---------- Geometrie der Spielfläche ----------

  resize() {
    const w = this.el.clientWidth || 300;
    const h = this.el.clientHeight || 300;
    this.renderer.setSize(w, h);
    const cam = this.camera;
    cam.aspect = w / h;
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const d = Math.max(9.4 / k, 8.4 / (k * cam.aspect));
    cam.position.set(0, d, d * 0.16);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const ray = new THREE.Raycaster();
    const hit = (x, y) => {
      ray.setFromCamera(new THREE.Vector2(x, y), cam);
      return ray.ray.at(-ray.ray.origin.y / ray.ray.direction.y, new THREE.Vector3());
    };
    const xHalf = Math.min(hit(1, -1).x, 5.2) - 0.12;
    const zNear = hit(0, -1).z - 0.12;
    const zFar = hit(0, 1).z + 0.12;
    // Die Bande liegt etwas vor der Linie: Durch die Perspektive ragen Würfel optisch darüber hinaus.
    this.bounds = { xHalf, zNear, zFar: zFar + 1.6, trayZ: zFar + 0.62 };
    this.trayLine.scale.x = xHalf * 2 - 0.6;
    this.trayLine.position.z = zFar + 1.3;

    // Nach Drehen des Geräts o. Ä.: liegende Würfel in die neue Fläche holen, Ablage neu ausrichten.
    if (this.dice && !this.playback) {
      for (const d of this.dice) {
        if (d.where !== 'table') continue;
        const p = d.mesh.position;
        p.x = THREE.MathUtils.clamp(p.x, -xHalf + 0.7, xHalf - 0.7);
        p.z = THREE.MathUtils.clamp(p.z, this.bounds.zFar + 0.7, zNear - 0.7);
      }
      this.layout(this.lastTurn, false);
    }
    this.dirty = true;
  }

  /** Ruheposition in der Tischmitte (für frisch geladene Zustände). */
  place(die, slot, value) {
    const z = (this.bounds.zNear + this.bounds.zFar) / 2;
    die.mesh.position.set((slot - 2.5) * 1.22, 0.5, z);
    die.mesh.quaternion.copy(faceUpQuat(value));
    die.mesh.scale.setScalar(1);
    die.v = value;
    die.where = 'table';
    this.dirty = true;
  }

  showOnly(ids) {
    this.dice.forEach((d, i) => (d.mesh.visible = ids.includes(i)));
    // Ein einzelner, noch nicht geworfener Würfel (Startwurf) gehört in die Mitte.
    const only = this.dice[ids[0]];
    if (ids.length === 1 && !only.rolled) only.mesh.position.x = 0;
    this.dirty = true;
  }

  showAll() {
    this.dice.forEach((d) => (d.mesh.visible = true));
    this.dirty = true;
  }

  // ---------- Wurf ----------

  /** Wirft die Würfel `ids`; sie landen auf `values`. Löst auf, wenn alle liegen. */
  roll(ids, values) {
    return new Promise((resolve) => {
      if (this.playback) this.finishPlayback();
      const sim = this.simulate(ids.length);
      const offsets = values.map((v, i) =>
        new THREE.Quaternion().setFromUnitVectors(AXES[v], AXES[sim.up[i]]),
      );
      this.tweens = this.tweens.filter((t) => !ids.includes(this.dice.indexOf(t.die)));
      ids.forEach((id, i) => {
        const d = this.dice[id];
        d.mesh.visible = true;
        d.mesh.scale.setScalar(1);
        d.v = values[i];
        d.where = 'table';
        d.rolled = true;
      });
      this.playback = { ids, offsets, sim, t0: performance.now(), ev: 0, resolve };
    });
  }

  simulate(n) {
    let best = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      const sim = this.simulateOnce(n);
      if (sim.flat) return sim;
      best = best || sim;
    }
    return best;
  }

  simulateOnce(n) {
    const { xHalf, zNear, zFar } = this.bounds;
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -42, 0) });
    world.allowSleep = true;
    const mDie = new CANNON.Material('die');
    const mFelt = new CANNON.Material('felt');
    world.addContactMaterial(new CANNON.ContactMaterial(mDie, mFelt, { friction: 0.45, restitution: 0.28 }));
    world.addContactMaterial(new CANNON.ContactMaterial(mDie, mDie, { friction: 0.15, restitution: 0.42 }));

    const plane = (x, y, z, rx, ry) => {
      const b = new CANNON.Body({ mass: 0, material: mFelt, shape: new CANNON.Plane() });
      b.position.set(x, y, z);
      b.quaternion.setFromEuler(rx, ry, 0);
      world.addBody(b);
    };
    plane(0, 0, 0, -Math.PI / 2, 0); // Boden
    plane(-xHalf, 0, 0, 0, Math.PI / 2);
    plane(xHalf, 0, 0, 0, -Math.PI / 2);
    plane(0, 0, zFar, 0, 0);
    plane(0, 0, zNear, 0, Math.PI);

    const events = [];
    let frame = 0;
    const span = (xHalf - 0.9) * 2;
    const order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
    const bodies = [];
    for (let i = 0; i < n; i++) {
      const b = new CANNON.Body({
        mass: 1,
        material: mDie,
        shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
        sleepSpeedLimit: 0.2,
        sleepTimeLimit: 0.25,
        linearDamping: 0.08,
        angularDamping: 0.08,
      });
      const slot = order[i];
      b.position.set(
        n === 1 ? rand(-1, 1) : -span / 2 + (span * (slot + 0.5)) / n + rand(-0.1, 0.1),
        1.1 + (slot % 2) * 1.5 + rand(0, 0.4),
        zNear - 0.9 - (slot % 2) * 0.5,
      );
      b.quaternion.setFromEuler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
      b.velocity.set(rand(-3.5, 3.5), rand(0, 3), -rand(9, 15));
      b.angularVelocity.set(rand(-22, 22), rand(-22, 22), rand(-22, 22));
      b.addEventListener('collide', (e) => {
        const dieHit = e.body.mass > 0;
        if (dieHit && b.id > e.body.id) return; // Würfel-Würfel nur einmal zählen
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (v > 1.2) events.push({ frame, v, kind: dieHit ? 'dice' : 'felt' });
      });
      world.addBody(b);
      bodies.push(b);
    }

    const MAX = FPS * 8;
    const data = new Float32Array(MAX * n * 7);
    for (; frame < MAX; frame++) {
      world.step(1 / FPS);
      bodies.forEach((b, i) => {
        const o = (frame * n + i) * 7;
        data[o] = b.position.x;
        data[o + 1] = b.position.y;
        data[o + 2] = b.position.z;
        data[o + 3] = b.quaternion.x;
        data[o + 4] = b.quaternion.y;
        data[o + 5] = b.quaternion.z;
        data[o + 6] = b.quaternion.w;
      });
      if (frame > 20 && bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING)) {
        frame++;
        break;
      }
    }

    // Welche Seite liegt oben – und liegt jeder Würfel wirklich flach auf dem Tisch?
    let flat = true;
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const up = bodies.map((b) => {
      q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      let bestVal = 1;
      let bestDot = -2;
      for (let val = 1; val <= 6; val++) {
        const dot = v.copy(AXES[val]).applyQuaternion(q).y;
        if (dot > bestDot) {
          bestDot = dot;
          bestVal = val;
        }
      }
      if (bestDot < 0.995 || b.position.y > 0.56) flat = false;
      return bestVal;
    });
    return { data, frames: frame, n, up, events, flat };
  }

  applyFrame(pb, f) {
    const { data, n } = pb.sim;
    const q = new THREE.Quaternion();
    pb.ids.forEach((id, i) => {
      const o = (f * n + i) * 7;
      const m = this.dice[id].mesh;
      m.position.set(data[o], data[o + 1], data[o + 2]);
      q.set(data[o + 3], data[o + 4], data[o + 5], data[o + 6]);
      m.quaternion.copy(q).multiply(pb.offsets[i]);
    });
  }

  finishPlayback() {
    const pb = this.playback;
    if (!pb) return;
    this.applyFrame(pb, pb.sim.frames - 1);
    this.playback = null;
    this.dirty = true;
    pb.resolve();
  }

  // ---------- Ablage der herausgelegten Würfel ----------

  /** Gleicht die Szene mit dem Zug-Zustand ab: Genommene Würfel wandern in die Ablage. */
  layout(turn, animate = true) {
    if (!turn) return;
    this.lastTurn = turn;
    const { xHalf, trayZ } = this.bounds;
    const taken = turn.dice.filter((d) => d.taken).sort((a, b) => a.g - b.g || a.id - b.id);
    const step = TRAY_SCALE + 0.08;
    const gap = 0.3;
    let width = 0;
    taken.forEach((d, i) => (width += i === 0 ? 0 : step + (d.g !== taken[i - 1].g ? gap : 0)));
    let x = Math.max(-width / 2, -xHalf + 0.5);
    taken.forEach((d, i) => {
      if (i > 0) x += step + (d.g !== taken[i - 1].g ? gap : 0);
      const die = this.dice[d.id];
      const to = new THREE.Vector3(x, TRAY_SCALE / 2, trayZ);
      if (die.where === 'tray' && die.v === d.v && die.mesh.position.distanceTo(to) < 0.01) return;
      die.v = d.v;
      die.where = 'tray';
      this.moveTo(die, to, faceUpQuat(d.v), TRAY_SCALE, animate);
    });
    let slot = 0;
    for (const d of turn.dice) {
      if (d.taken || d.v == null) continue;
      const die = this.dice[d.id];
      if (die.where === 'table' && die.v === d.v) continue;
      // Lage unbekannt (z. B. nach Wiederverbinden): ordentlich in die Tischmitte legen.
      this.place(die, slot++, d.v);
    }
    this.dirty = true;
  }

  moveTo(die, pos, quat, scale, animate) {
    const m = die.mesh;
    if (!animate) {
      m.position.copy(pos);
      m.quaternion.copy(quat);
      m.scale.setScalar(scale);
      this.dirty = true;
      return;
    }
    this.tweens = this.tweens.filter((t) => t.die !== die);
    this.tweens.push({
      die,
      p0: m.position.clone(),
      p1: pos,
      q0: m.quaternion.clone(),
      q1: quat,
      s0: m.scale.x,
      s1: scale,
      t0: performance.now() + 120,
      dur: 520,
    });
  }

  // ---------- Renderschleife ----------

  tick(now) {
    requestAnimationFrame(this.tick);
    let active = this.dirty;
    const pb = this.playback;
    if (pb) {
      const f = Math.min(pb.sim.frames - 1, Math.floor(((now - pb.t0) / 1000) * FPS));
      this.applyFrame(pb, Math.max(0, f));
      const evs = pb.sim.events;
      let played = 0;
      while (pb.ev < evs.length && evs[pb.ev].frame <= f) {
        // Nach einem Tab-Wechsel nicht alle verpassten Klacker auf einmal abfeuern.
        if (played++ < 4) this.onImpact(evs[pb.ev].kind, evs[pb.ev].v);
        pb.ev++;
      }
      if (f >= pb.sim.frames - 1) this.finishPlayback();
      active = true;
    }
    if (this.tweens.length) {
      active = true;
      this.tweens = this.tweens.filter((t) => {
        const k = Math.min(1, Math.max(0, (now - t.t0) / t.dur));
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const m = t.die.mesh;
        m.position.lerpVectors(t.p0, t.p1, e);
        m.position.y += Math.sin(Math.PI * e) * 0.9;
        m.quaternion.slerpQuaternions(t.q0, t.q1, e);
        m.scale.setScalar(t.s0 + (t.s1 - t.s0) * e);
        return k < 1;
      });
    }
    if (active) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }
}
