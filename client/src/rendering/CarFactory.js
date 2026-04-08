import * as THREE from 'three';
import { CARS } from '../core/Config.js';
import { loadModel } from './AssetLoader.js';

// Target bounding box for all cars (same as before)
const TARGET_BOX = new THREE.Vector3(2, 1.2, 1.2);

// Car type → GLB filename mapping
const CAR_MODELS = {
  FANG:    'sedan-sports.glb',
  HORNET:  'kart-oopi.glb',
  RHINO:   'truck.glb',
  VIPER:   'race.glb',
  TOAD:    'van.glb',
  LYNX:    'hatchback-sports.glb',
  MAMMOTH: 'tractor.glb',
  GHOST:   'race-future.glb',
};

/**
 * Preload all car GLBs. Call once at startup before any buildCar calls.
 * @param {(loaded: number, total: number) => void} [onProgress] - Optional progress callback
 */
export async function preloadCarModels(onProgress) {
  const paths = Object.values(CAR_MODELS).map((f) => `assets/models/${f}`);
  const total = paths.length;
  let loaded = 0;
  await Promise.all(paths.map(async (p) => {
    await loadModel(p);
    loaded++;
    if (onProgress) onProgress(loaded, total);
  }));
}

/**
 * Build a 3D car from a Kenney GLB model with original colormap texture,
 * normalized to ~2×1.2×1.2 bounding box.
 *
 * @param {string} carType - Key from CARS config (e.g. 'FANG')
 * @param {number} [playerColor] - Override color (hex). Falls back to car default.
 * @returns {Promise<THREE.Group>}
 */
export async function buildCar(carType, playerColor) {
  const config = CARS[carType];
  if (!config) throw new Error(`Unknown car type: ${carType}`);

  const glbFile = CAR_MODELS[carType];
  if (!glbFile) throw new Error(`No GLB model for car type: ${carType}`);

  const model = await loadModel(`assets/models/${glbFile}`);

  const group = new THREE.Group();
  group.name = carType;

  // Add the loaded model as a child
  group.add(model);

  // Clone materials so each car instance is independent
  // Boost metalness/roughness slightly for environment map reflections (car paint look)
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = child.material.clone();
      // Give car paint a subtle glossy sheen — environment map does the rest
      if (child.material.roughness !== undefined) {
        child.material.roughness = Math.min(child.material.roughness, 0.6);
        child.material.metalness = Math.max(child.material.metalness, 0.15);
        child.material.envMapIntensity = 0.8;
      }
    }
  });

  // Collect wheel node references for runtime animation, separated by axle
  const wheels = [];
  const frontWheels = [];
  const backWheels = [];
  const bodyParts = []; // non-wheel meshes (body, spoiler, etc.)
  model.traverse((child) => {
    if (child.name && child.name.startsWith('wheel-')) {
      // YXZ order: steer (Y) is applied first in world-space, then spin (X)
      // within the steered frame — matches real car kingpin → axle hierarchy
      child.rotation.order = 'YXZ';
      wheels.push(child);
      if (child.name.startsWith('wheel-front')) {
        frontWheels.push(child);
      } else {
        backWheels.push(child);
      }
    } else if (child.isMesh && child.name !== 'character') {
      bodyParts.push(child);
    }
  });
  // Cache emissive materials for fast per-frame updates (avoid mesh.traverse)
  const emissiveMaterials = [];
  model.traverse((child) => {
    if (child.isMesh && child.material && child.material.emissive) {
      emissiveMaterials.push(child.material);
    }
  });

  // Attach motion-blur disc overlays to each wheel
  _attachWheelBlurDiscs(wheels);

  // Find character/driver node for kart models (head lean when turning)
  let characterNode = null;
  model.traverse((child) => {
    if (child.name === 'character') {
      characterNode = child;
    }
  });

  group.userData.wheels = wheels;
  group.userData.frontWheels = frontWheels;
  group.userData.backWheels = backWheels;
  group.userData.bodyParts = bodyParts;
  group.userData.emissiveMaterials = emissiveMaterials;
  group.userData.characterNode = characterNode;

  // Normalize to target bounding box (includes 180° rotation to face -Z)
  _normalizeScale(group);

  // Compute actual roof height for turret mounting (varies per car shape)
  const _roofBox = new THREE.Box3().setFromObject(group);
  group.userData.roofY = _roofBox.max.y;

  // Enable shadows — cars cast but do NOT receive directional shadows
  // (receiveShadow on car meshes causes self-shadowing artifacts: black triangles)
  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = false;
    }
  });

  // Contact shadow — soft circular blob projected on the ground under the car
  // Uses a radial gradient texture for natural soft falloff
  const contactShadow = _createContactShadow();
  group.add(contactShadow);
  group.userData.contactShadow = contactShadow;

  return group;
}

/**
 * Create a self-contained preview scene for the car select screen.
 * Volcanic rock pedestal with lava rim and warm lighting.
 */
