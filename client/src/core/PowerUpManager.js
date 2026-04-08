import * as THREE from 'three';
import { ARENA, POWERUPS, COLLISION_GROUPS } from './Config.js';
import { loadModel } from '../rendering/AssetLoader.js';

const PEDESTAL_COUNT = ARENA.powerupPedestalCount; // 6
const RESPAWN_TIME = ARENA.powerupRespawnTime;      // 8s
const PICKUP_RADIUS = 2.0;
const FLOAT_HEIGHT = 1.4;
const SPIN_SPEED = 2.0;
const BOX_MODEL_PATH = 'assets/models/box.glb';

// Rainbow colors for rotating glow
const RAINBOW_COLORS = [
  new THREE.Color(0xff0000),
  new THREE.Color(0xff8800),
  new THREE.Color(0xffff00),
  new THREE.Color(0x00ff00),
  new THREE.Color(0x0088ff),
  new THREE.Color(0x8800ff),
];

const POWERUP_TYPES = Object.keys(POWERUPS);

// Procedural radial glow texture (generated once, shared by all glow sprites)
const _glowTexture = (() => {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(0.7, 'rgba(255,255,255,0.1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
})();

/**
 * Swept-sphere test: checks if a moving point (segment from prev to curr)
 * passes within `radius` of a stationary target point.
 * Returns true if the closest point on the segment is within radius.
 */
function sweptSphereHit(prevX, prevZ, currX, currZ, targetX, targetY, targetZ, projY, radius) {
  // Vertical check first (cheap early-out)
  if (Math.abs(targetY - projY) > radius) return false;

  const segX = currX - prevX;
  const segZ = currZ - prevZ;
  const segLenSq = segX * segX + segZ * segZ;

  // If segment is zero-length, fall back to point check
  if (segLenSq < 0.0001) {
    const dx = targetX - currX;
    const dz = targetZ - currZ;
    const dy = targetY - projY;
    return (dx * dx + dz * dz + dy * dy) < radius * radius;
  }

  // Project target onto segment, clamped to [0, 1]
  const toTargetX = targetX - prevX;
  const toTargetZ = targetZ - prevZ;
  let t = (toTargetX * segX + toTargetZ * segZ) / segLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  // Closest point on segment to target
  const closestX = prevX + segX * t;
  const closestZ = prevZ + segZ * t;
  const dx = targetX - closestX;
  const dz = targetZ - closestZ;
  const dy = targetY - projY;

  return (dx * dx + dz * dz + dy * dy) < radius * radius;
}

// ── Shared geometries & materials (created once, reused everywhere) ──
const _sharedGeo = {
  trailParticle: new THREE.SphereGeometry(0.08, 3, 3),
  debrisBox: new THREE.BoxGeometry(0.1, 0.1, 0.1),
  explosionFlash: new THREE.SphereGeometry(1.5, 8, 6),
  shatterChunkSmall: new THREE.DodecahedronGeometry(0.15, 0),
  shatterChunkLarge: new THREE.DodecahedronGeometry(0.25, 0),
  dustCloud: new THREE.SphereGeometry(2, 6, 4),
  // Missile parts
  missileCone: new THREE.ConeGeometry(0.15, 0.5, 6),
  missileBody: new THREE.CylinderGeometry(0.15, 0.18, 0.8, 6),
  missileFin: new THREE.BoxGeometry(0.02, 0.25, 0.3),
  missileExhaust: new THREE.SphereGeometry(0.12, 6, 4),
  // Shield parts
  shieldSphere: new THREE.IcosahedronGeometry(2.2, 2),
  shieldWire: new THREE.IcosahedronGeometry(2.2 * 1.01, 2),
  shieldRing: new THREE.TorusGeometry(2.35, 0.04, 6, 32),
};

// Shared materials (cloned per instance only when opacity/color must differ)
const _sharedMat = {
  trailOrange: new THREE.MeshBasicMaterial({
    color: 0xff8800, transparent: true, opacity: 0.8, depthWrite: false,
  }),
  trailPink: new THREE.MeshBasicMaterial({
    color: 0xff44ff, transparent: true, opacity: 0.8, depthWrite: false,
  }),
  debrisOrange: new THREE.MeshBasicMaterial({ color: 0xff6600 }),
  debrisPink: new THREE.MeshBasicMaterial({ color: 0xff44ff }),
  shatterRock: new THREE.MeshBasicMaterial({ color: 0x6a5a4a }),
  missileTip: new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.8, roughness: 0.2,
  }),
  missileFin: new THREE.MeshStandardMaterial({
    color: 0x222222, metalness: 0.6, roughness: 0.4,
  }),
};

/**
 * PowerUpManager — spawns, renders, and handles pickup of arena power-ups.
 * Manages active missile projectiles and shield effects.
 *
 * Performance-optimized: shared geometries, MeshBasicMaterial for particles,
 * all VFX animated in the main update loop (no separate rAF chains).
 */
