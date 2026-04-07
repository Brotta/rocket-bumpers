import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ARENA, POWERUPS, COLLISION_GROUPS, SCORING } from './Config.js';
import { loadModel } from '../rendering/AssetLoader.js';

const PEDESTAL_COUNT = ARENA.powerupPedestalCount; // 6
const RESPAWN_TIME = ARENA.powerupRespawnTime;      // 8s
const PICKUP_RADIUS = 2.0;                          // detection distance
const FLOAT_HEIGHT = 1.4;                           // pickup hover Y
const SPIN_SPEED = 2.0;                             // rad/s
const BOX_MODEL_PATH = 'assets/models/box.glb';

// Rainbow colors for the rotating glow
const RAINBOW_COLORS = [
  new THREE.Color(0xff0000), // red
  new THREE.Color(0xff8800), // orange
  new THREE.Color(0xffff00), // yellow
  new THREE.Color(0x00ff00), // green
  new THREE.Color(0x0088ff), // blue
  new THREE.Color(0x8800ff), // violet
];

const POWERUP_TYPES = Object.keys(POWERUPS); // ['ROCKET_BOOST','SHOCKWAVE','SHIELD','MAGNET']

/**
 * PowerUpManager — spawns, renders, and handles pickup of arena power-ups.
 *
 * 6 fixed pedestal positions on the arena. Each pedestal spawns a random
 * power-up type. Picked up by car proximity (CANNON collision group PICKUP).
 * Max 1 held power-up per player (separate from car ability).
 * Respawns 8s after pickup.
 *
 * Usage:
 *   const mgr = new PowerUpManager(scene, world, () => game.carBodies);
 *   // in game loop:
 *   mgr.update(dt);
 *   // when player presses E/Shift:
 *   const used = mgr.usePlayerPowerUp(localCarBody, allCarBodies);
 */