export async function getCarPreviewScene(carType, playerColor) {
  const scene = new THREE.Scene();
  // Transparent background — CSS shows through
  scene.background = null;

  // Warm volcanic lighting — bright enough to read car detail + cast shadows
  scene.add(new THREE.AmbientLight(0x553322, 1.0));

  // Key light: front-right, high — main shadow caster
  const key = new THREE.DirectionalLight(0xffeedd, 1.4);
  key.position.set(4, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 3;
  key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.002;
  scene.add(key);

  // Rim/back light: warm orange from behind-left
  const rim = new THREE.DirectionalLight(0xff6600, 0.6);
  rim.position.set(-3, 3, -4);
  scene.add(rim);

  // Fill from front-left to soften shadows
  const fill = new THREE.DirectionalLight(0xffaa66, 0.4);
  fill.position.set(-3, 2, 3);
  scene.add(fill);

  // Subtle uplight for undercarriage visibility
  const up = new THREE.DirectionalLight(0xff4400, 0.2);
  up.position.set(0, -2, 0);
  scene.add(up);

  // Rock pedestal — volcanic basalt look
  const pedestalGeo = new THREE.CylinderGeometry(1.15, 1.35, 0.25, 24);
  // Displace vertices slightly for a rough rock feel
  const posAttr = pedestalGeo.getAttribute('position');
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i);
    // Only displace side vertices (not top/bottom caps much)
    if (Math.abs(y) < 0.12) {
      const noise = (Math.random() - 0.5) * 0.06;
      posAttr.setX(i, posAttr.getX(i) + noise);
      posAttr.setZ(i, posAttr.getZ(i) + noise);
    }
  }
  pedestalGeo.computeVertexNormals();

  const pedestalMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.85,
    metalness: 0.1,
    emissive: 0x110800,
    emissiveIntensity: 0.3,
  });
  const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
  pedestal.position.y = -0.125;
  pedestal.receiveShadow = true;
  scene.add(pedestal);

  // Lava rim glow around the pedestal
  const ringGeo = new THREE.TorusGeometry(1.25, 0.05, 8, 48);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xff4400,
    emissive: 0xff4400,
    emissiveIntensity: 2.5,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.01;
  scene.add(ring);

  // Inner glow ring (softer, wider)
  const innerRingGeo = new THREE.TorusGeometry(1.2, 0.12, 6, 48);
  const innerRingMat = new THREE.MeshStandardMaterial({
    color: 0xff6600,
    emissive: 0xff6600,
    emissiveIntensity: 0.8,
    transparent: true,
    opacity: 0.3,
  });
  const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.position.y = -0.02;
  scene.add(innerRing);

  // Car on pedestal — start at 3/4 view (facing roughly toward camera-left)
  const car = await buildCar(carType, playerColor);
  car.rotation.y = Math.PI * 0.75; // 3/4 view (135°)
  scene.add(car);

  // Camera — slightly above eye level, looking at car center
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.6, 3.5);
  camera.lookAt(0, 0.15, 0);

  return {
    scene,
    camera,
    car,
    update(dt) {
      car.rotation.y += dt * 0.5;
    },
  };
}

/**
 * Spin wheel nodes on the X axis based on car speed,
 * steer front wheels on Y axis, and apply subtle contra-steer on rear.
 * @param {THREE.Group} carMesh - The car group returned by buildCar
 * @param {number} speed - Current car speed (units/s), signed
 * @param {number} dt - Frame delta time
 * @param {number} [steerAngle=0] - Current front wheel steer angle (rad)
 * @param {boolean} [driftMode=false] - Whether drift mode is active
 */
export function animateWheels(carMesh, speed, dt, steerAngle = 0, driftMode = false) {
  const wheels = carMesh.userData.wheels;
  if (!wheels || wheels.length === 0) return;

  // Wheel radius ~0.3 in normalized scale; angular velocity = speed / radius
  // Negative because forward motion = negative Z = positive X rotation
  const angularVelocity = -speed / 0.3;
  const deltaAngle = angularVelocity * dt;

  // Front wheel visual steer (Y-axis rotation)
  // steerAngle is positive=left, negative=right in physics space;
  // the 180° model rotation (_normalizeScale) flips local Y, so pass as-is
  const frontSteerY = steerAngle;
  // Subtle rear contra-steer during drift (opposite direction, ~15% of front)
  const rearContraY = driftMode ? -steerAngle * 0.15 : 0;

  const frontWheels = carMesh.userData.frontWheels;
  const backWheels = carMesh.userData.backWheels;

  if (frontWheels && frontWheels.length > 0) {
    for (const wheel of frontWheels) {
      wheel.rotation.x += deltaAngle;
      wheel.rotation.y = frontSteerY;
    }
  }
  if (backWheels && backWheels.length > 0) {
    for (const wheel of backWheels) {
      wheel.rotation.x += deltaAngle;
      wheel.rotation.y = rearContraY;
    }
  }

  // Fallback: wheels not categorized (shouldn't happen with Kenney models)
  if ((!frontWheels || frontWheels.length === 0) && (!backWheels || backWheels.length === 0)) {
    for (const wheel of wheels) {
      wheel.rotation.x += deltaAngle;
    }
  }

  // Update motion-blur disc opacity based on spin speed
  const absAngVel = Math.abs(angularVelocity);
  // Fade in between 8 and 30 rad/s (roughly 15-60 km/h with r=0.3)
  const blurAlpha = Math.min(Math.max((absAngVel - 8) / 22, 0), 1) * 0.4;
  for (const wheel of wheels) {
    const disc = wheel.userData.blurDisc;
    if (disc) disc.material.opacity = blurAlpha;
  }

  // Kart driver head lean — tilt the character into the turn direction
  const charNode = carMesh.userData.characterNode;
  if (charNode) {
    // steerAngle is small (~0.05 rad max), normalize to -1..1 range
    const normalizedSteer = Math.max(-1, Math.min(1, steerAngle / 0.06));
    const speedFactor = Math.min(Math.abs(speed) / 10, 1);
    const maxLean = 0.4; // ~23° max lean angle
    const targetLean = -normalizedSteer * speedFactor * maxLean;
    // Smooth toward target (stored on userData to persist across frames)
    const prev = charNode.userData._leanAngle || 0;
    const smoothing = 0.15;
    const lean = prev + (targetLean - prev) * smoothing;
    charNode.userData._leanAngle = lean;
    charNode.rotation.z = lean;
    // Slight forward lean into the turn
    charNode.rotation.x = Math.abs(lean) * 0.25;
  }
}

