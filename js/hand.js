// 3D scene + rigged hand. The model is the WebXR "generic-hand" (rigged, skinned, 25 joints).
// Its bones are a flat list (no parent chain), so finger curling is done with our own forward kinematics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createDemonMaterial, createClawGeometry, createClawMaterial } from './demon.js';

const CDN_MODEL = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/';
const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const LONG_FINGERS = ['index', 'middle', 'ring', 'pinky'];
export const FINGERS = ['thumb', ...LONG_FINGERS];
const tipBone = f => f === 'thumb' ? 'thumb-tip' : `${f}-finger-tip`;
const distalBone = f => f === 'thumb' ? 'thumb-phalanx-distal' : `${f}-finger-phalanx-distal`;
const fingerOfBone = name => FINGERS.find(f => name.startsWith(f)) ?? null;   // 'wrist' -> null
const chainFor = f => f === 'thumb'
  ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
  : [`${f}-finger-metacarpal`, `${f}-finger-phalanx-proximal`, `${f}-finger-phalanx-intermediate`,
     `${f}-finger-phalanx-distal`, `${f}-finger-tip`];

// Full-fist joint angles (degrees). In WebXR joint space -Z runs along the bone and +Y is the back of
// the hand, so flexion toward the palm is a negative rotation about local X.
const FIST = {
  index:  { meta: 0,  prox: 82, inter: 100, dist: 62, spread: 0 },
  middle: { meta: 0,  prox: 86, inter: 102, dist: 64, spread: 0 },
  ring:   { meta: 4,  prox: 88, inter: 102, dist: 64, spread: 0 },
  pinky:  { meta: 9,  prox: 90, inter: 98,  dist: 60, spread: 0 },
};
// Mark I (one sensor): fingers close pinky-first, like a real grip; thumb wraps last.
// Mark II drives each finger group from its own sensor, so there is no stagger.
const STAGGER = { pinky: 0.0, ring: 0.04, middle: 0.08, index: 0.12, thumb: 0.22 };

export const SKIN_TONES = {
  light:  0xf1c7ad, medium: 0xd9a080, tan: 0xb57a55, deep: 0x7a4a30, robot: 0xb8c4d0,
};

export class HandScene {
  constructor(container) {
    this.container = container;
    // Each finger has its own spring: curl = displayed (smoothed), target = desired curl from EMG.
    this.fingers = Object.fromEntries(FINGERS.map(f => [f, { curl: 0, velocity: 0, target: 0 }]));
    this.stagger = true;     // pinky-first closing (Mark I); off for Mark II
    this.responsiveness = 9; // spring natural frequency (rad/s)
    this.thumbOverride = null; // for tuning: {meta:[x,y,z], prox, dist}
    this.demon = false;      // demon look on/off
    this.glow = 0;           // strongest finger curl, 0..1 (drives the demon glow)
    this.paused = false;     // skip rendering while the 3D view is hidden
    this._initRenderer();
    this._initScene();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _initRenderer() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.prepend(r.domElement);
    new ResizeObserver(() => this._resize()).observe(this.container);
  }