export class PowerUpManager {
  constructor(scene, world, getCarBodies) {
    this.scene = scene;
    this.world = world;
    this.getCarBodies = getCarBodies;

    // Event listeners
    this._listeners = {};

    // Per-car held power-up: Map<CarBody, string|null>
    this._held = new Map();

    // Pedestal slots
    this._pedestals = [];

    // Shared materials
    this._pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x3d2b1a,
      roughness: 0.5,
      metalness: 0.4,
    });

    // Preload box model, then build pedestals
    this._boxModelReady = loadModel(BOX_MODEL_PATH).then((model) => {
      this._boxTemplate = model;
    }).catch((err) => {
      console.warn('PowerUpManager: failed to load box model, falling back', err);
      this._boxTemplate = null;
    });

    this._buildPedestals();
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
  }

  _emit(event, data) {
    const arr = this._listeners[event];
    if (arr) for (const fn of arr) fn(data);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(dt) {
    const now = performance.now();
    const carBodies = this.getCarBodies();

    for (const pedestal of this._pedestals) {
      // ── Respawn timer ──
      if (!pedestal.active && pedestal.respawnAt > 0 && now >= pedestal.respawnAt) {
        this._spawnPickup(pedestal);
      }

      // ── Animate active pickups ──
      if (pedestal.active && pedestal.pickupMesh) {
        const mesh = pedestal.pickupMesh;

        // Bob up and down
        mesh.position.y =
          (pedestal.y || 0) + FLOAT_HEIGHT + Math.sin(now * 0.003 + pedestal.angle) * 0.15;

        // Slowly spin the box
        if (mesh.userData.boxMesh) {
          mesh.userData.boxMesh.rotation.y += SPIN_SPEED * 0.5 * dt;
        }

        // Rainbow cycling on glow rings
        const t = (now * 0.001 + pedestal.angle) % 6; // cycle through 6 rainbow colors
        const idx = Math.floor(t);
        const frac = t - idx;
        const colorA = RAINBOW_COLORS[idx % 6];
        const colorB = RAINBOW_COLORS[(idx + 1) % 6];
        const rainbowColor = new THREE.Color().lerpColors(colorA, colorB, frac);

        // Offset second ring by half the cycle
        const t2 = (now * 0.001 + pedestal.angle + 3) % 6;
        const idx2 = Math.floor(t2);
        const frac2 = t2 - idx2;
        const rainbowColor2 = new THREE.Color().lerpColors(
          RAINBOW_COLORS[idx2 % 6], RAINBOW_COLORS[(idx2 + 1) % 6], frac2);

        // Rotate glow rings around the box in different axes
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

        // Pulse the pedestal light with rainbow
        pedestal.glowLight.color.copy(rainbowColor);
        pedestal.glowLight.intensity =
          0.6 + Math.sin(now * 0.004 + pedestal.angle * 2) * 0.3;
      }

      // ── Pickup detection ──
      if (pedestal.active) {
        for (const car of carBodies) {
          if (this._held.get(car)) continue; // already holding one

          const dx = car.body.position.x - pedestal.x;
          const dz = car.body.position.z - pedestal.z;
          const dy = car.body.position.y - (pedestal.y || 0);
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < PICKUP_RADIUS && Math.abs(dy) < 3) {
            this._pickup(pedestal, car);
            break; // one pickup per frame per pedestal
          }
        }
      }
    }
  }

  // ── Use held power-up ─────────────────────────────────────────────────

  /**
   * Activate the held power-up for the given car.
   * @returns {boolean} true if a power-up was used
   */
  use(car) {
    const type = this._held.get(car);
    if (!type) return false;

    this._held.set(car, null);
    this._applyEffect(type, car);
    this._emit('used', { car, type });
    return true;
  }

  /** Drop (discard) the held power-up for a car without activating it. */
  drop(car) {
    this._held.set(car, null);
  }

  /** Get the type string of held power-up for a car, or null. */
  getHeld(car) {
    return this._held.get(car) || null;
  }

  /** Get POWERUPS config for held type, or null. */
  getHeldConfig(car) {
    const type = this._held.get(car);
    return type ? POWERUPS[type] : null;
  }

  // ── Build pedestals ───────────────────────────────────────────────────

  _buildPedestals() {
    const dist = ARENA.diameter / 2 * 0.45; // ~27 units from center

    for (let i = 0; i < PEDESTAL_COUNT; i++) {
      const angle = (i / PEDESTAL_COUNT) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const yBase = 0;

      // Visual pedestal cylinder
      const pedestalGeo = new THREE.CylinderGeometry(0.8, 1.0, 0.4, 16);
      const pedestal = new THREE.Mesh(pedestalGeo, this._pedestalMat);
      pedestal.position.set(x, yBase + 0.2, z);
      pedestal.receiveShadow = true;
      this.scene.add(pedestal);

      // Glow ring on pedestal
      const ringGeo = new THREE.TorusGeometry(1.0, 0.08, 8, 32);
      const ringMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xff6600,
        emissiveIntensity: 2,
        transparent: true,
        opacity: 0.7,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(x, yBase + 0.8, z);
      ring.rotation.x = Math.PI / 2;
      this.scene.add(ring);

      // Point light
      const light = new THREE.PointLight(0xff6600, 0.4, 8);
      light.position.set(x, yBase + 1.6, z);
      this.scene.add(light);

      const slot = {
        index: i,
        x,
        z,
        y: yBase,
        angle,
        pedestalMesh: pedestal,
        ringMesh: ring,
        ringMat,
        glowLight: light,
        active: false,
        type: null,
        pickupMesh: null,
        respawnAt: 0,
      };

      this._pedestals.push(slot);

      // Spawn initial pickup
      this._spawnPickup(slot);
    }
  }

  // ── Spawn a pickup on a pedestal ──────────────────────────────────────

  _spawnPickup(pedestal) {
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];

    // Mystery box — all pickups look the same (Mario Kart style)
    const group = new THREE.Group();
    group.position.set(pedestal.x, (pedestal.y || 0) + FLOAT_HEIGHT, pedestal.z);

    // Rainbow glow ring that orbits the box
    const glowRingGeo = new THREE.TorusGeometry(1.0, 0.08, 8, 32);
    const glowRingMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xff0000,
      emissiveIntensity: 3,
      transparent: true,
      opacity: 0.7,
    });
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    group.add(glowRing);

    // Second glow ring (perpendicular, creates a sphere-like orbit effect)
    const glowRing2Mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x00ff00,
      emissiveIntensity: 3,
      transparent: true,
      opacity: 0.7,
    });
    const glowRing2 = new THREE.Mesh(glowRingGeo, glowRing2Mat);
    group.add(glowRing2);

    // Store references for animation
    group.userData.glowRing = glowRing;
    group.userData.glowRingMat = glowRingMat;
    group.userData.glowRing2 = glowRing2;
    group.userData.glowRing2Mat = glowRing2Mat;
    group.userData.boxMesh = null;

    // Load box model into the group
    if (this._boxTemplate) {
      this._addBoxModel(group);
    } else {
      // Model still loading — add once ready
      this._boxModelReady.then(() => {
        if (pedestal.pickupMesh === group && pedestal.active) {
          this._addBoxModel(group);
        }
      });
    }

    this.scene.add(group);

    // Mystery color: white/rainbow for pedestal
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
    box.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    // Center the box vertically so the rings orbit around its middle
    const bbox = new THREE.Box3().setFromObject(box);
    box.position.y = -(bbox.min.y + bbox.max.y) / 2;
    group.add(box);
    group.userData.boxMesh = box;
  }

  // ── Pickup handling ───────────────────────────────────────────────────

  _pickup(pedestal, car) {
    // Give power-up to car
    this._held.set(car, pedestal.type);

    // Remove pickup mesh
    if (pedestal.pickupMesh) {
      this.scene.remove(pedestal.pickupMesh);
      pedestal.pickupMesh = null;
    }

    // Dim pedestal
    pedestal.active = false;
    pedestal.ringMat.emissive.setHex(0x222222);
    pedestal.glowLight.intensity = 0.1;

    // Schedule respawn
    pedestal.respawnAt = performance.now() + RESPAWN_TIME * 1000;

    this._emit('pickup', { car, type: pedestal.type, pedestalIndex: pedestal.index });
  }

  // ── Apply power-up effect ─────────────────────────────────────────────

  _applyEffect(type, car) {
    const config = POWERUPS[type];
    const carBodies = this.getCarBodies();

    switch (type) {
      case 'ROCKET_BOOST':
        this._applyRocketBoost(car, config);
        break;
      case 'SHOCKWAVE':
        this._applyShockwave(car, config, carBodies);
        break;
      case 'SHIELD':
        this._applyShield(car, config);
        break;
      case 'MAGNET':
        this._applyMagnet(car, config, carBodies);
        break;
    }
  }

  // ── ROCKET BOOST: 2× speed for 2s ────────────────────────────────────

  _applyRocketBoost(car, config) {
    car.speedMultiplier *= config.speedMultiplier;

    // VFX: orange glow sphere that fades
    this._spawnUseFX(car, config.color, config.duration);

    const gen = car._generation;
    setTimeout(() => {
      if (car._generation !== gen) return; // stale — car died/respawned
      car.speedMultiplier /= config.speedMultiplier;
    }, config.duration * 1000);
  }

  // ── SHOCKWAVE: instant radial pushback (15 units radius) ─────────────

  _applyShockwave(car, config, carBodies) {
    // VFX: expanding ring
    this._spawnShockwaveFX(car, config);

    const pos = car.body.position;
    const now = performance.now();

    for (const other of carBodies) {
      if (other === car) continue;
      if (other.isInvincible) continue;

      const dx = other.body.position.x - pos.x;
      const dz = other.body.position.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < config.radius && dist > 0.1) {
        // Push force inversely proportional to distance
        const force = (1 - dist / config.radius) * 40;
        const nx = dx / dist;
        const nz = dz / dist;
        other.body.velocity.x += nx * force;
        other.body.velocity.z += nz * force;
        other.body.velocity.y += 3;

        // KO attribution
        other.lastHitBy = { source: car, wasAbility: false, time: now };

        // Score for power-up damage
        car.score += SCORING.powerupKill;
        this._emit('powerup-hit', { attacker: car, victim: other, type: 'SHOCKWAVE' });
      }
    }
  }

  // ── SHIELD: immune to knockback, double mass for 4s ──────────────────

  _applyShield(car, config) {
    // VFX: green sphere around car
    this._spawnUseFX(car, config.color, config.duration);

    car.hasShield = true;
    car.body.mass *= config.massMultiplier;
    car.body.updateMassProperties();

    const gen = car._generation;
    setTimeout(() => {
      if (car._generation !== gen) return; // stale — car died/respawned
      car.hasShield = false;
      car.body.mass /= config.massMultiplier;
      car.body.updateMassProperties();
    }, config.duration * 1000);
  }

  // ── MAGNET: pull nearby cars for 3s ──────────────────────────────────

  _applyMagnet(car, config, _carBodies) {
    // VFX: purple glow
    this._spawnUseFX(car, config.color, config.duration);
    const pullForce = 12;
    const startTime = performance.now();
    const durationMs = config.duration * 1000;
    const gen = car._generation;

    const tick = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= durationMs) return;
      if (car._generation !== gen) return; // stale — car died/respawned

      const carBodies = this.getCarBodies();
      const pos = car.body.position;

      for (const other of carBodies) {
        if (other === car) continue;
        if (other.isInvincible) continue;

        const dx = other.body.position.x - pos.x;
        const dz = other.body.position.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < config.radius && dist > 0.5) {
          const nx = dx / dist;
          const nz = dz / dist;
          // Pull toward car
          other.body.velocity.x -= nx * pullForce * (1 / 60);
          other.body.velocity.z -= nz * pullForce * (1 / 60);

          // KO attribution
          other.lastHitBy = {
            source: car,
            wasAbility: false,
            time: performance.now(),
          };
        }
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  // ── VFX helpers ────────────────────────────────────────────────────────

  /** Glowing sphere around car that follows it and fades out. */
  _spawnUseFX(car, color, duration) {
    const geo = new THREE.SphereGeometry(2, 16, 12);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 3,
      transparent: true,
      opacity: 0.4,
      side: THREE.BackSide,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(car.body.position);
    this.scene.add(sphere);

    const startTime = performance.now();
    const durationMs = duration * 1000;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= durationMs) {
        this.scene.remove(sphere);
        geo.dispose();
        mat.dispose();
        return;
      }
      // Follow car
      sphere.position.copy(car.body.position);
      // Fade out
      mat.opacity = 0.4 * (1 - elapsed / durationMs);
      mat.emissiveIntensity = 3 * (1 - elapsed / durationMs);
      // Pulse scale
      const pulse = 1 + Math.sin(elapsed * 0.008) * 0.15;
      sphere.scale.setScalar(pulse);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  /** Expanding ring for shockwave. */
  _spawnShockwaveFX(car, config) {
    const color = config.color;
    const geo = new THREE.RingGeometry(0.5, 1.5, 32);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 4,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.copy(car.body.position);
    ring.position.y = 0.3;
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);

    const startTime = performance.now();
    const expandDuration = 600; // ms
    const maxRadius = config.radius;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= expandDuration) {
        this.scene.remove(ring);
        geo.dispose();
        mat.dispose();
        return;
      }
      const t = elapsed / expandDuration;
      const scale = 1 + t * (maxRadius / 1.5);
      ring.scale.setScalar(scale);
      mat.opacity = 0.8 * (1 - t);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  // ── Reset (new round) ─────────────────────────────────────────────────

  reset() {
    // Clear all held power-ups
    this._held.clear();

    // Re-spawn all pedestals immediately
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

  // ── Dispose ───────────────────────────────────────────────────────────

  dispose() {
    for (const pedestal of this._pedestals) {
      this.scene.remove(pedestal.pedestalMesh);
      this.scene.remove(pedestal.ringMesh);
      this.scene.remove(pedestal.glowLight);
      if (pedestal.pickupMesh) {
        this.scene.remove(pedestal.pickupMesh);
      }
    }
    this._pedestals.length = 0;
    this._held.clear();
  }
}