// ── Wheel motion-blur helpers ─────────────────────────────────────

// Shared blur disc material (one instance for all wheels, opacity updated per-frame)
let _blurDiscGeo = null;
let _blurDiscTexture = null;

function _getBlurDiscTexture() {
  if (_blurDiscTexture) return _blurDiscTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Radial gradient: solid center, fading edges
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.15, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(40,40,40,1)');
  grad.addColorStop(0.7, 'rgba(50,50,50,0.8)');
  grad.addColorStop(1, 'rgba(60,60,60,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _blurDiscTexture = new THREE.CanvasTexture(canvas);
  return _blurDiscTexture;
}

function _getBlurDiscGeo() {
  if (!_blurDiscGeo) {
    _blurDiscGeo = new THREE.PlaneGeometry(1, 1);
  }
  return _blurDiscGeo;
}

/**
 * Attach a semi-transparent blur disc as a child of each wheel.
 * The disc sits on the inner face of the wheel (local +Z) and becomes
 * visible only at high spin speeds to simulate motion blur.
 */
function _attachWheelBlurDiscs(wheels) {
  const geo = _getBlurDiscGeo();
  const texture = _getBlurDiscTexture();

  for (const wheel of wheels) {
    // Measure wheel bounding sphere to size the disc
    const bbox = new THREE.Box3().setFromObject(wheel);
    const wSize = bbox.getSize(new THREE.Vector3());
    // Disc diameter ≈ wheel height (Y) which is the visible face radius × 2
    const diameter = Math.max(wSize.y, wSize.z) * 0.95;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const disc = new THREE.Mesh(geo, mat);
    disc.scale.set(diameter, diameter, 1);
    // Orient disc to face outward along local X (the spin axis)
    disc.rotation.y = Math.PI / 2;
    disc.renderOrder = 1;
    wheel.add(disc);
    wheel.userData.blurDisc = disc;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function _normalizeScale(group) {
  // Wrap all children in an inner group for offset control
  const inner = new THREE.Group();
  inner.name = '_inner';
  while (group.children.length > 0) {
    inner.add(group.children[0]);
  }
  group.add(inner);

  // Rotate 180° so front faces -Z (the driving direction)
  inner.rotation.y = Math.PI;

  // Measure bounding box after rotation
  const bbox = new THREE.Box3().setFromObject(inner);
  const size = bbox.getSize(new THREE.Vector3());

  // Kenney cars: length along Z, width along X, height along Y
  const sx = TARGET_BOX.x / size.z; // car length maps to TARGET_BOX.x
  const sy = TARGET_BOX.y / size.y;
  const sz = TARGET_BOX.z / size.x; // car width maps to TARGET_BOX.z
  const scale = Math.min(sx, sy, sz);
  inner.scale.setScalar(scale);

  // Re-center: XZ center at origin, bottom at Y=0
  const scaledBox = new THREE.Box3().setFromObject(inner);
  const center = scaledBox.getCenter(new THREE.Vector3());
  inner.position.set(-center.x, -scaledBox.min.y, -center.z);
}

// Shared radial gradient texture (created once, reused by all cars)
let _contactShadowTexture = null;
function _getContactShadowTexture() {
  if (_contactShadowTexture) return _contactShadowTexture;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Radial gradient: opaque center → transparent edge
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
  gradient.addColorStop(0.4, 'rgba(0, 0, 0, 0.35)');
  gradient.addColorStop(0.7, 'rgba(0, 0, 0, 0.15)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  _contactShadowTexture = new THREE.CanvasTexture(canvas);
  return _contactShadowTexture;
}

function _createContactShadow() {
  const geo = new THREE.PlaneGeometry(2.8, 2.0);
  const mat = new THREE.MeshBasicMaterial({
    map: _getContactShadowTexture(),
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;
  mesh.name = '_contactShadow';
  mesh.renderOrder = -1;
  return mesh;
}