export class PowerUpManager {
  constructor(scene, world, getCarBodies) {
    this.scene = scene;
    this.world = world;
    this.getCarBodies = getCarBodies;

    this._listeners = {};
    this._held = new Map();

    // Active projectiles
    this._projectiles = [];

    // Active shields
    this._activeShields = [];

    // Transient VFX (explosions, shatter chunks, dust clouds) — ticked in update()
    this._vfxObjects = [];

    // Obstacle refs (set by Game.js)
    this.obstacleBodies = null;
    this.obstacleGroups = null;

    // Out-of-bounds limit for projectiles (half-extent of playable area)
    this._oobLimit = ARENA.diameter * 0.7;

    // Audio context (lazy)
    this._audioCtx = null;
    this._explosionNoiseBuffer = null;  // cached noise buffer
    this._launchNoiseBuffer = null;     // cached noise buffer

    // Pedestals
    this._pedestals = [];
    this._pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x3d2b1a, roughness: 0.5, metalness: 0.4,
    });

    this._boxModelReady = loadModel(BOX_MODEL_PATH).then((model) => {
      this._boxTemplate = model;
    }).catch((err) => {
      console.warn('PowerUpManager: failed to load box model, falling back', err);
      this._boxTemplate = null;
    });

    this._buildPedestals();
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, fn) { (this._listeners[event] ??= []).push(fn); }
  _emit(event, data) {
    const arr = this._listeners[event];
    if (arr) for (const fn of arr) fn(data);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(dt) {
    const now = performance.now();
    const carBodies = this.getCarBodies();

    // ── Pedestal logic (unchanged) ──
    for (const pedestal of this._pedestals) {
      if (!pedestal.active && pedestal.respawnAt > 0 && now >= pedestal.respawnAt) {
        this._spawnPickup(pedestal);
      }

      if (pedestal.active && pedestal.pickupMesh) {
        const mesh = pedestal.pickupMesh;
        mesh.position.y =
          (pedestal.y || 0) + FLOAT_HEIGHT + Math.sin(now * 0.003 + pedestal.angle) * 0.15;

        if (mesh.userData.boxMesh) {
          mesh.userData.boxMesh.rotation.y += SPIN_SPEED * 0.5 * dt;
        }

        const t = (now * 0.001 + pedestal.angle) % 6;
        const idx = Math.floor(t);
        const frac = t - idx;
        const colorA = RAINBOW_COLORS[idx % 6];
        const colorB = RAINBOW_COLORS[(idx + 1) % 6];
        const rainbowColor = new THREE.Color().lerpColors(colorA, colorB, frac);

        const t2 = (now * 0.001 + pedestal.angle + 3) % 6;
        const idx2 = Math.floor(t2);
        const frac2 = t2 - idx2;
        const rainbowColor2 = new THREE.Color().lerpColors(
          RAINBOW_COLORS[idx2 % 6], RAINBOW_COLORS[(idx2 + 1) % 6], frac2);

        const ringAngle = now * 0.002 + pedestal.angle;
        if (mesh.userData.glowRing) {
          mesh.userData.glowRing.rotation.x = ringAngle;
          mesh.userData.glowRing.rotation.y = ringAngle * 0.7;
          mesh.userData.glowRingMat.emissive.copy(rainbowColor);
          mesh.userData.glowRingMat.color.copy(rainbowColor);
        }
        if (mesh.userData.glowRing2) {
          mesh.userData.glowRing2.rotation.x = ringAngle * 0.5 + Math.PI / 2;
          mesh.userData.glowRing2.rotation.z = ringAngle * 0.8;
          mesh.userData.glowRing2Mat.emissive.copy(rainbowColor2);
          mesh.userData.glowRing2Mat.color.copy(rainbowColor2);
        }

        pedestal.glowLight.color.copy(rainbowColor);
        pedestal.glowLight.intensity =
          0.6 + Math.sin(now * 0.004 + pedestal.angle * 2) * 0.3;
      }

      if (pedestal.active) {
        for (const car of carBodies) {
          if (this._held.get(car)) continue;
          const dx = car.body.position.x - pedestal.x;
          const dz = car.body.position.z - pedestal.z;
          const dy = car.body.position.y - (pedestal.y || 0);
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < PICKUP_RADIUS && Math.abs(dy) < 3) {
            this._pickup(pedestal, car);
            break;
          }
        }
      }
    }

    // ── Update active projectiles ──
    this._updateProjectiles(dt, carBodies);

    // ── Update active shields ──
    this._updateShields(dt);

    // ── Tick transient VFX (explosions, debris, dust) ──
    this._updateVFX(dt);
  }

  // ── Use held power-up ─────────────────────────────────────────────────

  use(car) {
    const type = this._held.get(car);
    if (!type) return false;
    this._held.set(car, null);
    this._applyEffect(type, car);
    this._emit('used', { car, type });
    return true;
  }

  drop(car) { this._held.set(car, null); }
  getHeld(car) { return this._held.get(car) || null; }
  getHeldConfig(car) {
    const type = this._held.get(car);
    return type ? POWERUPS[type] : null;
  }

  // ── Build pedestals ───────────────────────────────────────────────────

  _buildPedestals() {
    const dist = ARENA.diameter / 2 * 0.45;
    for (let i = 0; i < PEDESTAL_COUNT; i++) {
      const angle = (i / PEDESTAL_COUNT) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const yBase = 0;

      const pedestalGeo = new THREE.CylinderGeometry(0.8, 1.0, 0.4, 16);
      const pedestal = new THREE.Mesh(pedestalGeo, this._pedestalMat);
      pedestal.position.set(x, yBase + 0.2, z);
      pedestal.receiveShadow = true;
      this.scene.add(pedestal);

      const ringGeo = new THREE.TorusGeometry(1.0, 0.08, 8, 32);
      const ringMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xff6600, emissiveIntensity: 2,
        transparent: true, opacity: 0.7,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(x, yBase + 0.8, z);
      ring.rotation.x = Math.PI / 2;
      this.scene.add(ring);

      const light = new THREE.PointLight(0xff6600, 0.4, 8);
      light.position.set(x, yBase + 1.6, z);
      this.scene.add(light);

      const slot = {
        index: i, x, z, y: yBase, angle,
        pedestalMesh: pedestal, ringMesh: ring, ringMat, glowLight: light,
        active: false, type: null, pickupMesh: null, respawnAt: 0,
      };
      this._pedestals.push(slot);
      this._spawnPickup(slot);
    }
  }

  // ── Spawn pickup ──────────────────────────────────────────────────────

  _spawnPickup(pedestal) {
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    const group = new THREE.Group();
    group.position.set(pedestal.x, (pedestal.y || 0) + FLOAT_HEIGHT, pedestal.z);

    const glowRingGeo = new THREE.TorusGeometry(1.0, 0.08, 8, 32);
    const glowRingMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xff0000, emissiveIntensity: 3,
      transparent: true, opacity: 0.7,
    });
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    group.add(glowRing);

    const glowRing2Mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x00ff00, emissiveIntensity: 3,
      transparent: true, opacity: 0.7,
    });
    const glowRing2 = new THREE.Mesh(glowRingGeo, glowRing2Mat);
    group.add(glowRing2);

    group.userData.glowRing = glowRing;
    group.userData.glowRingMat = glowRingMat;
    group.userData.glowRing2 = glowRing2;
    group.userData.glowRing2Mat = glowRing2Mat;
    group.userData.boxMesh = null;

    if (this._boxTemplate) {
      this._addBoxModel(group);
    } else {
      this._boxModelReady.then(() => {
        if (pedestal.pickupMesh === group && pedestal.active) {
          this._addBoxModel(group);
        }
      });
    }

    this.scene.add(group);
    pedestal.ringMat.emissive.setHex(0xffffff);
    pedestal.glowLight.color.setHex(0xffffff);
    pedestal.glowLight.intensity = 0.6;
    pedestal.active = true;
    pedestal.type = type;
    pedestal.pickupMesh = group;
    pedestal.respawnAt = 0;
  }

  _addBoxModel(group) {
    if (!this._boxTemplate) return;
    const box = this._boxTemplate.clone(true);
    box.scale.setScalar(1.2);
    box.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    const bbox = new THREE.Box3().setFromObject(box);
    box.position.y = -(bbox.min.y + bbox.max.y) / 2;
    group.add(box);
    group.userData.boxMesh = box;
  }

  // ── Pickup ────────────────────────────────────────────────────────────

  _pickup(pedestal, car) {
    this._held.set(car, pedestal.type);
    if (pedestal.pickupMesh) {
      this.scene.remove(pedestal.pickupMesh);
      pedestal.pickupMesh = null;
    }
    pedestal.active = false;
    pedestal.ringMat.emissive.setHex(0x222222);
    pedestal.glowLight.intensity = 0.1;
    pedestal.respawnAt = performance.now() + RESPAWN_TIME * 1000;
    this._emit('pickup', { car, type: pedestal.type, pedestalIndex: pedestal.index });
  }

  // ── Apply effect ──────────────────────────────────────────────────────

  _applyEffect(type, car) {
    switch (type) {
      case 'MISSILE':        this._fireMissile(car, false); break;
      case 'HOMING_MISSILE': this._fireMissile(car, true);  break;
      case 'SHIELD':         this._applyShield(car);         break;
    }
  }

  // =====================================================================
  //  MISSILE & HOMING MISSILE
  // =====================================================================

  _fireMissile(car, isHoming) {
    const config = isHoming ? POWERUPS.HOMING_MISSILE : POWERUPS.MISSILE;
    const yaw = car._yaw;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);

    const spawnX = car.body.position.x + fwdX * 2.0;
    const spawnZ = car.body.position.z + fwdZ * 2.0;
    const spawnY = car.body.position.y + 0.5;

    let speed;
    if (isHoming) {
      speed = config.speed;
    } else {
      const carSpeed = Math.sqrt(
        car.body.velocity.x * car.body.velocity.x +
        car.body.velocity.z * car.body.velocity.z
      );
      speed = Math.max(carSpeed * (1 + config.speedBonus), 20);
    }

    // Build missile mesh (shared geometries)
    const missileGroup = this._createMissileMesh(isHoming);
    missileGroup.position.set(spawnX, spawnY, spawnZ);
    missileGroup.rotation.y = yaw;
    // Missiles don't need to cast or receive shadows
    missileGroup.traverse((child) => {
      if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; }
    });
    this.scene.add(missileGroup);

    // Emissive glow sprite (replaces PointLight — zero shader cost, bloom provides glow)
    // Glow color shifted lighter than missile body for contrast
    const glowColor = isHoming ? 0xff66cc : 0xffaa44;
    const missileGlowMat = new THREE.SpriteMaterial({
      map: _glowTexture,
      color: glowColor,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const missileGlow = new THREE.Sprite(missileGlowMat);
    missileGlow.scale.setScalar(1.6);
    missileGlow.renderOrder = 999;
    missileGlow.position.set(spawnX, spawnY, spawnZ);
    this.scene.add(missileGlow);

    const projectile = {
      isHoming, owner: car, config,
      group: missileGroup, glow: missileGlow, glowMat: missileGlowMat,
      x: spawnX, y: spawnY, z: spawnZ,
      prevX: spawnX, prevZ: spawnZ, // previous position for swept collision
      vx: fwdX * speed, vz: fwdZ * speed, speed, yaw,
      age: 0, lifetime: config.lifetime,
      target: null,
      straightTimer: isHoming ? config.straightTime : 999,
      lostLockTimer: 0,
      // Trail: reuse pool of meshes instead of create/destroy
      trailPool: [],
      trailPoolIdx: 0,
      trailSpawnTimer: 0,
      alive: true,
    };

    // Pre-allocate trail particle pool (max ~14 visible at once at 0.05s interval × 0.4s life)
    const TRAIL_POOL_SIZE = 10;
    const trailMat = isHoming ? _sharedMat.trailPink : _sharedMat.trailOrange;
    for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(_sharedGeo.trailParticle, trailMat);
      mesh.visible = false;
      this.scene.add(mesh);
      projectile.trailPool.push({ mesh, life: 0, active: false });
    }

    if (isHoming) {
      projectile.target = this._findHomingTarget(projectile);
    }

    this._projectiles.push(projectile);
    this._playMissileLaunchSFX(isHoming);
  }

  _createMissileMesh(isHoming) {
    const group = new THREE.Group();
    const color = isHoming ? 0xcc00cc : 0xcc2200;
    const emissiveColor = isHoming ? 0xff00ff : 0xff4400;

    // Nose cone (shared geo)
    const cone = new THREE.Mesh(_sharedGeo.missileCone, _sharedMat.missileTip);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -0.55;
    group.add(cone);

    // Body (unique material for emissive color)
    const bodyMat = new THREE.MeshStandardMaterial({
      color, emissive: emissiveColor, emissiveIntensity: 0.5,
      metalness: 0.4, roughness: 0.3,
    });
    const body = new THREE.Mesh(_sharedGeo.missileBody, bodyMat);
    body.rotation.x = Math.PI / 2;
    body.position.z = -0.1;
    group.add(body);

    // 4 fins (shared geo + mat)
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(_sharedGeo.missileFin, _sharedMat.missileFin);
      const angle = (i / 4) * Math.PI * 2;
      fin.position.set(Math.cos(angle) * 0.18, Math.sin(angle) * 0.18, 0.25);
      fin.rotation.z = angle;
      group.add(fin);
    }

    // Exhaust glow (MeshBasicMaterial — no lighting needed)
    const exhaustMat = new THREE.MeshBasicMaterial({
      color: isHoming ? 0xff44ff : 0xff8800,
      transparent: true, opacity: 0.8,
    });
    const exhaust = new THREE.Mesh(_sharedGeo.missileExhaust, exhaustMat);
    exhaust.position.z = 0.45;
    group.add(exhaust);
    group.userData.exhaust = exhaust;
    group.userData.bodyMat = bodyMat;
    group.userData.exhaustMat = exhaustMat;

    return group;
  }

  _updateProjectiles(dt, carBodies) {
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      if (!p.alive) { this._removeProjectile(i); continue; }

      p.age += dt;
      if (p.age >= p.lifetime) {
        this._detonateProjectile(p);
        this._removeProjectile(i);
        continue;
      }

      // Homing guidance
      if (p.isHoming && p.age > p.straightTimer) {
        this._updateHomingGuidance(p, dt, carBodies);
      }

      // Acceleration (regular missile)
      if (!p.isHoming) {
        p.speed += p.config.accel * dt;
        const fwdX = -Math.sin(p.yaw);
        const fwdZ = -Math.cos(p.yaw);
        p.vx = fwdX * p.speed;
        p.vz = fwdZ * p.speed;
      }

      // Save previous position for swept collision
      p.prevX = p.x;
      p.prevZ = p.z;

      // Move
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += (0.5 - p.y) * 3 * dt;

      // Sync mesh
      p.group.position.set(p.x, p.y, p.z);
      p.group.rotation.y = p.yaw;
      p.glow.position.set(p.x, p.y, p.z);

      // Exhaust flicker
      const exhaust = p.group.userData.exhaust;
      if (exhaust) {
        exhaust.scale.setScalar(0.6 + Math.sin(p.age * 40) * 0.4);
      }

      // Trail particles (pooled — no alloc/dealloc)
      p.trailSpawnTimer -= dt;
      if (p.trailSpawnTimer <= 0) {
        p.trailSpawnTimer = 0.05; // slower spawn rate than before (0.03 → 0.05)
        this._emitTrailParticle(p);
      }
      this._tickTrailPool(p, dt);

      // Collision: cars (swept sphere — traces the full path to prevent tunneling)
      let hit = false;
      for (const car of carBodies) {
        if (car === p.owner || car.isEliminated || car.isInvincible) continue;
        if (sweptSphereHit(
          p.prevX, p.prevZ, p.x, p.z,
          car.body.position.x, car.body.position.y, car.body.position.z,
          p.y, 1.5,
        )) {
          car.takeDamage(p.config.damage, p.owner, false);
          const knockback = 8;
          car.body.velocity.x -= Math.sin(p.yaw) * knockback;
          car.body.velocity.z -= Math.cos(p.yaw) * knockback;
          car.body.velocity.y += 2;
          car.lastHitBy = { source: p.owner, wasAbility: false, time: performance.now() };
          this._detonateProjectile(p);
          this._emit('powerup-hit', { attacker: p.owner, victim: car, type: p.isHoming ? 'HOMING_MISSILE' : 'MISSILE' });
          hit = true;
          break;
        }
      }
      if (hit) { this._removeProjectile(i); continue; }

      // Collision: obstacles (swept sphere along missile path)
      if (this.obstacleBodies) {
        for (let j = this.obstacleBodies.length - 1; j >= 0; j--) {
          const ob = this.obstacleBodies[j];
          const hitDist = (ob._obstacleRadius || 2) + 0.5;
          if (sweptSphereHit(
            p.prevX, p.prevZ, p.x, p.z,
            ob.position.x, ob.position.y, ob.position.z,
            p.y, hitDist,
          )) {
            this._destroyObstacle(j);
            this._detonateProjectile(p);
            hit = true;
            break;
          }
        }
      }
      if (hit) { this._removeProjectile(i); continue; }

      // Out of bounds (square check — works for both arena and sandbox maps)
      const oobLimit = this._oobLimit;
      if (Math.abs(p.x) > oobLimit || Math.abs(p.z) > oobLimit) {
        p.alive = false;
        this._removeProjectile(i);
      }
    }
  }

  // ── Homing guidance (proportional navigation — fallible) ──────────────

  _updateHomingGuidance(p, dt, _carBodies) {
    const cfg = p.config;

    if (!p.target || p.target.isEliminated || p.target.isInvincible) {
      p.lostLockTimer += dt;
      if (p.lostLockTimer >= cfg.reacquireDelay) {
        p.target = this._findHomingTarget(p);
        p.lostLockTimer = 0;
      }
    }
    if (!p.target) return;

    const tx = p.target.body.position.x - p.x;
    const tz = p.target.body.position.z - p.z;
    const tDist = Math.sqrt(tx * tx + tz * tz);
    if (tDist < 0.5) return;

    const mFwdX = -Math.sin(p.yaw);
    const mFwdZ = -Math.cos(p.yaw);
    const dot = (tx * mFwdX + tz * mFwdZ) / tDist;
    const angleToTarget = Math.acos(Math.max(-1, Math.min(1, dot)));

    if (angleToTarget > cfg.losAngle) {
      p.target = null;
      p.lostLockTimer = 0;
      return;
    }

    const cross = mFwdX * tz - mFwdZ * tx;
    const turnDir = cross > 0 ? -1 : 1;
    const turnStrength = Math.min(angleToTarget / (Math.PI * 0.25), 1);
    p.yaw += turnDir * cfg.turnRate * turnStrength * dt;

    p.vx = -Math.sin(p.yaw) * cfg.speed;
    p.vz = -Math.cos(p.yaw) * cfg.speed;
  }

  _findHomingTarget(projectile) {
    const carBodies = this.getCarBodies();
    const seekR2 = POWERUPS.HOMING_MISSILE.seekRadius ** 2;
    let bestDist2 = seekR2;
    let bestTarget = null;
    for (const car of carBodies) {
      if (car === projectile.owner || car.isEliminated || car.isInvincible) continue;
      const dx = car.body.position.x - projectile.x;
      const dz = car.body.position.z - projectile.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) { bestDist2 = d2; bestTarget = car; }
    }
    return bestTarget;
  }

  // ── Trail particle pool ───────────────────────────────────────────────

  _emitTrailParticle(p) {
    const slot = p.trailPool[p.trailPoolIdx];
    p.trailPoolIdx = (p.trailPoolIdx + 1) % p.trailPool.length;

    const behindX = Math.sin(p.yaw) * 0.5;
    const behindZ = Math.cos(p.yaw) * 0.5;
    slot.mesh.position.set(
      p.x + behindX + (Math.random() - 0.5) * 0.12,
      p.y + (Math.random() - 0.5) * 0.08,
      p.z + behindZ + (Math.random() - 0.5) * 0.12
    );
    slot.mesh.scale.setScalar(0.5);
    slot.mesh.visible = true;
    slot.life = 0.35;
    slot.active = true;
  }

  _tickTrailPool(p, dt) {
    for (const slot of p.trailPool) {
      if (!slot.active) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.mesh.visible = false;
        slot.active = false;
        continue;
      }
      const t = slot.life / 0.35;
      slot.mesh.scale.setScalar(0.5 + (1 - t) * 1.2);
      // opacity handled by shared material — we trade per-particle opacity for perf
    }
  }

  // ── Detonation VFX (batched into _vfxObjects, ticked in update) ───────

  _detonateProjectile(p) {
    p.alive = false;
    const isHoming = p.isHoming;
    const color = isHoming ? 0xff00ff : 0xff4400;

    // Flash sphere (MeshBasicMaterial — no PBR, bright enough for bloom to catch)
    const flashMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
    });
    const flash = new THREE.Mesh(_sharedGeo.explosionFlash, flashMat);
    flash.position.set(p.x, p.y, p.z);

    // Emissive glow sprite (replaces PointLight — zero shader cost, bloom provides glow)
    const glowMat = new THREE.SpriteMaterial({
      map: _glowTexture,
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(6);
    glow.position.set(p.x, p.y, p.z);

    // Debris group (single scene.add instead of 6 individual adds)
    const debrisMat = isHoming ? _sharedMat.debrisPink : _sharedMat.debrisOrange;
    const debrisGroup = new THREE.Group();
    debrisGroup.position.set(p.x, p.y, p.z);
    const debrisList = [];
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(_sharedGeo.debrisBox, debrisMat);
      debrisGroup.add(mesh);
      const angle = Math.random() * Math.PI * 2;
      debrisList.push({
        mesh,
        // Store offsets relative to group origin (starts at 0,0,0)
        vx: Math.cos(angle) * (3 + Math.random() * 4),
        vy: 2 + Math.random() * 3,
        vz: Math.sin(angle) * (3 + Math.random() * 4),
        life: 0.5 + Math.random() * 0.2,
      });
    }

    // Single scene.add for all explosion objects (3 adds instead of 8)
    this.scene.add(flash);
    this.scene.add(glow);
    this.scene.add(debrisGroup);

    this._playExplosionSFX();

    // Push into VFX tick list (animated in update, not separate rAF)
    this._vfxObjects.push({
      type: 'explosion',
      flash, flashMat,
      glow, glowMat,
      debrisGroup,
      debris: debrisList,
      age: 0,
      duration: 0.7,
    });
  }

  _removeProjectile(index) {
    const p = this._projectiles[index];
    this.scene.remove(p.group);
    this.scene.remove(p.glow);
    p.glowMat.dispose();
    // Dispose unique materials
    if (p.group.userData.bodyMat) p.group.userData.bodyMat.dispose();
    if (p.group.userData.exhaustMat) p.group.userData.exhaustMat.dispose();
    // Remove trail pool meshes from scene
    for (const slot of p.trailPool) {
      this.scene.remove(slot.mesh);
    }
    this._projectiles.splice(index, 1);
  }

  // ── Obstacle destruction ──────────────────────────────────────────────

  _destroyObstacle(obstacleIndex) {
    const ob = this.obstacleBodies[obstacleIndex];
    const px = ob.position.x, py = ob.position.y, pz = ob.position.z;
    const radius = ob._obstacleRadius || 1.5;
    const type = ob._obstacleType || 'boulder';

    this.world.removeBody(ob);
    this.obstacleBodies.splice(obstacleIndex, 1);

    if (this.obstacleGroups) {
      for (let i = this.obstacleGroups.length - 1; i >= 0; i--) {
        const og = this.obstacleGroups[i];
        const gp = og.group.position;
        const dx = gp.x - px, dz = gp.z - pz;
        if (dx * dx + dz * dz < (radius + 1) ** 2) {
          this._spawnShatterVFX(og.group.position, type);
          this.scene.remove(og.group);
          og.group.traverse((c) => {
            if (c.isMesh) {
              c.geometry?.dispose();
              if (c.material) {
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material.dispose();
              }
            }
          });
          this.obstacleGroups.splice(i, 1);
          break;
        }
      }
    }
    this._emit('obstacle-destroyed', { type, x: px, y: py, z: pz });
  }

  _spawnShatterVFX(pos, type) {
    // Fewer chunks (8 for pillar, 6 for boulder — down from 20/14)
    const count = type === 'pillar' ? 8 : 6;
    const geo = type === 'pillar' ? _sharedGeo.shatterChunkLarge : _sharedGeo.shatterChunkSmall;
    const chunks = [];

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, _sharedMat.shatterRock);
      mesh.position.copy(pos);
      mesh.position.y += Math.random() * (type === 'pillar' ? 3 : 1.2);
      this.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      chunks.push({
        mesh,
        vx: Math.cos(angle) * (3 + Math.random() * 5),
        vy: 2 + Math.random() * 4,
        vz: Math.sin(angle) * (3 + Math.random() * 5),
        spin: (Math.random() - 0.5) * 8,
        life: 0.8 + Math.random() * 0.3,
      });
    }

    // Dust cloud (MeshBasicMaterial)
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0x8B7355, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    });
    const dust = new THREE.Mesh(_sharedGeo.dustCloud, dustMat);
    dust.position.copy(pos);
    dust.position.y += 1;
    this.scene.add(dust);

    this._playExplosionSFX();

    // Push into VFX tick list
    this._vfxObjects.push({
      type: 'shatter',
      chunks,
      dust, dustMat,
      age: 0,
      duration: 1.2,
    });
  }

  // ── Batched VFX update (all transient effects in one loop) ────────────

  _updateVFX(dt) {
    for (let i = this._vfxObjects.length - 1; i >= 0; i--) {
      const vfx = this._vfxObjects[i];
      vfx.age += dt;

      if (vfx.age >= vfx.duration) {
        this._cleanupVFX(vfx);
        this._vfxObjects.splice(i, 1);
        continue;
      }

      if (vfx.type === 'explosion') {
        const t = vfx.age / 0.4;
        vfx.flash.scale.setScalar(1 + t * 2);
        vfx.flashMat.opacity = Math.max(0, 0.85 * (1 - t));
        // Glow sprite: bright initially, expands and fades fast
        const glowFade = Math.max(0, 1 - vfx.age / 0.3);
        vfx.glow.scale.setScalar(4 + vfx.age * 8);
        vfx.glowMat.opacity = 0.8 * glowFade;

        for (const d of vfx.debris) {
          d.life -= dt;
          if (d.life <= 0 && d.mesh.visible) {
            d.mesh.visible = false;
            continue;
          }
          d.mesh.position.x += d.vx * dt;
          d.mesh.position.y += d.vy * dt;
          d.mesh.position.z += d.vz * dt;
          d.vy -= 10 * dt;
          d.mesh.rotation.x += 8 * dt;
          d.mesh.rotation.z += 6 * dt;
        }
      }

      if (vfx.type === 'shatter') {
        for (const c of vfx.chunks) {
          c.life -= dt;
          if (c.life <= 0 && c.mesh.parent) {
            this.scene.remove(c.mesh);
            continue;
          }
          c.mesh.position.x += c.vx * dt;
          c.mesh.position.y += c.vy * dt;
          c.mesh.position.z += c.vz * dt;
          c.vy -= 12 * dt;
          c.mesh.rotation.x += c.spin * dt;
          c.mesh.rotation.z += c.spin * 0.7 * dt;
        }

        if (vfx.dust && vfx.dust.parent) {
          vfx.dust.scale.setScalar(1 + vfx.age * 3);
          vfx.dustMat.opacity = 0.4 * Math.max(0, 1 - vfx.age / 1.0);
        }
      }
    }
  }

  _cleanupVFX(vfx) {
    if (vfx.type === 'explosion') {
      this.scene.remove(vfx.flash);
      this.scene.remove(vfx.glow);
      this.scene.remove(vfx.debrisGroup);
      vfx.flashMat.dispose();
      vfx.glowMat.dispose();
    }
    if (vfx.type === 'shatter') {
      for (const c of vfx.chunks) {
        if (c.mesh.parent) this.scene.remove(c.mesh);
      }
      if (vfx.dust && vfx.dust.parent) this.scene.remove(vfx.dust);
      vfx.dustMat.dispose();
    }
  }

  // =====================================================================
  //  SHIELD SYSTEM
  // =====================================================================

  _applyShield(car) {
    const config = POWERUPS.SHIELD;
    const gen = car._generation;

    car.hasShield = true;
    car._shieldDamageReduction = config.damageReduction;

    const shieldRadius = 2.2;

    // Inner sphere (MeshBasicMaterial — no PBR needed)
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const innerMesh = new THREE.Mesh(_sharedGeo.shieldSphere, innerMat);

    // Wireframe overlay
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x00ffaa, wireframe: true, transparent: true, opacity: 0.4,
      depthWrite: false,
    });
    const wireMesh = new THREE.Mesh(_sharedGeo.shieldWire, wireMat);

    // Orbital rings
    const rings = [];
    for (let i = 0; i < 2; i++) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x88ffcc, transparent: true, opacity: 0.6, depthWrite: false,
      });
      const ring = new THREE.Mesh(_sharedGeo.shieldRing, ringMat);
      rings.push({ mesh: ring, mat: ringMat });
    }

    // Shield light
    const shieldLight = new THREE.PointLight(0x00ff88, 1.5, 8);

    const shieldGroup = new THREE.Group();
    shieldGroup.add(innerMesh);
    shieldGroup.add(wireMesh);
    for (const r of rings) shieldGroup.add(r.mesh);
    shieldGroup.add(shieldLight);
    shieldGroup.position.copy(car.body.position);
    this.scene.add(shieldGroup);

    this._playShieldSFX();

    this._activeShields.push({
      car, group: shieldGroup,
      innerMesh, innerMat, wireMesh, wireMat,
      rings, light: shieldLight,
      timer: config.duration, gen,
    });
  }

  _updateShields(dt) {
    const now = performance.now() * 0.001;
    for (let i = this._activeShields.length - 1; i >= 0; i--) {
      const s = this._activeShields[i];

      if (s.car._generation !== s.gen) {
        this._removeShield(i);
        continue;
      }

      s.timer -= dt;
      if (s.timer <= 0) {
        s.car.hasShield = false;
        s.car._shieldDamageReduction = 0;
        this._removeShield(i);
        continue;
      }

      // Follow car
      s.group.position.copy(s.car.body.position);

      // Animate rings
      if (s.rings[0]) {
        s.rings[0].mesh.rotation.x = now * 1.5;
        s.rings[0].mesh.rotation.y = now * 0.8;
      }
      if (s.rings[1]) {
        s.rings[1].mesh.rotation.x = now * 0.6 + Math.PI * 0.5;
        s.rings[1].mesh.rotation.z = now * 1.2;
      }

      // Pulse wireframe
      s.wireMat.opacity = 0.25 + Math.sin(now * 4) * 0.15;

      // Flicker light
      s.light.intensity = 1.0 + Math.sin(now * 6) * 0.5;

      // Fade out last 1s
      if (s.timer < 1.0) {
        const fade = s.timer;
        s.innerMat.opacity = 0.12 * fade;
        s.wireMat.opacity = (0.25 + Math.sin(now * 4) * 0.15) * fade;
        for (const r of s.rings) r.mat.opacity = 0.6 * fade;
        s.light.intensity *= fade;
      }

      // Slow hex rotation
      s.wireMesh.rotation.y += dt * 0.3;
      s.wireMesh.rotation.x += dt * 0.15;
    }
  }

  _removeShield(index) {
    const s = this._activeShields[index];
    this.scene.remove(s.group);
    s.light.dispose();
    s.innerMat.dispose();
    s.wireMat.dispose();
    for (const r of s.rings) r.mat.dispose();
    this._activeShields.splice(index, 1);
  }

  // =====================================================================
  //  AUDIO (Web Audio API — procedural)
  // =====================================================================

  _getAudioCtx() {
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._audioCtx;
  }

  _playMissileLaunchSFX(isHoming) {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(isHoming ? 300 : 200, now);
      osc.frequency.exponentialRampToValueAtTime(isHoming ? 800 : 600, now + 0.15);
      osc.frequency.exponentialRampToValueAtTime(isHoming ? 200 : 100, now + 0.4);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, now);
      filter.frequency.exponentialRampToValueAtTime(500, now + 0.4);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);

      // Noise burst (reuse cached buffer)
      const noiseLen = 0.3;
      if (!this._launchNoiseBuffer) {
        const buf = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
        this._launchNoiseBuffer = buf;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = this._launchNoiseBuffer;
      const nGain = ctx.createGain();
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'bandpass';
      nFilter.frequency.value = isHoming ? 1500 : 1000;
      nFilter.Q.value = 0.5;
      nGain.gain.setValueAtTime(0.1, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
      noise.connect(nFilter).connect(nGain).connect(ctx.destination);
      noise.start(now);
    } catch (_) { /* audio not available */ }
  }

  _playExplosionSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, now);
      osc.frequency.exponentialRampToValueAtTime(20, now + 0.4);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);

      // Reuse cached noise buffer (avoids 19K-sample allocation per explosion)
      const noiseLen = 0.4;
      if (!this._explosionNoiseBuffer) {
        const buf = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
        this._explosionNoiseBuffer = buf;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = this._explosionNoiseBuffer;
      const nGain = ctx.createGain();
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(3000, now);
      nFilter.frequency.exponentialRampToValueAtTime(200, now + 0.4);
      nGain.gain.setValueAtTime(0.2, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
      noise.connect(nFilter).connect(nGain).connect(ctx.destination);
      noise.start(now);
    } catch (_) { /* audio not available */ }
  }

  _playShieldSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(400, now);
      osc1.frequency.exponentialRampToValueAtTime(1200, now + 0.3);
      osc1.frequency.exponentialRampToValueAtTime(800, now + 0.6);

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(600, now);
      osc2.frequency.exponentialRampToValueAtTime(1800, now + 0.3);
      osc2.frequency.exponentialRampToValueAtTime(1200, now + 0.6);

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

      osc1.connect(gain).connect(ctx.destination);
      osc2.connect(gain);
      osc1.start(now);
      osc1.stop(now + 0.7);
      osc2.start(now);
      osc2.stop(now + 0.7);
    } catch (_) { /* audio not available */ }
  }

  // ── Reset / Dispose ───────────────────────────────────────────────────

  reset() {
    this._held.clear();

    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      this._removeProjectile(i);
    }
    for (let i = this._activeShields.length - 1; i >= 0; i--) {
      const s = this._activeShields[i];
      s.car.hasShield = false;
      s.car._shieldDamageReduction = 0;
      this._removeShield(i);
    }
    // Clean up any running VFX
    for (const vfx of this._vfxObjects) {
      this._cleanupVFX(vfx);
    }
    this._vfxObjects.length = 0;

    for (const pedestal of this._pedestals) {
      if (pedestal.pickupMesh) {
        this.scene.remove(pedestal.pickupMesh);
        pedestal.pickupMesh = null;
      }
      pedestal.active = false;
      pedestal.respawnAt = 0;
      this._spawnPickup(pedestal);
    }
  }

  dispose() {
    for (const pedestal of this._pedestals) {
      this.scene.remove(pedestal.pedestalMesh);
      this.scene.remove(pedestal.ringMesh);
      this.scene.remove(pedestal.glowLight);
      if (pedestal.pickupMesh) this.scene.remove(pedestal.pickupMesh);
    }
    this._pedestals.length = 0;
    this._held.clear();

    for (let i = this._projectiles.length - 1; i >= 0; i--) this._removeProjectile(i);
    for (let i = this._activeShields.length - 1; i >= 0; i--) this._removeShield(i);
    for (const vfx of this._vfxObjects) this._cleanupVFX(vfx);
    this._vfxObjects.length = 0;
  }
}
