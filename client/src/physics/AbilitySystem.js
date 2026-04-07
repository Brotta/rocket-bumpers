import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CARS, COLLISION_GROUPS, DAMAGE } from '../core/Config.js';

// Reusable objects for leap landing raycast (avoid per-frame allocations)
const _leapFrom = new CANNON.Vec3();
const _leapTo = new CANNON.Vec3();
const _leapResult = new CANNON.RaycastResult();

/**
 * AbilitySystem — one per player / bot.
 *
 * Constructor deps:
 *   carType       – key in CARS
 *   carBody       – CarBody instance
 *   opts.scene    – THREE.Scene (for VFX objects)
 *   opts.world    – CANNON.World (for trail bodies etc.)
 *   opts.getOtherBodies – () => CarBody[] (all others, for PULSE / LEAP / TRAIL)
 *
 * Public API:
 *   use()         – activate ability if ready
 *   update(dt)    – tick timers & effects every frame
 *   state         – 'ready' | 'active' | 'cooldown'
 *   cooldownProgress – 0..1  (1 = ready; 0 = just entered cooldown)
 *   isActive      – boolean shorthand
 */
export class AbilitySystem {
  constructor(carType, carBody, { scene, world, getOtherBodies }) {
    this.carType = carType;
    this.carBody = carBody;
    this.scene = scene;
    this.world = world;
    this.getOtherBodies = getOtherBodies;

    const carDef = CARS[carType];
    this.abilityDef = carDef.ability;
    this.cooldown = this.abilityDef.cooldown;
    this.duration = this.abilityDef.duration || 0; // 0 = instant

    // State machine
    this.state = 'ready'; // 'ready' | 'active' | 'cooldown'
    this._activeTimer = 0;
    this._cooldownTimer = 0;

    // LEAP tracking
    this.isLeaping = false;
    this._wasInAir = false;

    // TRAIL objects pool
    this._trailObjects = []; // { mesh, body, life }
    this._trailSpawnTimer = 0;

    // Global registry of active trail bodies (shared across all AbilitySystem instances)
    // Used by CollisionHandler to avoid scanning all world.bodies
    if (!AbilitySystem._activeTrailBodies) {
      AbilitySystem._activeTrailBodies = new Set();
    }

    // VFX refs for cleanup
    this._vfx = [];

    // Stash default collision mask for PHASE restore
    this._defaultCollisionMask =
      COLLISION_GROUPS.ARENA |
      COLLISION_GROUPS.CAR |
      COLLISION_GROUPS.PICKUP |
      COLLISION_GROUPS.TRAIL;
  }

  // ── Public ────────────────────────────────────────────────────────────

  get isActive() {
    return this.state === 'active';
  }

  /** 0 → just entered cooldown, 1 → ready */
  get cooldownProgress() {
    if (this.state === 'ready') return 1;
    if (this.state === 'active') return 1;
    return 1 - this._cooldownTimer / this.cooldown;
  }

  use() {
    if (this.state !== 'ready') return false;
    this._activate();
    return true;
  }

  update(dt) {
    // Active timer
    if (this.state === 'active') {
      this._activeTimer -= dt;
      this._tickActive(dt);
      if (this._activeTimer <= 0) {
        this._deactivate();
      }
    }

    // Cooldown timer
    if (this.state === 'cooldown') {
      this._cooldownTimer -= dt;
      if (this._cooldownTimer <= 0) {
        this.state = 'ready';
      }
    }

    // LEAP landing detection (runs regardless of state)
    if (this.isLeaping) {
      this._checkLeapLanding();
    }

    // Trail object lifetime
    this._updateTrailObjects(dt);
  }

  /** Force-reset ability to ready state. Call on respawn / round reset. */
  forceReset() {
    // If active, skip deactivation logic (CarBody.resetState already cleaned up)
    this.state = 'ready';
    this._activeTimer = 0;
    this._cooldownTimer = 0;
    this.isLeaping = false;
    this._wasInAir = false;
    this._trailSpawnTimer = 0;
    this._clearVfx();
  }

