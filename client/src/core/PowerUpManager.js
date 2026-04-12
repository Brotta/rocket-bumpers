import * as THREE from 'three';
import { ARENA, POWERUPS, POWERUP_WEIGHTS, COLLISION_GROUPS } from './Config.js';
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

// Pre-build weighted spawn table from POWERUP_WEIGHTS
const _weightedSpawnTable = (() => {
  const entries = [];
  let total = 0;
  for (const type of POWERUP_TYPES) {
    const w = POWERUP_WEIGHTS[type] || 1;
    total += w;
    entries.push({ type, cumulative: total });
  }
  return { entries, total };
})();

function _pickWeightedType() {
  const r = Math.random() * _weightedSpawnTable.total;
  for (const e of _weightedSpawnTable.entries) {
    if (r < e.cumulative) return e.type;
  }
  return _weightedSpawnTable.entries[_weightedSpawnTable.entries.length - 1].type;
}

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
  // Repair kit VFX
  repairParticle: new THREE.SphereGeometry(0.12, 4, 4),
  repairCross: new THREE.BoxGeometry(0.3, 0.06, 0.06),
  // Turret parts
  turretBase: new THREE.CylinderGeometry(0.35, 0.4, 0.15, 12),
  turretBaseRing: new THREE.TorusGeometry(0.38, 0.03, 6, 16),
  turretBody: new THREE.SphereGeometry(0.28, 8, 6),
  turretBarrel: new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6),
  turretMuzzle: new THREE.SphereGeometry(0.08, 4, 4),
  turretBullet: new THREE.SphereGeometry(0.1, 4, 4),
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
  constructor(scene, world, getCarBodies, getLocalPlayer) {
    this.scene = scene;
    this.world = world;
    this.getCarBodies = getCarBodies;
    this.getLocalPlayer = getLocalPlayer || (() => null);

    this._listeners = {};
    this._held = new Map();

    // Active projectiles
    this._projectiles = [];

    // Active shields
    this._activeShields = [];

    // Active holo-evade decoys
    this._holoDecoys = [];

    // Active auto-turrets
    this._activeTurrets = [];
    // Active turret bullets
    this._turretBullets = [];

    // Active repair-kit VFX
    this._repairVFX = [];

    // Active glitch effects (on cars hit by Glitch Bomb)
    this._activeGlitchEffects = [];
    // DOM overlay for local player glitch screen effect
    this._glitchOverlay = null;
    this._glitchNoiseCanvas = null;
    this._glitchNoiseCtx = null;

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

    // Multiplayer: set by Game.connectMultiplayer
    this._networkManager = null;

    // Optimistic pickup tracking (for rollback on denial)
    this._optimisticPickups = new Map(); // pedestalId → car

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

    // ── Pedestal logic ──
    for (const pedestal of this._pedestals) {
      // In multiplayer, server controls respawn timers via POWERUP_SPAWNED events
      if (!this._networkManager?.isMultiplayer) {
        if (!pedestal.active && pedestal.respawnAt > 0 && now >= pedestal.respawnAt) {
          this._spawnPickup(pedestal);
        }
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
            if (this._networkManager?.isMultiplayer) {
              // Multiplayer: send pickup request, do optimistic local pickup
              this._networkManager.sendPickupRequest(`pu_${pedestal.index}`);
              this._optimisticPickups.set(`pu_${pedestal.index}`, car);
              this._pickup(pedestal, car);
            } else {
              this._pickup(pedestal, car);
            }
            break;
          }
        }
      }
    }

    // ── Update active projectiles ──
    this._updateProjectiles(dt, carBodies);

    // ── Update active shields ──
    this._updateShields(dt);

    // ── Update holo-evade decoys ──
    this._updateHoloDecoys(dt);

    // ── Update auto-turrets + bullets ──
    this._updateTurrets(dt, carBodies);
    this._updateTurretBullets(dt, carBodies);

    // ── Update repair-kit VFX ──
    this._updateRepairVFX(dt);

    // ── Update glitch effects ──
    this._updateGlitchEffects(dt);

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

    // Notify server of power-up usage
    if (this._networkManager?.isMultiplayer) {
      const pos = car.body.position;
      this._networkManager.sendPowerUpUsed(type, [pos.x, pos.y, pos.z]);
    }

    return true;
  }

  drop(car) { this._held.set(car, null); }

  // ── Network event handlers (called by Game.js) ────────────────────────

  /** Server confirmed a power-up spawn on a pedestal. */
  onNetworkSpawn(id, powerupType, position) {
    const idx = parseInt(id.replace('pu_', ''), 10);
    const pedestal = this._pedestals[idx];
    if (!pedestal) return;
    if (pedestal.active) return; // already active

    // Override the type with server's choice and spawn
    this._spawnPickupWithType(pedestal, powerupType);
  }

  /** Server confirmed a power-up was taken by a player. */
  onNetworkTaken(id, playerId, powerupType) {
    const idx = parseInt(id.replace('pu_', ''), 10);
    const pedestal = this._pedestals[idx];
    if (!pedestal) return;

    // If this wasn't our optimistic pickup, clear the pedestal
    const optimisticCar = this._optimisticPickups.get(id);
    this._optimisticPickups.delete(id);

    if (!optimisticCar) {
      // Someone else picked it up — remove visual
      if (pedestal.active && pedestal.pickupMesh) {
        this.scene.remove(pedestal.pickupMesh);
        pedestal.pickupMesh = null;
      }
      pedestal.active = false;
      pedestal.ringMat.emissive.setHex(0x222222);
      pedestal.glowLight.intensity = 0.1;
      pedestal.respawnAt = 0; // server controls respawn
    }
    // If it was our optimistic pickup, we already handled the visual
  }

  /** Server denied our pickup request — rollback optimistic pickup. */
  onNetworkPickupDenied(powerupId) {
    const car = this._optimisticPickups.get(powerupId);
    this._optimisticPickups.delete(powerupId);
    if (!car) return;

    // Rollback: remove held power-up from car
    const heldType = this._held.get(car);
    this._held.set(car, null);
    this._emit('pickup', { car, type: null }); // clear HUD

    // Restore pedestal visuals — re-spawn the pickup mesh
    const idx = parseInt(powerupId.replace('pu_', ''), 10);
    const pedestal = this._pedestals[idx];
    if (pedestal && !pedestal.active && heldType) {
      this._spawnPickupWithType(pedestal, heldType);
    }
  }

  /** Remote player used a power-up — trigger visual effects. */
  onNetworkUsed(playerId, powerupType, pos) {
    // For now, remote power-up usage creates visual effects at the given position.
    // Full projectile sync would require tracking remote projectiles.
    // Minimal implementation: just log for now, expand later.
  }

  /** Spawn a pickup with a specific type (for server-controlled spawns). */
  _spawnPickupWithType(pedestal, type) {
    // Same as _spawnPickup but with a predetermined type
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
    const type = _pickWeightedType();
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
      case 'MISSILE':        this._fireMissile(car, false);  break;
      case 'HOMING_MISSILE': this._fireMissile(car, true);   break;
      case 'SHIELD':         this._applyShield(car);          break;
      case 'REPAIR_KIT':     this._applyRepairKit(car);       break;
      case 'HOLO_EVADE':     this._activateHoloEvade(car);    break;
      case 'AUTO_TURRET':    this._deployTurret(car);          break;
      case 'GLITCH_BOMB':    this._detonateGlitchBomb(car);    break;
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
      // HoloEvade confusion state (homing only)
      _holoConfuseRolled: false,
      _holoDecoyTarget: null,
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

    // ── HoloEvade confusion check ──
    // If our target has holoEvade active and we haven't rolled yet, roll once
    if (p.target && p.target.holoEvadeActive && !p._holoConfuseRolled) {
      p._holoConfuseRolled = true;
      const decoys = this.getHoloDecoys(p.target);
      if (decoys && Math.random() < POWERUPS.HOLO_EVADE.missileConfuseChance) {
        // Missile gets confused — pick a random decoy as virtual target
        const chosen = decoys[Math.floor(Math.random() * decoys.length)];
        p._holoDecoyTarget = chosen; // virtual target with {x, z, y}
        p.target = null; // drop real lock
      }
    }

    // ── Tracking a holo decoy? ──
    if (p._holoDecoyTarget) {
      const d = p._holoDecoyTarget;
      // Decoy disappeared (cleanup) — lose lock entirely
      if (!d.group || !d.group.parent) {
        p._holoDecoyTarget = null;
        p.target = null;
        p.lostLockTimer = 0;
        return;
      }
      // Steer toward decoy position
      this._steerToward(p, d.x, d.z, dt);
      return;
    }

    if (!p.target || p.target.isEliminated || p.target.isInvincible) {
      p.lostLockTimer += dt;
      if (p.lostLockTimer >= cfg.reacquireDelay) {
        p.target = this._findHomingTarget(p);
        p.lostLockTimer = 0;
        p._holoConfuseRolled = false; // allow re-roll on new target
      }
    }
    if (!p.target) return;

    this._steerToward(p, p.target.body.position.x, p.target.body.position.z, dt);
  }

  /** Shared proportional-navigation steering (used for both real targets and decoys). */
  _steerToward(p, targetX, targetZ, dt) {
    const cfg = p.config;
    const tx = targetX - p.x;
    const tz = targetZ - p.z;
    const tDist = Math.sqrt(tx * tx + tz * tz);
    if (tDist < 0.5) return;

    const mFwdX = -Math.sin(p.yaw);
    const mFwdZ = -Math.cos(p.yaw);
    const dot = (tx * mFwdX + tz * mFwdZ) / tDist;
    const angleToTarget = Math.acos(Math.max(-1, Math.min(1, dot)));

    if (angleToTarget > cfg.losAngle) {
      p.target = null;
      p._holoDecoyTarget = null;
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

      if (vfx.type === 'turret_flash') {
        const t = vfx.age / vfx.duration;
        vfx.flash.scale.setScalar(1.2 + t * 1.5);
        vfx.flashMat.opacity = 0.9 * (1 - t);
      }

      if (vfx.type === 'glitch_pulse') {
        const t = vfx.age / vfx.duration;
        const blastR = POWERUPS.GLITCH_BOMB.blastRadius;

        // Expanding rings
        const ringScale = 1 + t * blastR;
        vfx.ring.scale.setScalar(ringScale);
        vfx.ringMat.opacity = Math.max(0, 0.9 * (1 - t));
        vfx.ring2.scale.setScalar(ringScale * 0.7);
        vfx.ring2Mat.opacity = Math.max(0, 0.7 * (1 - t * 1.3));

        // Vertical oscillation on rings
        vfx.ring.position.y = vfx.cy + Math.sin(vfx.age * 20) * 0.2;
        vfx.ring2.position.y = vfx.cy + Math.sin(vfx.age * 25 + 1) * 0.15;

        // Central flash
        vfx.flash.scale.setScalar(3 + t * 6);
        vfx.flashMat.opacity = Math.max(0, 1 - t * 2);

        // Debris particles
        for (const d of vfx.debrisItems) {
          d.life -= dt;
          if (d.life <= 0 && d.mesh.visible) {
            d.mesh.visible = false;
            continue;
          }
          d.mesh.position.x += d.vx * dt;
          d.mesh.position.y += d.vy * dt;
          d.mesh.position.z += d.vz * dt;
          d.vy -= 8 * dt;
          d.mesh.rotation.x += 12 * dt;
          d.mesh.rotation.z += 8 * dt;
          d.mat.opacity = Math.max(0, d.life / 0.8);
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
    if (vfx.type === 'turret_flash') {
      this.scene.remove(vfx.flash);
      vfx.flashMat.dispose();
    }
    if (vfx.type === 'glitch_pulse') {
      this.scene.remove(vfx.ring);
      this.scene.remove(vfx.ring2);
      this.scene.remove(vfx.flash);
      this.scene.remove(vfx.debrisGroup);
      vfx.ringMat.dispose();
      vfx.ring2Mat.dispose();
      vfx.flashMat.dispose();
      for (const d of vfx.debrisItems) d.mat.dispose();
    }
  }

  // =====================================================================
  //  REPAIR KIT
  // =====================================================================

  _applyRepairKit(car) {
    const config = POWERUPS.REPAIR_KIT;
    const healed = Math.min(config.heal, car.maxHp - car.hp);
    car.hp = Math.min(car.hp + config.heal, car.maxHp);

    // Spawn rising green particles + cross symbols around car
    const px = car.body.position.x;
    const py = car.body.position.y;
    const pz = car.body.position.z;

    const particles = [];
    const PARTICLE_COUNT = 12;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const isCross = i < 4; // first 4 are cross symbols
      const geo = isCross ? _sharedGeo.repairCross : _sharedGeo.repairParticle;
      const mat = new THREE.MeshBasicMaterial({
        color: 0x44ff44, transparent: true, opacity: 0.9, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
      const radius = 0.8 + Math.random() * 0.6;
      mesh.position.set(
        px + Math.cos(angle) * radius,
        py + Math.random() * 0.4,
        pz + Math.sin(angle) * radius,
      );
      if (isCross) {
        // Add a second cross bar to make a + shape
        const bar2 = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, 0.06, 0.3),
          mat,
        );
        mesh.add(bar2);
        mesh.scale.setScalar(1.5);
      }
      this.scene.add(mesh);
      particles.push({
        mesh, mat,
        vy: 2.0 + Math.random() * 1.5, // rise speed (u/s)
        vx: (Math.random() - 0.5) * 0.5,
        vz: (Math.random() - 0.5) * 0.5,
        life: 0.6 + Math.random() * 0.3,
        maxLife: 0.6 + Math.random() * 0.3,
      });
    }

    // Green flash glow at car center
    const glowMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0x44ff44,
      transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(5);
    glow.position.set(px, py + 0.5, pz);
    this.scene.add(glow);

    this._repairVFX.push({
      car, particles, glow, glowMat,
      age: 0, duration: 1.0,
    });

    this._playRepairSFX();
    this._emit('repair', { car, healed });
  }

  _updateRepairVFX(dt) {
    for (let i = this._repairVFX.length - 1; i >= 0; i--) {
      const r = this._repairVFX[i];
      r.age += dt;

      if (r.age >= r.duration) {
        // Cleanup
        for (const p of r.particles) {
          this.scene.remove(p.mesh);
          p.mat.dispose();
        }
        this.scene.remove(r.glow);
        r.glowMat.dispose();
        this._repairVFX.splice(i, 1);
        continue;
      }

      // Glow fade
      const glowFade = Math.max(0, 1 - r.age / 0.5);
      r.glow.scale.setScalar(5 + r.age * 4);
      r.glowMat.opacity = 0.7 * glowFade;

      // Particles rise and fade
      for (const p of r.particles) {
        p.life -= dt;
        if (p.life <= 0) {
          p.mesh.visible = false;
          continue;
        }
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        const t = p.life / p.maxLife;
        p.mat.opacity = 0.9 * t;
        p.mesh.scale.setScalar(1 + (1 - t) * 0.5);
      }
    }
  }

  _playRepairSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      // Ascending positive chime
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523, now);       // C5
      osc1.frequency.setValueAtTime(659, now + 0.1);  // E5
      osc1.frequency.setValueAtTime(784, now + 0.2);  // G5

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(784, now);
      osc2.frequency.setValueAtTime(988, now + 0.1);
      osc2.frequency.setValueAtTime(1047, now + 0.2); // C6

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc1.connect(gain).connect(ctx.destination);
      osc2.connect(gain);
      osc1.start(now); osc1.stop(now + 0.5);
      osc2.start(now); osc2.stop(now + 0.5);
    } catch (_) { /* audio not available */ }
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
  //  HOLO EVADE (Decoy System)
  // =====================================================================

  _activateHoloEvade(car) {
    const config = POWERUPS.HOLO_EVADE;
    const gen = car._generation;

    car.holoEvadeActive = true;
    car.setCarOpacity(config.carOpacity);

    const yaw = car._yaw;
    const px = car.body.position.x;
    const py = car.body.position.y;
    const pz = car.body.position.z;

    // Get car speed for decoy movement
    const carSpeedX = car.body.velocity.x;
    const carSpeedZ = car.body.velocity.z;
    const carSpeed = Math.sqrt(carSpeedX * carSpeedX + carSpeedZ * carSpeedZ);
    const decoySpeed = Math.max(carSpeed * config.decoySpeedFactor, 12); // min 12 u/s

    const decoys = [];
    for (let i = 0; i < config.decoyCount; i++) {
      // Diverging angles: one left, one right of car direction
      const sign = i === 0 ? -1 : 1;
      const spreadAngle = (0.4 + Math.random() * 0.4) * config.decoySpreadAngle * sign;
      const decoyYaw = yaw + spreadAngle;
      const vx = -Math.sin(decoyYaw) * decoySpeed;
      const vz = -Math.cos(decoyYaw) * decoySpeed;

      // Clone car mesh (simplified — shallow traverse for performance)
      const decoyGroup = car.mesh.clone(true);
      decoyGroup.position.set(px, py - 0.55, pz);
      decoyGroup.quaternion.copy(car.mesh.quaternion);

      // Make decoy semi-transparent with cyan tint
      decoyGroup.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          child.material = mats.map((m) => {
            const clone = m.clone();
            clone.transparent = true;
            clone.opacity = config.carOpacity;
            if (clone.emissive) clone.emissive.setHex(0x00ccff);
            if ('emissiveIntensity' in clone) clone.emissiveIntensity = 0.3;
            clone.depthWrite = false;
            clone.needsUpdate = true;
            return clone;
          });
          if (!Array.isArray(child.material) || child.material.length === 1) {
            child.material = child.material[0] || child.material;
          }
        }
      });

      this.scene.add(decoyGroup);

      // Cyan glow sprite on decoy
      const glowMat = new THREE.SpriteMaterial({
        map: _glowTexture, color: 0x00ccff,
        transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(3);
      glow.position.set(px, py - 0.55, pz);
      this.scene.add(glow);

      decoys.push({
        group: decoyGroup, glow, glowMat,
        x: px, z: pz,
        vx, vz,
        yaw: decoyYaw,
      });
    }

    // Activation flash
    const flashMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0x00ccff,
      transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.scale.setScalar(6);
    flash.position.set(px, py + 0.5, pz);
    this.scene.add(flash);

    this._holoDecoys.push({
      car, gen, config, decoys,
      flash, flashMat,
      age: 0,
      phase: 'active', // 'active' → 'fadeout' → removed
    });

    this._playHoloEvadeSFX();
  }

  _updateHoloDecoys(dt) {
    for (let i = this._holoDecoys.length - 1; i >= 0; i--) {
      const h = this._holoDecoys[i];

      // Car died/respawned — clean up
      if (h.car._generation !== h.gen) {
        this._cleanupHoloDecoy(h);
        this._holoDecoys.splice(i, 1);
        continue;
      }

      h.age += dt;
      const cfg = h.config;
      const totalDuration = cfg.duration + cfg.fadeOutTime;

      if (h.age >= totalDuration) {
        h.car.holoEvadeActive = false;
        h.car._restoreCarOpacity();
        this._cleanupHoloDecoy(h);
        this._holoDecoys.splice(i, 1);
        continue;
      }

      // Transition to fadeout phase
      if (h.phase === 'active' && h.age >= cfg.duration) {
        h.phase = 'fadeout';
      }

      // Activation flash fade (first 0.3s)
      if (h.flash && h.flash.parent) {
        const flashFade = Math.max(0, 1 - h.age / 0.3);
        h.flashMat.opacity = 0.8 * flashFade;
        h.flash.scale.setScalar(6 + h.age * 10);
        if (flashFade <= 0) {
          this.scene.remove(h.flash);
          h.flashMat.dispose();
          h.flash = null;
        }
      }

      // Move decoys and update visuals
      for (const d of h.decoys) {
        // Move in straight line (dt-based)
        d.x += d.vx * dt;
        d.z += d.vz * dt;

        const decoyY = h.car.body.position.y - 0.55;

        d.group.position.x = d.x;
        d.group.position.z = d.z;
        d.group.position.y = decoyY;

        d.glow.position.set(d.x, decoyY, d.z);

        // Glitch flicker effect (random opacity variation)
        const flicker = 0.8 + Math.sin(h.age * 30 + d.yaw * 10) * 0.2;

        if (h.phase === 'fadeout') {
          const fadeT = (h.age - cfg.duration) / cfg.fadeOutTime;
          const fadeOpacity = cfg.carOpacity * (1 - fadeT) * flicker;
          d.group.traverse((child) => {
            if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              for (const m of mats) { m.opacity = fadeOpacity; }
            }
          });
          d.glowMat.opacity = 0.4 * (1 - fadeT);
        } else {
          // Active phase — glitch flicker
          d.group.traverse((child) => {
            if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              for (const m of mats) { m.opacity = cfg.carOpacity * flicker; }
            }
          });
          d.glowMat.opacity = 0.4 * flicker;
        }
      }

      // Restore real car opacity at end of active phase
      if (h.phase === 'fadeout') {
        const fadeT = (h.age - cfg.duration) / cfg.fadeOutTime;
        const restoreOpacity = cfg.carOpacity + (1 - cfg.carOpacity) * fadeT;
        h.car.setCarOpacity(restoreOpacity);
      }
    }
  }

  /** Check if a given car has active holo decoys (used by homing guidance). */
  getHoloDecoys(car) {
    for (const h of this._holoDecoys) {
      if (h.car === car && h.phase === 'active') return h.decoys;
    }
    return null;
  }

  _cleanupHoloDecoy(h) {
    for (const d of h.decoys) {
      // Dispose cloned materials
      d.group.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) m.dispose();
        }
      });
      this.scene.remove(d.group);
      this.scene.remove(d.glow);
      d.glowMat.dispose();
    }
    if (h.flash && h.flash.parent) {
      this.scene.remove(h.flash);
      h.flashMat.dispose();
    }
  }

  _playHoloEvadeSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      // Digital glitch sound — rapid frequency sweep + noise burst
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.08);
      osc.frequency.exponentialRampToValueAtTime(2400, now + 0.15);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.25);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1500, now);
      filter.Q.value = 2;

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);

      // Short noise burst for "teleport" feel
      const noiseLen = 0.15;
      const buf = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < data.length; j++) data[j] = (Math.random() * 2 - 1) * 0.3;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.08, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
      noise.connect(nGain).connect(ctx.destination);
      noise.start(now);
    } catch (_) { /* audio not available */ }
  }

  // =====================================================================
  //  AUTO TURRET
  // =====================================================================

  _deployTurret(car) {
    const config = POWERUPS.AUTO_TURRET;
    const gen = car._generation;

    // Mount Y: use per-car roofY computed by CarFactory, fallback to 1.2
    const roofY = car.mesh.userData.roofY ?? 1.2;

    // Build turret mesh group (local space — attached to car mesh)
    const turretGroup = new THREE.Group();
    turretGroup.position.set(0, roofY, 0);

    // Base disc (flat cylinder)
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x555555, metalness: 0.7, roughness: 0.3,
    });
    const base = new THREE.Mesh(_sharedGeo.turretBase, baseMat);
    turretGroup.add(base);

    // Base ring (orange emissive accent)
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xffaa00, emissive: 0xffaa00, emissiveIntensity: 1.5,
      metalness: 0.5, roughness: 0.3,
    });
    const ring = new THREE.Mesh(_sharedGeo.turretBaseRing, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    turretGroup.add(ring);

    // Rotating head (body + barrel) — this sub-group rotates to aim
    const head = new THREE.Group();
    head.position.y = 0.15;

    // Body (squashed sphere)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x777777, metalness: 0.6, roughness: 0.3,
    });
    const body = new THREE.Mesh(_sharedGeo.turretBody, bodyMat);
    body.scale.set(1, 0.8, 1);
    head.add(body);

    // Amber sight on top
    const sightMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00, emissive: 0xffaa00, emissiveIntensity: 2.0,
    });
    const sight = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.1, 0.15),
      sightMat,
    );
    sight.position.set(0, 0.18, -0.05);
    head.add(sight);

    // Barrel (points toward -Z in local space, matching car forward)
    const barrelMat = new THREE.MeshStandardMaterial({
      color: 0x444444, metalness: 0.8, roughness: 0.2,
    });
    const barrel = new THREE.Mesh(_sharedGeo.turretBarrel, barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05, -0.45);
    head.add(barrel);

    // Muzzle tip
    const muzzleMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
    });
    const muzzle = new THREE.Mesh(_sharedGeo.turretMuzzle, muzzleMat);
    muzzle.position.set(0, 0.05, -0.72);
    head.add(muzzle);

    turretGroup.add(head);

    // Add turret to car mesh (follows car position/rotation automatically)
    car.mesh.add(turretGroup);

    // Deploy glow
    const glowMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0xffaa00,
      transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(2.5);
    glow.position.set(0, roofY + 0.2, 0);
    car.mesh.add(glow);

    this._activeTurrets.push({
      car, gen, config,
      group: turretGroup, head, glow, glowMat,
      ringMat, sightMat, baseMat, bodyMat, barrelMat, muzzleMat,
      headYaw: 0,          // local yaw of the head (relative to car)
      fireTimer: 0.3,      // first shot after a small delay
      age: 0,
      target: null,
    });

    this._playTurretDeploySFX();
  }

  _updateTurrets(dt, carBodies) {
    for (let i = this._activeTurrets.length - 1; i >= 0; i--) {
      const t = this._activeTurrets[i];

      // Car died/respawned or fell — remove turret
      if (t.car._generation !== t.gen || t.car._isFalling) {
        this._removeTurret(i);
        continue;
      }

      t.age += dt;
      const cfg = t.config;

      // Duration expired
      if (t.age >= cfg.duration) {
        this._removeTurret(i);
        continue;
      }

      // ── Target acquisition ──
      t.target = this._findTurretTarget(t, carBodies);

      // ── Head rotation toward target ──
      if (t.target) {
        // Compute angle to target in car's local space
        const carWorldPos = t.car.body.position;
        const dx = t.target.body.position.x - carWorldPos.x;
        const dz = t.target.body.position.z - carWorldPos.z;
        const worldAngle = Math.atan2(-dx, -dz); // angle in world space
        const localAngle = worldAngle - t.car._yaw;  // relative to car facing

        // Smooth rotation toward target (dt-based)
        let diff = localAngle - t.headYaw;
        // Normalize to [-PI, PI]
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = cfg.turnRate * dt;
        if (Math.abs(diff) < maxTurn) {
          t.headYaw = localAngle;
        } else {
          t.headYaw += Math.sign(diff) * maxTurn;
        }
      }
      // Normalize headYaw
      while (t.headYaw > Math.PI) t.headYaw -= Math.PI * 2;
      while (t.headYaw < -Math.PI) t.headYaw += Math.PI * 2;

      t.head.rotation.y = t.headYaw;

      // ── Firing ──
      t.fireTimer -= dt;
      if (t.fireTimer <= 0 && t.target) {
        t.fireTimer = cfg.fireRate;
        this._fireTurretBullet(t);
      }

      // ── Visual pulse ──
      const pulse = 0.5 + Math.sin(t.age * 6) * 0.3;
      t.ringMat.emissiveIntensity = 1.0 + pulse;
      t.sightMat.emissiveIntensity = 1.5 + pulse;

      // Glow fades in last 1.5s
      if (t.age > cfg.duration - 1.5) {
        const fade = (cfg.duration - t.age) / 1.5;
        t.glowMat.opacity = 0.6 * fade;
        t.ringMat.emissiveIntensity *= fade;
      }
    }
  }

  _findTurretTarget(turret, carBodies) {
    const cfg = turret.config;
    const range2 = cfg.range * cfg.range;
    const pos = turret.car.body.position;
    let bestDist2 = range2;
    let bestTarget = null;

    for (const car of carBodies) {
      if (car === turret.car || car.isEliminated || car.isInvincible) continue;
      const dx = car.body.position.x - pos.x;
      const dz = car.body.position.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestTarget = car;
      }
    }

    // HoloEvade interaction: if target has holoEvade active, 50% chance to aim at decoy
    if (bestTarget && bestTarget.holoEvadeActive) {
      const decoys = this.getHoloDecoys(bestTarget);
      if (decoys && Math.random() < POWERUPS.HOLO_EVADE.missileConfuseChance) {
        const chosen = decoys[Math.floor(Math.random() * decoys.length)];
        // Return a fake target-like object with position
        return { body: { position: { x: chosen.x, y: chosen.group.position.y + 0.55, z: chosen.z } }, isEliminated: false, isInvincible: false, _isFake: true };
      }
    }

    return bestTarget;
  }

  _fireTurretBullet(turret) {
    const cfg = turret.config;
    const car = turret.car;

    // Compute barrel tip in world space
    const worldYaw = car._yaw + turret.headYaw;
    const fwdX = -Math.sin(worldYaw);
    const fwdZ = -Math.cos(worldYaw);

    const roofY = car.mesh.userData.roofY ?? 1.2;
    const spawnX = car.body.position.x + fwdX * 0.9;
    const spawnZ = car.body.position.z + fwdZ * 0.9;
    const spawnY = car.body.position.y - 0.55 + roofY + 0.2;

    // Bullet mesh
    const bulletMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00, transparent: true, opacity: 0.9,
    });
    const bullet = new THREE.Mesh(_sharedGeo.turretBullet, bulletMat);
    bullet.position.set(spawnX, spawnY, spawnZ);
    this.scene.add(bullet);

    // Bullet glow
    const glowMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0xffaa00,
      transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(0.8);
    glow.position.set(spawnX, spawnY, spawnZ);
    this.scene.add(glow);

    this._turretBullets.push({
      owner: car, config: cfg,
      mesh: bullet, mat: bulletMat,
      glow, glowMat,
      x: spawnX, y: spawnY, z: spawnZ,
      prevX: spawnX, prevZ: spawnZ,
      vx: fwdX * cfg.bulletSpeed,
      vz: fwdZ * cfg.bulletSpeed,
      age: 0,
    });

    // Muzzle flash (brief sprite at barrel tip)
    const flashMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0xffdd44,
      transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.scale.setScalar(1.2);
    flash.position.set(spawnX, spawnY, spawnZ);
    this.scene.add(flash);
    this._vfxObjects.push({
      type: 'turret_flash',
      flash, flashMat,
      age: 0, duration: 0.12,
    });

    this._playTurretFireSFX();
  }

  _updateTurretBullets(dt, carBodies) {
    for (let i = this._turretBullets.length - 1; i >= 0; i--) {
      const b = this._turretBullets[i];
      b.age += dt;

      if (b.age >= b.config.bulletLifetime) {
        this._removeTurretBullet(i);
        continue;
      }

      // Save previous position for swept collision
      b.prevX = b.x;
      b.prevZ = b.z;

      // Move
      b.x += b.vx * dt;
      b.z += b.vz * dt;

      // Sync mesh
      b.mesh.position.set(b.x, b.y, b.z);
      b.glow.position.set(b.x, b.y, b.z);

      // Fade glow over lifetime
      b.glowMat.opacity = 0.5 * (1 - b.age / b.config.bulletLifetime);

      // Collision: cars (swept sphere)
      let hit = false;
      for (const car of carBodies) {
        if (car === b.owner || car.isEliminated || car.isInvincible) continue;
        if (sweptSphereHit(
          b.prevX, b.prevZ, b.x, b.z,
          car.body.position.x, car.body.position.y, car.body.position.z,
          b.y, b.config.bulletRadius + 1.0,
        )) {
          car.takeDamage(b.config.damage, b.owner, false);
          // Light knockback in bullet direction
          const speed = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
          if (speed > 0.1) {
            car.body.velocity.x += (b.vx / speed) * b.config.knockback;
            car.body.velocity.z += (b.vz / speed) * b.config.knockback;
          }
          car.lastHitBy = { source: b.owner, wasAbility: false, time: performance.now() };
          this._emit('powerup-hit', { attacker: b.owner, victim: car, type: 'AUTO_TURRET' });

          // Small hit spark
          this._spawnBulletHitVFX(b.x, b.y, b.z);
          hit = true;
          break;
        }
      }
      if (hit) { this._removeTurretBullet(i); continue; }

      // Out of bounds
      const oobLimit = this._oobLimit;
      if (Math.abs(b.x) > oobLimit || Math.abs(b.z) > oobLimit) {
        this._removeTurretBullet(i);
      }
    }
  }

  _spawnBulletHitVFX(x, y, z) {
    const flashMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0xffaa00,
      transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.scale.setScalar(2);
    flash.position.set(x, y, z);
    this.scene.add(flash);
    this._vfxObjects.push({
      type: 'turret_flash',
      flash, flashMat,
      age: 0, duration: 0.2,
    });
  }

  _removeTurret(index) {
    const t = this._activeTurrets[index];
    t.car.mesh.remove(t.group);
    t.car.mesh.remove(t.glow);
    t.baseMat.dispose();
    t.bodyMat.dispose();
    t.barrelMat.dispose();
    t.muzzleMat.dispose();
    t.ringMat.dispose();
    t.sightMat.dispose();
    t.glowMat.dispose();
    this._activeTurrets.splice(index, 1);
  }

  _removeTurretBullet(index) {
    const b = this._turretBullets[index];
    this.scene.remove(b.mesh);
    this.scene.remove(b.glow);
    b.mat.dispose();
    b.glowMat.dispose();
    this._turretBullets.splice(index, 1);
  }

  _playTurretDeploySFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      // Mechanical deployment sound — metallic ramp up
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.15);
      osc.frequency.setValueAtTime(350, now + 0.2);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);

      // Metallic click
      const click = ctx.createOscillator();
      const clickGain = ctx.createGain();
      click.type = 'square';
      click.frequency.setValueAtTime(2000, now + 0.15);
      clickGain.gain.setValueAtTime(0.06, now + 0.15);
      clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      click.connect(clickGain).connect(ctx.destination);
      click.start(now + 0.15);
      click.stop(now + 0.22);
    } catch (_) { /* audio not available */ }
  }

  _playTurretFireSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      // Short punchy shot — high-freq burst
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.08);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;
      filter.Q.value = 1;

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } catch (_) { /* audio not available */ }
  }

  // =====================================================================
  //  GLITCH BOMB
  // =====================================================================

  /**
   * Detonate Glitch Bomb — like Mario Kart's Blooper: an EMP pulse goes out
   * and ALL other cars in the arena get a nasty CRT/glitch screen effect.
   * The local player sees a full-screen overlay; bots get behavioral disruption.
   */
  _detonateGlitchBomb(car) {
    const config = POWERUPS.GLITCH_BOMB;
    const carBodies = this.getCarBodies();
    const localPlayer = this.getLocalPlayer();

    // ── VFX: expanding pulse wave from the caster ──
    this._spawnGlitchPulseVFX(car);

    // ── Apply glitch to all OTHER cars in blast radius ──
    for (const target of carBodies) {
      if (target === car || target.isEliminated) continue;
      const dx = target.body.position.x - car.body.position.x;
      const dz = target.body.position.z - car.body.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > config.blastRadius) continue;

      // Light damage
      target.takeDamage(config.damage, car, false);
      target.lastHitBy = { source: car, wasAbility: false, time: performance.now() };

      // Apply glitch effect to this car
      this._applyGlitchToTarget(target, car, config);
    }

    this._playGlitchBombSFX();
    this._emit('used', { car, type: 'GLITCH_BOMB' });
  }

  _applyGlitchToTarget(target, attacker, config) {
    // Remove existing glitch on this car if any
    this._removeGlitchFromCar(target);

    const localPlayer = this.getLocalPlayer();
    const isLocal = target === localPlayer;

    // Flag on the car for bot AI to read
    target.glitchBombActive = true;
    target._glitchBombTimer = config.duration;

    // Store original materials for restoration
    const origMaterials = [];
    target.mesh.traverse((child) => {
      if (child.isMesh && child.material) {
        origMaterials.push({
          mesh: child,
          emissive: child.material.emissive ? child.material.emissive.clone() : null,
          emissiveIntensity: child.material.emissiveIntensity || 0,
        });
      }
    });

    const entry = {
      car: target,
      attacker,
      age: 0,
      duration: config.duration,
      origMaterials,
      isLocal,
      // Per-car jitter state
      jitterTimer: 0,
      jitterOffsetX: 0,
      jitterOffsetZ: 0,
    };

    this._activeGlitchEffects.push(entry);

    // If local player, show the CRT screen overlay
    if (isLocal) {
      this._showGlitchOverlay(config);
    }

    this._emit('powerup-hit', { attacker, victim: target, type: 'GLITCH_BOMB' });
  }

  /** Apply glitch directly to local player (for debug testing) */
  applyGlitchToSelf() {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer) return;
    const config = POWERUPS.GLITCH_BOMB;
    this._applyGlitchToTarget(localPlayer, localPlayer, config);
    this._playGlitchBombSFX();
  }

  _updateGlitchEffects(dt) {
    for (let i = this._activeGlitchEffects.length - 1; i >= 0; i--) {
      const g = this._activeGlitchEffects[i];
      g.age += dt;

      if (g.age >= g.duration || g.car.isEliminated) {
        this._cleanupGlitchEffect(g);
        this._activeGlitchEffects.splice(i, 1);
        continue;
      }

      const t = g.age / g.duration; // 0→1 progress
      const fadeOut = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1; // fade last 30%

      // ── 3D car mesh: RGB color cycling + emissive flicker ──
      g.jitterTimer += dt;
      const glitchFreq = 8 + Math.sin(g.age * 3) * 4; // variable frequency
      const glitchPhase = g.age * glitchFreq;

      for (const om of g.origMaterials) {
        if (!om.mesh.material || !om.mesh.material.emissive) continue;
        // Cycle through glitch colors: green→magenta→cyan→white
        const colorT = (glitchPhase * 2) % 4;
        let r, gr, b;
        if (colorT < 1) { r = 0; gr = 1; b = 0.25; }       // green
        else if (colorT < 2) { r = 1; gr = 0; b = 1; }      // magenta
        else if (colorT < 3) { r = 0; gr = 0.8; b = 1; }    // cyan
        else { r = 1; gr = 1; b = 1; }                        // white flash

        const intensity = (0.3 + Math.random() * 0.4) * fadeOut;
        om.mesh.material.emissive.setRGB(r * intensity, gr * intensity, b * intensity);
        om.mesh.material.emissiveIntensity = 0.5 + Math.random() * 1.5 * fadeOut;
      }

      // ── Positional jitter (subtle mesh vibration) ──
      if (g.jitterTimer > 0.05 + Math.random() * 0.05) {
        g.jitterTimer = 0;
        const jitterStrength = 0.15 * fadeOut;
        g.jitterOffsetX = (Math.random() - 0.5) * jitterStrength;
        g.jitterOffsetZ = (Math.random() - 0.5) * jitterStrength;
      }
      // Apply jitter offset to visual mesh only (not physics)
      if (g.car.mesh) {
        g.car.mesh.position.x += g.jitterOffsetX;
        g.car.mesh.position.z += g.jitterOffsetZ;
      }

      // ── Update DOM overlay for local player ──
      if (g.isLocal && this._glitchOverlay) {
        this._updateGlitchOverlay(g.age, g.duration, fadeOut);
      }
    }
  }

  _cleanupGlitchEffect(g) {
    g.car.glitchBombActive = false;
    g.car._glitchBombTimer = 0;

    // Restore original materials
    for (const om of g.origMaterials) {
      if (!om.mesh.material || !om.mesh.material.emissive) continue;
      if (om.emissive) om.mesh.material.emissive.copy(om.emissive);
      else om.mesh.material.emissive.setRGB(0, 0, 0);
      om.mesh.material.emissiveIntensity = om.emissiveIntensity;
    }

    // Remove jitter
    // (mesh position is re-synced from physics every frame, so no manual reset needed)

    // Remove DOM overlay if local
    if (g.isLocal) {
      this._hideGlitchOverlay();
    }
  }

  _removeGlitchFromCar(car) {
    for (let i = this._activeGlitchEffects.length - 1; i >= 0; i--) {
      if (this._activeGlitchEffects[i].car === car) {
        this._cleanupGlitchEffect(this._activeGlitchEffects[i]);
        this._activeGlitchEffects.splice(i, 1);
      }
    }
  }

  /** Check if a car is currently glitched (used by BotBrain) */
  isGlitched(car) {
    return !!car.glitchBombActive;
  }

  // ── Glitch Bomb: Full-screen CRT overlay ──────────────────────────────

  _showGlitchOverlay(config) {
    if (this._glitchOverlay) this._hideGlitchOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'glitch-bomb-overlay';
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;
      pointer-events:none;z-index:500;overflow:hidden;
    `;

    // ── Layer 1: CRT scanlines ──
    const scanlines = document.createElement('div');
    scanlines.className = 'glitch-scanlines';
    scanlines.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      background:repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.15) 0px,
        rgba(0,0,0,0.15) 1px,
        transparent 1px,
        transparent 3px
      );
      opacity:${config.scanlineIntensity};
      animation:glitch-scanline-scroll 0.1s linear infinite;
    `;
    overlay.appendChild(scanlines);

    // ── Layer 2: RGB chromatic aberration (three offset colored layers) ──
    const rgbShift = document.createElement('div');
    rgbShift.className = 'glitch-rgb';
    rgbShift.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      pointer-events:none;
    `;
    // Red channel
    const redLayer = document.createElement('div');
    redLayer.style.cssText = `
      position:absolute;top:0;left:-${config.rgbShiftAmount}px;width:100%;height:100%;
      background:rgba(255,0,0,0.06);
      mix-blend-mode:screen;
      animation:glitch-rgb-red 0.15s ease-in-out infinite alternate;
    `;
    // Blue channel
    const blueLayer = document.createElement('div');
    blueLayer.style.cssText = `
      position:absolute;top:0;left:${config.rgbShiftAmount}px;width:100%;height:100%;
      background:rgba(0,0,255,0.06);
      mix-blend-mode:screen;
      animation:glitch-rgb-blue 0.12s ease-in-out infinite alternate;
    `;
    rgbShift.appendChild(redLayer);
    rgbShift.appendChild(blueLayer);
    overlay.appendChild(rgbShift);

    // ── Layer 3: Static noise canvas ──
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = 256;
    noiseCanvas.height = 256;
    noiseCanvas.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      opacity:${config.noiseIntensity};
      mix-blend-mode:overlay;
      image-rendering:pixelated;
    `;
    overlay.appendChild(noiseCanvas);
    this._glitchNoiseCanvas = noiseCanvas;
    this._glitchNoiseCtx = noiseCanvas.getContext('2d');

    // ── Layer 4: Screen tear strips ──
    const tearContainer = document.createElement('div');
    tearContainer.className = 'glitch-tears';
    tearContainer.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      overflow:hidden;
    `;
    overlay.appendChild(tearContainer);
    this._glitchTearContainer = tearContainer;

    // ── Layer 5: VHS tracking line ──
    const vhsLine = document.createElement('div');
    vhsLine.className = 'glitch-vhs-line';
    vhsLine.style.cssText = `
      position:absolute;left:0;width:100%;height:3px;
      background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 30%, rgba(255,255,255,0.8) 50%, rgba(255,255,255,0.5) 70%, transparent 100%);
      opacity:0.6;
      animation:glitch-vhs-scan 2s linear infinite;
      box-shadow:0 0 10px 2px rgba(0,255,65,0.3);
    `;
    overlay.appendChild(vhsLine);

    // ── Layer 6: CRT vignette (curved edges) ──
    const vignette = document.createElement('div');
    vignette.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%);
      pointer-events:none;
    `;
    overlay.appendChild(vignette);

    // ── Layer 7: Color inversion flash container ──
    const flashLayer = document.createElement('div');
    flashLayer.className = 'glitch-flash';
    flashLayer.style.cssText = `
      position:absolute;top:0;left:0;width:100%;height:100%;
      background:rgba(0,255,65,0.12);
      opacity:0;
      mix-blend-mode:exclusion;
    `;
    overlay.appendChild(flashLayer);
    this._glitchFlashLayer = flashLayer;

    // ── Inject CSS animations ──
    if (!document.getElementById('glitch-bomb-styles')) {
      const style = document.createElement('style');
      style.id = 'glitch-bomb-styles';
      style.textContent = `
        @keyframes glitch-scanline-scroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(3px); }
        }
        @keyframes glitch-rgb-red {
          0% { transform: translate(-6px, 1px); }
          25% { transform: translate(-10px, -1px); }
          50% { transform: translate(-4px, 2px); }
          75% { transform: translate(-8px, 0px); }
          100% { transform: translate(-5px, -1px); }
        }
        @keyframes glitch-rgb-blue {
          0% { transform: translate(6px, -1px); }
          25% { transform: translate(8px, 1px); }
          50% { transform: translate(4px, -2px); }
          75% { transform: translate(10px, 0px); }
          100% { transform: translate(5px, 1px); }
        }
        @keyframes glitch-vhs-scan {
          0% { top: -3px; }
          100% { top: 100%; }
        }
        @keyframes glitch-tear-slide {
          0% { transform: translateX(0); }
          20% { transform: translateX(15px); }
          40% { transform: translateX(-10px); }
          60% { transform: translateX(8px); }
          80% { transform: translateX(-5px); }
          100% { transform: translateX(0); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    this._glitchOverlay = overlay;
    this._glitchTearTimer = 0;
    this._glitchFlashTimer = 0;
  }

  _updateGlitchOverlay(age, duration, fadeOut) {
    if (!this._glitchOverlay) return;

    // ── Update noise canvas (random static) ──
    const ctx = this._glitchNoiseCtx;
    if (ctx) {
      const w = 256, h = 256;
      const imageData = ctx.createImageData(w, h);
      const data = imageData.data;
      // Sparse noise — only fill ~30% of pixels for performance
      for (let i = 0; i < data.length; i += 4) {
        if (Math.random() < 0.3) {
          const v = Math.random() * 255;
          data[i] = v;
          data[i + 1] = v * (0.8 + Math.random() * 0.4);
          data[i + 2] = v * (0.6 + Math.random() * 0.6);
          data[i + 3] = Math.random() * 180;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      this._glitchNoiseCanvas.style.opacity = (0.15 + Math.random() * 0.25) * fadeOut;
    }

    // ── Screen tear strips (random horizontal displacement bands) ──
    this._glitchTearTimer += 1 / 60;
    if (this._glitchTearTimer > 0.08 + Math.random() * 0.15) {
      this._glitchTearTimer = 0;
      const container = this._glitchTearContainer;
      if (container) {
        container.innerHTML = '';
        const tearCount = Math.floor(1 + Math.random() * 3);
        for (let t = 0; t < tearCount; t++) {
          const strip = document.createElement('div');
          const topPct = Math.random() * 100;
          const heightPx = 2 + Math.random() * 20;
          const shift = (Math.random() - 0.5) * 30 * fadeOut;
          strip.style.cssText = `
            position:absolute;top:${topPct}%;left:0;width:100%;height:${heightPx}px;
            background:linear-gradient(90deg,
              transparent ${Math.random()*10}%,
              rgba(0,255,65,${0.08*fadeOut}) ${20+Math.random()*20}%,
              rgba(255,0,255,${0.05*fadeOut}) ${60+Math.random()*20}%,
              transparent ${90+Math.random()*10}%
            );
            transform:translateX(${shift}px) skewX(${(Math.random()-0.5)*5}deg);
            animation:glitch-tear-slide ${0.05+Math.random()*0.1}s ease-in-out;
          `;
          container.appendChild(strip);
        }
      }
    }

    // ── Color inversion flash (random bursts) ──
    this._glitchFlashTimer += 1 / 60;
    if (this._glitchFlashTimer > 0.3 + Math.random() * 0.5) {
      this._glitchFlashTimer = 0;
      if (this._glitchFlashLayer && Math.random() < 0.4) {
        const colors = ['rgba(0,255,65,0.15)', 'rgba(255,0,255,0.12)', 'rgba(0,200,255,0.1)', 'rgba(255,255,255,0.18)'];
        this._glitchFlashLayer.style.background = colors[Math.floor(Math.random() * colors.length)];
        this._glitchFlashLayer.style.opacity = fadeOut;
        setTimeout(() => {
          if (this._glitchFlashLayer) this._glitchFlashLayer.style.opacity = 0;
        }, 50 + Math.random() * 80);
      }
    }

    // ── Overall overlay fade-out in last 30% ──
    if (this._glitchOverlay) {
      this._glitchOverlay.style.opacity = fadeOut;
    }
  }

  _hideGlitchOverlay() {
    if (this._glitchOverlay && this._glitchOverlay.parentNode) {
      this._glitchOverlay.parentNode.removeChild(this._glitchOverlay);
    }
    this._glitchOverlay = null;
    this._glitchNoiseCanvas = null;
    this._glitchNoiseCtx = null;
    this._glitchTearContainer = null;
    this._glitchFlashLayer = null;
  }

  // ── Glitch Bomb: detonation VFX (3D pulse wave) ───────────────────────

  _spawnGlitchPulseVFX(car) {
    const cx = car.body.position.x;
    const cy = car.body.position.y + 0.5;
    const cz = car.body.position.z;

    // Expanding ring (torus)
    const ringGeo = new THREE.TorusGeometry(1, 0.15, 6, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ff41, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(cx, cy, cz);
    ring.rotation.x = Math.PI / 2;
    this.scene.add(ring);

    // Second ring (magenta, slightly delayed feel)
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: 0xff00ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring2 = new THREE.Mesh(ringGeo, ring2Mat);
    ring2.position.set(cx, cy, cz);
    ring2.rotation.x = Math.PI / 2;
    this.scene.add(ring2);

    // Central flash
    const flashMat = new THREE.SpriteMaterial({
      map: _glowTexture, color: 0x00ff41,
      transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.scale.setScalar(3);
    flash.position.set(cx, cy, cz);
    this.scene.add(flash);

    // Glitch debris particles (small cubes flying outward)
    const debrisGroup = new THREE.Group();
    debrisGroup.position.set(cx, cy, cz);
    const debrisItems = [];
    const debrisGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    for (let d = 0; d < 16; d++) {
      const angle = (d / 16) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 8 + Math.random() * 12;
      const color = [0x00ff41, 0xff00ff, 0x00ccff, 0xffffff][d % 4];
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(debrisGeo, mat);
      mesh.position.set(0, 0, 0);
      debrisGroup.add(mesh);
      debrisItems.push({
        mesh, mat,
        vx: Math.cos(angle) * speed,
        vy: 2 + Math.random() * 4,
        vz: Math.sin(angle) * speed,
        life: 0.4 + Math.random() * 0.4,
      });
    }
    this.scene.add(debrisGroup);

    this._vfxObjects.push({
      type: 'glitch_pulse',
      ring, ringMat, ring2, ring2Mat,
      flash, flashMat,
      debrisGroup, debrisItems,
      cx, cy, cz,
      age: 0,
      duration: 1.2,
    });
  }

  // ── Glitch Bomb: SFX ──────────────────────────────────────────────────

  _playGlitchBombSFX() {
    try {
      const ctx = this._getAudioCtx();
      const now = ctx.currentTime;

      // ── Layer 1: Digital glitch sweep (descending saw) ──
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      const filter1 = ctx.createBiquadFilter();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(2000, now);
      osc1.frequency.exponentialRampToValueAtTime(80, now + 0.4);
      osc1.frequency.setValueAtTime(1500, now + 0.45);
      osc1.frequency.exponentialRampToValueAtTime(60, now + 0.8);
      filter1.type = 'bandpass';
      filter1.frequency.value = 800;
      filter1.Q.value = 2;
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.linearRampToValueAtTime(0.2, now + 0.1);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
      osc1.connect(filter1).connect(gain1).connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.9);

      // ── Layer 2: Bit-crush noise burst ──
      const noiseLen = 0.6;
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * noiseLen | 0, ctx.sampleRate);
      const noiseData = noiseBuf.getChannelData(0);
      // Stepped noise (bit-crushed feel)
      let held = 0;
      for (let i = 0; i < noiseData.length; i++) {
        if (i % 40 === 0) held = (Math.random() * 2 - 1);
        noiseData[i] = held;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nGain = ctx.createGain();
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(3000, now);
      nFilter.frequency.exponentialRampToValueAtTime(500, now + noiseLen);
      nGain.gain.setValueAtTime(0.12, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
      noise.connect(nFilter).connect(nGain).connect(ctx.destination);
      noise.start(now);

      // ── Layer 3: Sub bass thud ──
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(60, now);
      sub.frequency.exponentialRampToValueAtTime(25, now + 0.3);
      subGain.gain.setValueAtTime(0.25, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      sub.connect(subGain).connect(ctx.destination);
      sub.start(now);
      sub.stop(now + 0.4);

      // ── Layer 4: EMP zap (high freq square burst) ──
      const zap = ctx.createOscillator();
      const zapGain = ctx.createGain();
      zap.type = 'square';
      zap.frequency.setValueAtTime(4000, now);
      zap.frequency.exponentialRampToValueAtTime(200, now + 0.15);
      zapGain.gain.setValueAtTime(0.06, now);
      zapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      zap.connect(zapGain).connect(ctx.destination);
      zap.start(now);
      zap.stop(now + 0.2);
    } catch (_) { /* audio not available */ }
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
    // Clean up holo decoys
    for (const h of this._holoDecoys) {
      h.car.holoEvadeActive = false;
      h.car._restoreCarOpacity();
      this._cleanupHoloDecoy(h);
    }
    this._holoDecoys.length = 0;
    // Clean up turrets + bullets
    for (let i = this._activeTurrets.length - 1; i >= 0; i--) this._removeTurret(i);
    for (let i = this._turretBullets.length - 1; i >= 0; i--) this._removeTurretBullet(i);
    // Clean up glitch effects
    for (const g of this._activeGlitchEffects) this._cleanupGlitchEffect(g);
    this._activeGlitchEffects.length = 0;
    this._hideGlitchOverlay();
    // Clean up repair VFX
    for (const r of this._repairVFX) {
      for (const p of r.particles) { this.scene.remove(p.mesh); p.mat.dispose(); }
      this.scene.remove(r.glow); r.glowMat.dispose();
    }
    this._repairVFX.length = 0;
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
    for (const h of this._holoDecoys) this._cleanupHoloDecoy(h);
    this._holoDecoys.length = 0;
    for (let i = this._activeTurrets.length - 1; i >= 0; i--) this._removeTurret(i);
    for (let i = this._turretBullets.length - 1; i >= 0; i--) this._removeTurretBullet(i);
    for (const g of this._activeGlitchEffects) this._cleanupGlitchEffect(g);
    this._activeGlitchEffects.length = 0;
    this._hideGlitchOverlay();
    for (const r of this._repairVFX) {
      for (const p of r.particles) { this.scene.remove(p.mesh); p.mat.dispose(); }
      this.scene.remove(r.glow); r.glowMat.dispose();
    }
    this._repairVFX.length = 0;
    for (const vfx of this._vfxObjects) this._cleanupVFX(vfx);
    this._vfxObjects.length = 0;
  }
}
