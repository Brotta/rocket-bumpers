import * as THREE from 'three';
import { COLLISION_IMPACT } from '../core/Config.js';

/**
 * CollisionImpactFX — visual effects for car-to-car collisions:
 *  - Spark particle burst at impact point (InstancedMesh pool)
 *  - Car mesh emissive flash
 *  - Full-screen flash overlay (DOM)
 *  - Shockwave ring (devastating hits only)
 *
 * All effects scale with hit tier: light / heavy / devastating.
 * Works identically in singleplayer and multiplayer.
 */
export class CollisionImpactFX {
  constructor(scene) {
    this._scene = scene;

    // ── Spark particle pool (InstancedMesh) ──
    const sparkGeo = new THREE.SphereGeometry(1, 4, 3);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc44 });
    this._sparkPoolSize = 60;
    this._sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, this._sparkPoolSize);
    this._sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this._sparkMesh.instanceColor) {
      this._sparkMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this._sparkMesh.frustumCulled = false;
    this._scene.add(this._sparkMesh);

    this._sparks = [];
    for (let i = 0; i < this._sparkPoolSize; i++) {
      this._sparks.push({
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 0, size: 0,
      });
    }
    // Hide all initially
    const _m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this._sparkPoolSize; i++) {
      this._sparkMesh.setMatrixAt(i, _m);
    }
    this._sparkMesh.instanceMatrix.needsUpdate = true;
    this._sparkMatrix = new THREE.Matrix4();
    this._sparkColor = new THREE.Color();
    this._sparkFadeTargetColor = new THREE.Color(0x331100);

    // ── Emissive flash tracking ──
    this._flashingCars = []; // { car, timer, duration, origEmissives[] }

    // ── Screen flash overlay (DOM-based for performance) ──
    this._flashOverlay = document.createElement('div');
    this._flashOverlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 50; opacity: 0;
      transition: none;
    `;
    document.body.appendChild(this._flashOverlay);
    this._flashTimer = 0;
    this._flashDuration = 0;

    // ── Damage vignette overlay (red border pulse when hit) ──
    this._vignetteOverlay = document.createElement('div');
    this._vignetteOverlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 49; opacity: 0;
      background: radial-gradient(ellipse at center, transparent 50%, rgba(255,30,0,0.7) 100%);
    `;
    document.body.appendChild(this._vignetteOverlay);
    this._vignetteTimer = 0;
    this._vignetteDuration = 0;
    this._vignetteAlpha = 0;

    // ── Shockwave ring pool ──
    this._shockwaves = [];

    // Reusable temp
    this._tmpVec = new THREE.Vector3();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC: trigger impact at collision point
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @param {object} opts
   * @param {string} opts.tier — 'light' | 'heavy' | 'devastating'
   * @param {number} opts.x, opts.y, opts.z — world-space impact point
   * @param {number} opts.nx, opts.nz — impact normal (from victim toward attacker)
   * @param {object} opts.victim — CarBody that received damage
   * @param {boolean} opts.isLocalPlayer — true if victim or attacker is the local player
   */
  trigger({ tier, x, y, z, nx, nz, victim, isLocalPlayer }) {
    const cfg = COLLISION_IMPACT;

    // ── 1. Spark burst ──
    this._spawnSparks(tier, x, y, z, nx, nz);

    // ── 2. Emissive flash on victim car ──
    if (victim?.mesh) {
      this._startEmissiveFlash(victim, tier);
    }

    // ── 3. Screen flash (only for local player involvement) ──
    if (isLocalPlayer) {
      const fc = cfg.flash[tier];
      this._triggerScreenFlash(fc.color, fc.alpha, fc.duration);
    }

    // ── 4. Shockwave ring (devastating only) ──
    if (tier === 'devastating') {
      this._spawnShockwave(x, y, z);
    }
  }

  /**
   * Trigger emissive flash on a car from an external caller (e.g., missile hit).
   * @param {object} car — CarBody
   * @param {number} intensity — emissive intensity
   * @param {number} duration — seconds
   */
  triggerEmissiveFlash(car, intensity, duration) {
    if (!car?.mesh) return;
    const originals = [];
    car.mesh.traverse((child) => {
      if (child.isMesh && child.material && child.material.emissive) {
        originals.push({
          mesh: child,
          emissive: child.material.emissive.clone(),
          intensity: child.material.emissiveIntensity,
        });
        child.material.emissive.setHex(0xffffff);
        child.material.emissiveIntensity = intensity;
      }
    });
    this._flashingCars.push({ car, timer: 0, duration, originals });
  }

  /**
   * Trigger screen flash from external caller.
   */
  triggerScreenFlash(color, alpha, duration) {
    this._triggerScreenFlash(color, alpha, duration);
  }

  /**
   * Trigger damage vignette (red border pulse when taking a hit).
   * @param {number} alpha — peak opacity (0-1)
   * @param {number} duration — seconds to fade
   */
  triggerVignette(alpha, duration) {
    this._vignetteAlpha = alpha;
    this._vignetteTimer = 0;
    this._vignetteDuration = duration;
    this._vignetteOverlay.style.opacity = String(alpha);
  }

  /**
   * Spawn a shockwave ring at position from external caller.
   */
  triggerShockwave(x, y, z, cfg) {
    const geo = new THREE.RingGeometry(cfg.startRadius, cfg.startRadius + 0.3, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: cfg.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(x, y + 0.3, z);
    ring.rotation.x = -Math.PI / 2;
    this._scene.add(ring);

    this._shockwaves.push({
      ring, mat, timer: 0,
      duration: cfg.duration,
      startR: cfg.startRadius,
      endR: cfg.endRadius,
      startOpacity: cfg.opacity,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UPDATE (call every frame)
  // ═══════════════════════════════════════════════════════════════════════

  update(dt) {
    this._updateSparks(dt);
    this._updateEmissiveFlashes(dt);
    this._updateScreenFlash(dt);
    this._updateShockwaves(dt);
    this._updateVignette(dt);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPARK PARTICLES
  // ═══════════════════════════════════════════════════════════════════════

  _spawnSparks(tier, x, y, z, nx, nz) {
    const cfg = COLLISION_IMPACT.sparks[tier];
    const color = new THREE.Color(cfg.color);

    for (let i = 0; i < cfg.count; i++) {
      const slot = this._sparks.find(s => !s.active);
      if (!slot) break;

      // Random direction biased along the impact normal
      const spread = 0.8;
      const vx = nx * cfg.speed * (0.5 + Math.random() * 0.5)
        + (Math.random() - 0.5) * cfg.speed * spread;
      const vy = cfg.speed * (0.3 + Math.random() * 0.5);
      const vz = nz * cfg.speed * (0.5 + Math.random() * 0.5)
        + (Math.random() - 0.5) * cfg.speed * spread;

      slot.active = true;
      slot.x = x + (Math.random() - 0.5) * 0.5;
      slot.y = y + (Math.random() - 0.5) * 0.3;
      slot.z = z + (Math.random() - 0.5) * 0.5;
      slot.vx = vx;
      slot.vy = vy;
      slot.vz = vz;
      slot.life = 0;
      slot.maxLife = cfg.lifetime * (0.7 + Math.random() * 0.6);
      slot.size = cfg.size * (0.8 + Math.random() * 0.4);
      slot.color = color;
    }
  }

  _updateSparks(dt) {
    let needsUpdate = false;
    const gravity = -15;

    for (let i = 0; i < this._sparkPoolSize; i++) {
      const s = this._sparks[i];
      if (!s.active) continue;

      s.life += dt;
      if (s.life >= s.maxLife) {
        s.active = false;
        this._sparkMatrix.makeScale(0, 0, 0);
        this._sparkMesh.setMatrixAt(i, this._sparkMatrix);
        needsUpdate = true;
        continue;
      }

      // Physics
      s.vy += gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;

      // Shrink over lifetime
      const t = s.life / s.maxLife;
      const scale = s.size * (1 - t * t);

      this._sparkMatrix.makeScale(scale, scale, scale);
      this._sparkMatrix.setPosition(s.x, s.y, s.z);
      this._sparkMesh.setMatrixAt(i, this._sparkMatrix);

      // Color: fade from bright to dark orange
      if (s.color) {
        this._sparkColor.copy(s.color).lerp(this._sparkFadeTargetColor, t);
        this._sparkMesh.setColorAt(i, this._sparkColor);
      }

      needsUpdate = true;
    }

    if (needsUpdate) {
      this._sparkMesh.instanceMatrix.needsUpdate = true;
      if (this._sparkMesh.instanceColor) {
        this._sparkMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EMISSIVE FLASH
  // ═══════════════════════════════════════════════════════════════════════

  _startEmissiveFlash(car, tier) {
    const cfg = COLLISION_IMPACT.emissiveFlash[tier];

    // Collect original emissive values
    const originals = [];
    car.mesh.traverse((child) => {
      if (child.isMesh && child.material && child.material.emissive) {
        originals.push({
          mesh: child,
          emissive: child.material.emissive.clone(),
          intensity: child.material.emissiveIntensity,
        });
        // Flash to white
        child.material.emissive.setHex(0xffffff);
        child.material.emissiveIntensity = cfg.intensity;
      }
    });

    this._flashingCars.push({
      car, timer: 0, duration: cfg.duration, originals,
    });
  }

  _updateEmissiveFlashes(dt) {
    for (let i = this._flashingCars.length - 1; i >= 0; i--) {
      const entry = this._flashingCars[i];
      entry.timer += dt;

      const t = Math.min(1, entry.timer / entry.duration);

      // Ease out intensity
      for (const orig of entry.originals) {
        const eased = 1 - t * t;
        orig.mesh.material.emissiveIntensity =
          orig.intensity + (COLLISION_IMPACT.emissiveFlash.devastating.intensity - orig.intensity) * eased * (1 - t);

        if (t >= 1) {
          // Restore
          orig.mesh.material.emissive.copy(orig.emissive);
          orig.mesh.material.emissiveIntensity = orig.intensity;
        }
      }

      if (t >= 1) {
        this._flashingCars.splice(i, 1);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCREEN FLASH
  // ═══════════════════════════════════════════════════════════════════════

  _triggerScreenFlash(color, alpha, duration) {
    const hex = '#' + new THREE.Color(color).getHexString();
    this._flashOverlay.style.backgroundColor = hex;
    this._flashOverlay.style.opacity = String(alpha);
    this._flashTimer = 0;
    this._flashDuration = duration;
  }

  _updateScreenFlash(dt) {
    if (this._flashDuration <= 0) return;

    this._flashTimer += dt;
    const t = Math.min(1, this._flashTimer / this._flashDuration);

    // Ease out opacity
    const opacity = parseFloat(this._flashOverlay.style.opacity) || 0;
    this._flashOverlay.style.opacity = String(opacity * (1 - t * t));

    if (t >= 1) {
      this._flashOverlay.style.opacity = '0';
      this._flashDuration = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SHOCKWAVE RING (devastating only)
  // ═══════════════════════════════════════════════════════════════════════

  _spawnShockwave(x, y, z) {
    const cfg = COLLISION_IMPACT.shockwave;
    const geo = new THREE.RingGeometry(cfg.startRadius, cfg.startRadius + 0.3, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: cfg.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(x, y + 0.3, z);
    ring.rotation.x = -Math.PI / 2;
    this._scene.add(ring);

    this._shockwaves.push({
      ring, mat, timer: 0,
      duration: cfg.duration,
      startR: cfg.startRadius,
      endR: cfg.endRadius,
      startOpacity: cfg.opacity,
    });
  }

  _updateShockwaves(dt) {
    for (let i = this._shockwaves.length - 1; i >= 0; i--) {
      const sw = this._shockwaves[i];
      sw.timer += dt;
      const t = Math.min(1, sw.timer / sw.duration);

      // Expand ring
      const radius = sw.startR + (sw.endR - sw.startR) * t;
      const scale = radius / sw.startR;
      sw.ring.scale.setScalar(scale);

      // Fade out
      sw.mat.opacity = sw.startOpacity * (1 - t);

      if (t >= 1) {
        this._scene.remove(sw.ring);
        sw.mat.dispose();
        sw.ring.geometry.dispose();
        this._shockwaves.splice(i, 1);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DAMAGE VIGNETTE
  // ═══════════════════════════════════════════════════════════════════════

  _updateVignette(dt) {
    if (this._vignetteDuration <= 0) return;

    this._vignetteTimer += dt;
    const t = Math.min(1, this._vignetteTimer / this._vignetteDuration);

    // Quick ramp up (first 10%), then smooth fade out
    let opacity;
    if (t < 0.1) {
      opacity = this._vignetteAlpha * (t / 0.1);
    } else {
      const fadeT = (t - 0.1) / 0.9;
      opacity = this._vignetteAlpha * (1 - fadeT * fadeT);
    }

    this._vignetteOverlay.style.opacity = String(Math.max(0, opacity));

    if (t >= 1) {
      this._vignetteOverlay.style.opacity = '0';
      this._vignetteDuration = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  dispose() {
    this._scene.remove(this._sparkMesh);
    this._sparkMesh.geometry.dispose();
    this._sparkMesh.material.dispose();
    for (const sw of this._shockwaves) {
      this._scene.remove(sw.ring);
      sw.mat.dispose();
      sw.ring.geometry.dispose();
    }
    if (this._flashOverlay.parentNode) {
      this._flashOverlay.parentNode.removeChild(this._flashOverlay);
    }
    if (this._vignetteOverlay.parentNode) {
      this._vignetteOverlay.parentNode.removeChild(this._vignetteOverlay);
    }
  }
}