  _initScene() {
    const scene = this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    this.homeCam = new THREE.Vector3(0.5, 0.3, 4.1);
    this.camera.position.copy(this.homeCam);

    const controls = this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.target.set(0, 0.05, 0);
    controls.enableDamping = true;
    controls.minDistance = 2.2; controls.maxDistance = 9;
    controls.enablePan = false;
    this.renderer.domElement.addEventListener('dblclick', () => this.resetView());

    // Key light (warm, soft shadows), cool rim from behind, gentle sky/ground fill.
    const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
    key.position.set(2.5, 4, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -2; key.shadow.camera.right = 2;
    key.shadow.camera.top = 2; key.shadow.camera.bottom = -2;
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 12;
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    key.shadow.radius = 6;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xb9d4ff, 2.2);
    rim.position.set(-3, 2.5, -3.5);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2a22, 0.35));
    // Demon mode: red light in front of the palm that brightens with effort, as if from the veins.
    // Kept in the scene at zero intensity otherwise, so toggling the look doesn't rebuild shaders.
    this.glowLight = new THREE.PointLight(0xff2a0a, 0, 4, 2);
    this.glowLight.position.set(0, -0.35, 0.9);

    // Soft contact shadow on an invisible floor.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.ShadowMaterial({ opacity: 0.28 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.9;
    floor.receiveShadow = true;
    scene.add(floor);

    this.handRoot = new THREE.Group();   // orientation + idle sway
    this.handRoot.add(this.glowLight);
    scene.add(this.handRoot);
    this._resize();
  }

  resetView() {
    this.camera.position.copy(this.homeCam);
    this.controls.target.set(0, 0.05, 0);
  }

  // Target curl for every finger at once (a number), or per finger ({ thumb, index, middle, ring, pinky }).
  setTargets(t) {
    for (const f of FINGERS) this.fingers[f].target = typeof t === 'number' ? t : (t[f] ?? 0);
  }
  set target(v) { this.setTargets(v); }
  get target() { return this.fingers.index.target; }
  get curl() { return Math.max(...FINGERS.map(f => this.fingers[f].curl)); }
  curlOf(finger) { return this.fingers[finger].curl; }

  async loadHand(side = 'right', skin = 'medium') {
    this.skin = skin;
    const file = `${side}.glb`;
    const loader = new GLTFLoader();
    let gltf;
    const embedded = window.EMGHAND_MODELS?.[side];                     // base64 bundle (hosted build)
    if (embedded) {
      const bytes = Uint8Array.from(atob(embedded), ch => ch.charCodeAt(0));
      gltf = await loader.parseAsync(bytes.buffer, '');
    }
    else try { gltf = await loader.loadAsync(`assets/${file}`); }      // offline copy (download-assets.ps1)
    catch { gltf = await loader.loadAsync(CDN_MODEL + file); }

    if (this.model) {
      this.handRoot.remove(this.model.parent);
      this.demonMaterial?.dispose();
      for (const claw of Object.values(this.claws ?? {})) { claw.geometry.dispose(); claw.material.dispose(); }
    }
    const model = this.model = gltf.scene;
    const bones = this.bones = {};
    model.traverse(o => {
      if (o.isBone) bones[o.name] = o;
      if (o.isSkinnedMesh) {
        this.mesh = o;
        o.castShadow = true; o.receiveShadow = true;
        o.frustumCulled = false;
        o.geometry.computeVertexNormals();
        o.material = this.skinMaterial = new THREE.MeshPhysicalMaterial({
          color: SKIN_TONES[skin] ?? SKIN_TONES.medium,
          roughness: 0.52,
          metalness: 0.0,
          sheen: 0.6, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xff8a70),  // soft, fleshy edge glow
          clearcoat: 0.08, clearcoatRoughness: 0.6,
          specularIntensity: 0.55,
        });
      }
    });
    this._applySkinLook(skin);

    // Remember rest pose for FK.
    this.rest = {};
    for (const [name, b] of Object.entries(bones)) this.rest[name] = { p: b.position.clone(), q: b.quaternion.clone() };
    this._buildDemon();

    // Orient the model: fingers up, palm toward the camera, scaled to ~2 units tall.
    const wrist = this.rest['wrist'].p;
    const midTip = this.rest['middle-finger-tip'].p;
    const up = midTip.clone().sub(wrist).normalize();
    const back = Y.clone().applyQuaternion(this.rest['middle-finger-phalanx-proximal'].q);
    const palm = back.negate().sub(up.clone().multiplyScalar(back.dot(up))).normalize();
    const side3 = new THREE.Vector3().crossVectors(up, palm);
    const basis = new THREE.Matrix4().makeBasis(side3, up, palm);
    const orient = new THREE.Group();
    orient.quaternion.setFromRotationMatrix(basis).invert();
    const scale = 2.0 / midTip.distanceTo(wrist) * 0.62;
    orient.scale.setScalar(scale);
    const center = this.rest['middle-finger-metacarpal'].p.clone().lerp(midTip, 0.25);
    model.position.copy(center).negate();
    orient.add(model);
    this.handRoot.add(orient);
    // 3/4 view: turn slightly so the curl is visible in depth, tilt toward the camera.
    this.baseRot = new THREE.Euler(-0.12, side === 'right' ? -0.45 : 0.45, 0);
    this.side = side;
    this._poseFingers(0);
  }

  setSkin(skin) {
    this.skin = skin;
    if (!this.skinMaterial) return;
    this.skinMaterial.color.setHex(SKIN_TONES[skin] ?? SKIN_TONES.medium);
    this._applySkinLook(skin);
  }

  _applySkinLook(skin) {
    const m = this.skinMaterial;
    if (!m) return;
    const robot = skin === 'robot';
    m.metalness = robot ? 0.65 : 0.0;
    m.roughness = robot ? 0.32 : 0.52;
    m.sheen = robot ? 0.0 : 0.6;
    m.clearcoat = robot ? 0.6 : 0.08;
  }

  // ---- demon look ----
  // Builds the demon skin and the claws for the loaded model (called on every model load).
  _buildDemon() {
    const mesh = this.mesh;
    const wrist = this.rest['wrist'].p, midTip = this.rest['middle-finger-tip'].p;
    this.demonMaterial = createDemonMaterial({
      boneCount: mesh.skeleton.bones.length,
      veinAxis: midTip.clone().sub(wrist),
      handLength: midTip.distanceTo(wrist),
    });
    // Which finger each skeleton bone belongs to, in the order the shader sees them.
    this.boneFingers = mesh.skeleton.bones.map(b => fingerOfBone(b.name));

    this.claws = {};
    for (const f of FINGERS) {
      const tip = this.bones[tipBone(f)];
      const distalLen = this.rest[tipBone(f)].p.distanceTo(this.rest[distalBone(f)].p);
      const claw = new THREE.Mesh(
        createClawGeometry({ length: distalLen * (f === 'thumb' ? 2.1 : 2.5), radius: distalLen * (f === 'thumb' ? 0.32 : 0.42) }),
        createClawMaterial());
      // In the tip joint's space -Z points out of the finger and +Y is the nail side: the claw grows
      // out of where the nail would be and curls toward the palm.
      claw.position.set(0, distalLen * 0.3, distalLen * 0.1);
      claw.castShadow = true;
      tip.add(claw);
      this.claws[f] = claw;
    }
    this.setDemon(this.demon);
  }

  setDemon(on) {
    this.demon = on;
    if (!this.mesh) return;
    this.mesh.material = on ? this.demonMaterial : this.skinMaterial;
    for (const claw of Object.values(this.claws)) claw.visible = on;
    if (!on) this.glowLight.intensity = 0;
  }

  _updateDemon(dt) {
    const clamp01 = v => Math.min(1, Math.max(0, v));
    const g = Object.fromEntries(FINGERS.map(f => [f, clamp01(this.fingers[f].curl)]));
    this.glow = Math.max(...Object.values(g));
    if (!this.demon || !this.demonMaterial) return;
    const u = this.demonMaterial.userData.uniforms;
    // Palm/wrist bones follow the strongest finger group.
    this.boneFingers.forEach((f, i) => { u.uBoneGlow.value[i] = f ? g[f] : this.glow * 0.85; });
    u.uPhase.value += dt * (1.6 + 5 * this.glow);     // the pulse along the veins speeds up with effort
    for (const f of FINGERS) this.claws[f].material.emissiveIntensity = 1.4 * g[f] * g[f];
    this.glowLight.intensity = 0.15 + 2.0 * this.glow * this.glow;
  }

  // ---- animation ----
  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.paused) return;
    const t = this.clock.elapsedTime;

    // Critically-damped spring toward the EMG target, one per finger: smooth, no overshoot, proportional.
    const w = this.responsiveness;
    for (const f of FINGERS) {
      const s = this.fingers[f];
      const acc = w * w * (s.target - s.curl) - 2 * w * s.velocity;
      s.velocity += acc * dt;
      s.curl += s.velocity * dt;
      s.curl = Math.min(1.05, Math.max(-0.02, s.curl));
    }

    if (this.bones) {
      // Subtle idle life: slow sway + breathing.
      const b = this.baseRot;
      this.handRoot.rotation.set(b.x + Math.sin(t * 0.7) * 0.025, b.y + Math.sin(t * 0.43) * 0.04, Math.sin(t * 0.55) * 0.015);
      this.handRoot.position.y = Math.sin(t * 0.9) * 0.015;
      this._poseFingers(t);
      this._updateDemon(dt);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _poseFingers(t) {
    const ease = x => x * x * (3 - 2 * x);
    const local = (finger) => {
      const c = Math.min(1, Math.max(0, this.fingers[finger].curl));
      if (!this.stagger) return c;    // Mark II: joint angles directly proportional to the sensor
      const s = STAGGER[finger];
      return ease(Math.min(1, Math.max(0, (c - s) / (1 - s))));
    };

    for (const f of LONG_FINGERS) {
      const k = local(f);
      const a = FIST[f];
      const micro = Math.sin(t * 1.3 + f.length) * 1.2 * (1 - k);  // tiny relaxed drift
      // At rest keep a hint of natural flexion so the open hand doesn't look rigid.
      const rots = [
        [[X, -(a.meta * k) * DEG]],
        [[X, -(4 + micro + (a.prox - 4) * k) * DEG]],
        [[X, -(5 + (a.inter - 5) * ease(Math.min(1, k * 1.08))) * DEG]],
        [[X, -(3 + (a.dist - 3) * ease(Math.min(1, k * 1.15))) * DEG]],
      ];
      this._fk(chainFor(f), rots);
    }

    const k = local('thumb');
    // Thumb angles were fitted so the thumb pad lands across the index/middle middle phalanges.
    const th = this.thumbOverride ?? { meta: [-20, 30, 30], prox: 50, dist: 70 };
    this._fk(chainFor('thumb'), [
      [[X, th.meta[0] * k * DEG], [Y, th.meta[1] * k * DEG], [Z, th.meta[2] * k * DEG]],
      [[X, -(3 + (th.prox - 3) * k) * DEG]],
      [[X, -(4 + (th.dist - 4) * k) * DEG]],
    ]);
  }

  // Apply joint rotations down a flat chain of bones. rots[k] = list of [localAxis, angle] for joint k.
  _fk(names, rots) {
    const n = names.length;
    const pos = names.map(nm => this.rest[nm].p.clone());
    const quat = names.map(nm => this.rest[nm].q.clone());
    const q = new THREE.Quaternion(), axis = new THREE.Vector3(), d = new THREE.Vector3();
    for (let k = 0; k < rots.length && k < n - 1; k++) {
      for (const [la, ang] of rots[k]) {
        if (!ang) continue;
        axis.copy(la).applyQuaternion(quat[k]);
        q.setFromAxisAngle(axis, ang);
        const pivot = pos[k];
        for (let j = k; j < n; j++) {
          quat[j].premultiply(q);
          if (j > k) pos[j].copy(d.copy(pos[j]).sub(pivot).applyQuaternion(q).add(pivot));
        }
      }
    }
    for (let j = 0; j < n; j++) {
      const b = this.bones[names[j]];
      b.position.copy(pos[j]);
      b.quaternion.copy(quat[j]);
    }
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the hand framed on narrow/portrait windows.
    this.camera.fov = w / h < 1 ? 32 / Math.max(w / h, 0.55) : 32;
    this.camera.updateProjectionMatrix();
  }
}