  /** Remove all VFX and trail bodies. Call when car is destroyed / round ends. */
  dispose() {
    this._clearVfx();
    for (const t of this._trailObjects) {
      this.scene.remove(t.mesh);
      this.world.removeBody(t.body);
      AbilitySystem._activeTrailBodies.delete(t.body);
    }
    this._trailObjects.length = 0;
  }

  // ── Activation / Deactivation router ──────────────────────────────────

  _activate() {
    const handler = {
      FANG: () => this._activateNitro(),
      HORNET: () => this._activateDash(),
      RHINO: () => this._activateRam(),
      VIPER: () => this._activateTrail(),
      TOAD: () => this._activatePulse(),
      LYNX: () => this._activateDrift(),
      MAMMOTH: () => this._activateLeap(),
      GHOST: () => this._activatePhase(),
    }[this.carType];

    handler();
  }

  _deactivate() {
    const handler = {
      FANG: () => this._deactivateNitro(),
      HORNET: () => {}, // instant
      RHINO: () => this._deactivateRam(),
      VIPER: () => this._deactivateTrail(),
      TOAD: () => {}, // instant
      LYNX: () => this._deactivateDrift(),
      MAMMOTH: () => {}, // landing handles deactivation
      GHOST: () => this._deactivatePhase(),
    }[this.carType];

    handler();
    this.state = 'cooldown';
    this._cooldownTimer = this.cooldown;
  }

  /** Per-frame work while ability is active (only for duration-based abilities). */
  _tickActive(dt) {
    if (this.carType === 'VIPER') this._tickTrail(dt);
  }

  // ── 1. NITRO (FANG) ──────────────────────────────────────────────────

  _activateNitro() {
    this.state = 'active';
    this._activeTimer = this.abilityDef.duration;
    this.carBody.speedMultiplier = this.abilityDef.multiplier;
    // VFX: boost the emissive on the car
    this._setCarEmissiveIntensity(0.6);
  }

  _deactivateNitro() {
    this.carBody.speedMultiplier = 1;
    this._setCarEmissiveIntensity(0.15);
  }

  // ── 2. DASH (HORNET) ─────────────────────────────────────────────────

  _activateDash() {
    const body = this.carBody.body;
    const mesh = this.carBody.mesh;

    // Ghost trail at old position
    this._spawnGhostTrail(mesh);

    // Teleport forward
    const yaw = this.carBody._yaw;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const dist = this.abilityDef.distance;
    body.position.x += fwdX * dist;
    body.position.z += fwdZ * dist;
    this.carBody.syncMesh();

    // Instant → straight to cooldown
    this.state = 'cooldown';
    this._cooldownTimer = this.cooldown;
  }

  _spawnGhostTrail(mesh) {
    // Semi-transparent clone fading out over 0.5s
    const ghost = mesh.clone(true);
    ghost.traverse((child) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.transparent = true;
        child.material.opacity = 0.5;
      }
    });
    this.scene.add(ghost);

    let life = 0.5;
    const fade = () => {
      life -= 0.016;
      if (life <= 0) {
        this.scene.remove(ghost);
        return;
      }
      ghost.traverse((c) => {
        if (c.isMesh) c.material.opacity = Math.max(0, life / 0.5) * 0.5;
      });
      requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
  }

  // ── 3. RAM (RHINO) ───────────────────────────────────────────────────

  _activateRam() {
    this.state = 'active';
    this._activeTimer = this.abilityDef.duration;
    this.carBody.body.mass = this.abilityDef.infiniteMass;
    this.carBody.body.updateMassProperties();
    this.carBody.hasRam = true;
    // Slight speed boost
    this.carBody.speedMultiplier = 1.2;
    // VFX: red glow
    this._setCarColor(0xff2200, 0.8);
  }

  _deactivateRam() {
    this.carBody.body.mass = this.carBody._originalMass;
    this.carBody.body.updateMassProperties();
    this.carBody.hasRam = false;
    this.carBody.speedMultiplier = 1;
    this._restoreCarColor();
  }

  // ── 4. TRAIL (VIPER) ─────────────────────────────────────────────────

  _activateTrail() {
    this.state = 'active';
    this._activeTimer = this.abilityDef.duration;
    this.carBody.speedMultiplier = this.abilityDef.multiplier;
    this._trailSpawnTimer = 0;
    this._setCarEmissiveIntensity(0.6);
  }

  _deactivateTrail() {
    this.carBody.speedMultiplier = 1;
    this._setCarEmissiveIntensity(0.15);
  }

  _tickTrail(dt) {
    this._trailSpawnTimer -= dt;
    if (this._trailSpawnTimer <= 0) {
      this._trailSpawnTimer = 0.3;
      this._spawnTrailFire();
    }
  }

  _spawnTrailFire() {
    const body = this.carBody.body;
    const yaw = this.carBody._yaw;

    // Spawn behind the car
    const behindX = Math.sin(yaw) * 1.5;
    const behindZ = Math.cos(yaw) * 1.5;
    const px = body.position.x + behindX;
    const pz = body.position.z + behindZ;
    const py = 0.3;

    // Visual
    const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff4400,
      emissive: 0xff4400,
      emissiveIntensity: 2,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, pz);
    this.scene.add(mesh);

    // Physics body
    const trailBody = new CANNON.Body({
      mass: 0, // static sensor
      shape: new CANNON.Box(new CANNON.Vec3(0.25, 0.25, 0.25)),
      position: new CANNON.Vec3(px, py, pz),
      collisionFilterGroup: COLLISION_GROUPS.TRAIL,
      collisionFilterMask: COLLISION_GROUPS.CAR,
      isTrigger: true,
    });
    trailBody._isTrailFire = true;
    trailBody._ownerId = this.carBody; // for KO attribution
    this.world.addBody(trailBody);

    this._trailObjects.push({ mesh, body: trailBody, life: 2.0 });
    AbilitySystem._activeTrailBodies.add(trailBody);
  }

  _updateTrailObjects(dt) {
    for (let i = this._trailObjects.length - 1; i >= 0; i--) {
      const t = this._trailObjects[i];
      t.life -= dt;

      // Fade out
      if (t.mesh.material.opacity !== undefined) {
        t.mesh.material.opacity = Math.max(0, t.life / 2.0) * 0.9;
      }
      // Flicker scale
      const flicker = 0.8 + Math.sin(t.life * 15) * 0.2;
      t.mesh.scale.setScalar(flicker);

      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        this.world.removeBody(t.body);
        AbilitySystem._activeTrailBodies.delete(t.body);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        this._trailObjects.splice(i, 1);
      }
    }
  }

  // ── 5. PULSE (TOAD) ──────────────────────────────────────────────────

  _activatePulse() {
    const pos = this.carBody.body.position;
    const radius = this.abilityDef.radius;
    const force = 300;

    // Apply knockback to all nearby cars
    const others = this.getOtherBodies();
    for (const other of others) {
      const oPos = other.body.position;
      const dx = oPos.x - pos.x;
      const dz = oPos.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < radius && dist > 0.1) {
        if (other.isEliminated || other.isInvincible) continue;
        const falloff = 1 - dist / radius;
        const impulse = force * falloff;
        const nx = dx / dist;
        const nz = dz / dist;
        other.body.velocity.x += nx * impulse * 0.05;
        other.body.velocity.z += nz * impulse * 0.05;
        other.body.velocity.y += 3 * falloff; // slight upward pop

        // PULSE damage (scaled by falloff — closer = more damage)
        const pulseDmg = DAMAGE.PULSE_DAMAGE * falloff;
        other.takeDamage(pulseDmg, this.carBody, true);
      }
    }

    // VFX: expanding ring
    this._spawnPulseRing(pos);

    // Instant → cooldown
    this.state = 'cooldown';
    this._cooldownTimer = this.cooldown;
  }

  _spawnPulseRing(pos) {
    const ringGeo = new THREE.RingGeometry(0.5, 1.0, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x9b30ff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(pos.x, 0.3, pos.z);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);

    const maxRadius = this.abilityDef.radius;
    let t = 0;
    const expand = () => {
      t += 0.016;
      const progress = t / 0.4; // 0.4s animation
      if (progress >= 1) {
        this.scene.remove(ring);
        ringGeo.dispose();
        ringMat.dispose();
        return;
      }
      const s = 1 + progress * maxRadius;
      ring.scale.setScalar(s);
      ringMat.opacity = 0.8 * (1 - progress);
      requestAnimationFrame(expand);
    };
    requestAnimationFrame(expand);
  }

  // ── 6. DRIFT (LYNX) ──────────────────────────────────────────────────

  _activateDrift() {
    this.state = 'active';
    this._activeTimer = this.abilityDef.duration;
    this.carBody.driftMode = true;
    this._setCarEmissiveIntensity(0.5);
  }

  _deactivateDrift() {
    this.carBody.driftMode = false;
    this._setCarEmissiveIntensity(0.15);
  }

  // ── 7. LEAP (MAMMOTH) ────────────────────────────────────────────────

  _activateLeap() {
    this.isLeaping = true;
    this.carBody.body.velocity.y = 12; // strong upward impulse
    this._wasInAir = true;

    // Instant activation, but we track landing separately
    this.state = 'cooldown';
    this._cooldownTimer = this.cooldown;
  }

  _checkLeapLanding() {
    const body = this.carBody.body;

    if (body.velocity.y > 1) {
      this._wasInAir = true;
    }

    if (!this._wasInAir || body.velocity.y > 0.5) return;

    // Raycast downward to detect ground at any height (multi-level arena)
    _leapFrom.set(body.position.x, body.position.y, body.position.z);
    _leapTo.set(body.position.x, body.position.y - 2, body.position.z);
    _leapResult.reset();
    const hit = this.world.raycastClosest(_leapFrom, _leapTo, { collisionFilterMask: COLLISION_GROUPS.ARENA }, _leapResult);

    if (hit && _leapResult.distance < 1.2) {
      this.isLeaping = false;
      this._wasInAir = false;
      this._triggerLeapShockwave();
    }
  }

  _triggerLeapShockwave() {
    const pos = this.carBody.body.position;
    const radius = this.abilityDef.shockwaveRadius;
    const force = this.abilityDef.shockwaveForce;

    const others = this.getOtherBodies();
    for (const other of others) {
      const oPos = other.body.position;
      const dx = oPos.x - pos.x;
      const dz = oPos.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < radius && dist > 0.1) {
        if (other.isEliminated || other.isInvincible) continue;
        const falloff = 1 - dist / radius;
        const nx = dx / dist;
        const nz = dz / dist;
        other.body.velocity.x += nx * force * falloff * 0.05;
        other.body.velocity.z += nz * force * falloff * 0.05;
        other.body.velocity.y += 5 * falloff;

        // LEAP damage (scaled by falloff — closer to epicenter = more damage)
        const leapDmg = DAMAGE.LEAP_DAMAGE * falloff;
        other.takeDamage(leapDmg, this.carBody, true);
      }
    }

    // VFX: ground shockwave ring (reuse pulse ring style but orange)
    this._spawnShockwaveRing(pos);
  }

  _spawnShockwaveRing(pos) {
    const ringGeo = new THREE.RingGeometry(0.3, 0.8, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(pos.x, 0.2, pos.z);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);

    const maxRadius = this.abilityDef.shockwaveRadius;
    let t = 0;
    const expand = () => {
      t += 0.016;
      const progress = t / 0.5;
      if (progress >= 1) {
        this.scene.remove(ring);
        ringGeo.dispose();
        ringMat.dispose();
        return;
      }
      ring.scale.setScalar(1 + progress * maxRadius);
      ringMat.opacity = 0.9 * (1 - progress);
      requestAnimationFrame(expand);
    };
    requestAnimationFrame(expand);
  }

  // ── 8. PHASE (GHOST) ─────────────────────────────────────────────────

  _activatePhase() {
    this.state = 'active';
    this._activeTimer = this.abilityDef.duration;

    // Set collision mask to ARENA only (pass through cars, pickups, trail)
    this.carBody.body.collisionFilterMask = COLLISION_GROUPS.ARENA;

    // VFX: semi-transparent + glitch tint
    this.carBody.mesh.traverse((child) => {
      if (child.isMesh) {
        child.material._origOpacity = child.material.opacity;
        child.material._origTransparent = child.material.transparent;
        child.material.transparent = true;
        child.material.opacity = 0.3;
        if (child.material.emissive) {
          child.material._origEmissiveHex = child.material.emissive.getHex();
          child.material.emissive.set(0x00ffff);
          child.material.emissiveIntensity = 1.5;
        }
      }
    });
  }

  _deactivatePhase() {
    // Restore collision mask
    this.carBody.body.collisionFilterMask = this._defaultCollisionMask;

    // Restore materials
    this.carBody.mesh.traverse((child) => {
      if (child.isMesh) {
        child.material.opacity = child.material._origOpacity ?? 1;
        child.material.transparent = child.material._origTransparent ?? false;
        if (child.material.emissive && child.material._origEmissiveHex !== undefined) {
          child.material.emissive.setHex(child.material._origEmissiveHex);
          child.material.emissiveIntensity = 0.15;
        }
      }
    });
  }

  /** Apply PHASE-style intangibility for respawn invincibility (static helper). */
  static setInvincible(carBody, enabled) {
    if (enabled) {
      carBody.body.collisionFilterMask = COLLISION_GROUPS.ARENA;
    } else {
      carBody.body.collisionFilterMask =
        COLLISION_GROUPS.ARENA |
        COLLISION_GROUPS.CAR |
        COLLISION_GROUPS.PICKUP |
        COLLISION_GROUPS.TRAIL;
    }
  }

  // ── VFX Helpers ───────────────────────────────────────────────────────

  _setCarEmissiveIntensity(intensity) {
    const mats = this.carBody.mesh.userData.emissiveMaterials;
    if (mats) {
      for (let i = 0; i < mats.length; i++) {
        mats[i].emissiveIntensity = intensity;
      }
    }
  }

  _setCarColor(hex, emissiveIntensity) {
    this.carBody.mesh.traverse((child) => {
      if (child.isMesh && child.material.emissive) {
        if (!child.material._origColorHex) {
          child.material._origColorHex = child.material.color.getHex();
          child.material._origEmissiveHex = child.material.emissive.getHex();
          child.material._origEmissiveInt = child.material.emissiveIntensity;
        }
        child.material.color.setHex(hex);
        child.material.emissive.setHex(hex);
        child.material.emissiveIntensity = emissiveIntensity;
      }
    });
  }

  _restoreCarColor() {
    this.carBody.mesh.traverse((child) => {
      if (child.isMesh && child.material._origColorHex !== undefined) {
        child.material.color.setHex(child.material._origColorHex);
        child.material.emissive.setHex(child.material._origEmissiveHex);
        child.material.emissiveIntensity = child.material._origEmissiveInt;
        delete child.material._origColorHex;
        delete child.material._origEmissiveHex;
        delete child.material._origEmissiveInt;
      }
    });
  }

  _clearVfx() {
    for (const obj of this._vfx) {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    this._vfx.length = 0;
  }
}
