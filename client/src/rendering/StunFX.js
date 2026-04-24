import * as THREE from 'three';
import { OBSTACLE_STUN } from '../core/Config.js';

/**
 * StunFX — manages visual effects for obstacle collisions:
 *  - Rock debris burst at impact point
 *  - Orbiting star/sparkle ring around stunned cars
 *  - Car mesh emissive flash on impact
 *  - Car wobble during stun
 *
 * Usage:
 *   const stunFX = new StunFX(scene);
 *   stunFX.onObstacleHit({ carBody, speed, stunDuration, hitX, hitY, hitZ, normalX, normalZ });
 *   stunFX.update(dt);  // call each frame
 */
export class StunFX {
  constructor(scene) {
    this._scene = scene;

    // ── Debris particle pool (InstancedMesh for performance) ──
    const debrisGeo = new THREE.IcosahedronGeometry(OBSTACLE_STUN.fx.debrisSize, 0);
    const debrisMat = new THREE.MeshBasicMaterial({
      color: OBSTACLE_STUN.fx.debrisColor,
    });
    this._debrisPoolSize = 40; // max simultaneous debris particles
    this._debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, this._debrisPoolSize);
    this._debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._debrisMesh.frustumCulled = true;
    this._scene.add(this._debrisMesh);

    // Debris state arrays
    this._debrisActive = new Array(this._debrisPoolSize).fill(false);
    this._debrisPos = [];
    this._debrisVel = [];
    this._debrisLife = [];
    this._debrisMaxLife = [];
    const _m = new THREE.Matrix4();
    for (let i = 0; i < this._debrisPoolSize; i++) {
      this._debrisPos.push(new THREE.Vector3());
      this._debrisVel.push(new THREE.Vector3());
      this._debrisLife.push(0);
      this._debrisMaxLife.push(0);
      // Hide all instances initially
      _m.makeScale(0, 0, 0);
      this._debrisMesh.setMatrixAt(i, _m);
    }
    this._debrisMesh.instanceMatrix.needsUpdate = true;
    this._debrisMatrix = new THREE.Matrix4();

    // ── Star/sparkle ring per stunned car ──
    // Each active stun gets a set of orbiting star sprites
    this._activeStuns = []; // { carBody, timer, duration, stars: THREE.Group }

    // Reused per-frame scratch array for _getStunnedCars() — avoids a fresh
    // allocation every frame inside the render loop.
    this._stunnedScratch = [];

    // Star geometry + material (shared)
    this._starGeo = new THREE.PlaneGeometry(
      OBSTACLE_STUN.fx.starSize,
      OBSTACLE_STUN.fx.starSize,
    );
    this._starMat = new THREE.MeshBasicMaterial({
      color: OBSTACLE_STUN.fx.starColor,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // ── Flash tracking ──
    this._flashes = []; // { carBody, timer, originalMats: Map<mat, originalEmissiveIntensity> }
  }

  /**
   * Called when a car hits an obstacle.
   */
  onObstacleHit({ carBody, speed, stunDuration, hitX, hitY, hitZ, normalX, normalZ }) {
    // 1. Spawn debris burst at impact point
    this._spawnDebris(hitX, hitY, hitZ, normalX, normalZ);

    // 2. Create orbiting stars around the car
    this._createStarRing(carBody, stunDuration);

    // 3. Flash the car mesh emissive
    this._flashCar(carBody);
  }

  // ── Debris burst ──────────────────────────────────────────────────────

  _spawnDebris(x, y, z, nx, nz) {
    const fx = OBSTACLE_STUN.fx;
    let spawned = 0;
    for (let i = 0; i < this._debrisPoolSize && spawned < fx.debrisCount; i++) {
      if (this._debrisActive[i]) continue;
      this._debrisActive[i] = true;
      spawned++;

      this._debrisPos[i].set(x, y, z);

      // Velocity: outward from impact normal + random spread + upward
      const spread = (Math.random() - 0.5) * 2;
      const spreadPerp = (Math.random() - 0.5) * 2;
      this._debrisVel[i].set(
        nx * fx.debrisSpeed * (0.5 + Math.random()) + spreadPerp * fx.debrisSpeed * 0.5,
        fx.debrisSpeed * (0.3 + Math.random() * 0.7),
        nz * fx.debrisSpeed * (0.5 + Math.random()) + spread * fx.debrisSpeed * 0.5,
      );

      this._debrisLife[i] = fx.debrisLifetime;
      this._debrisMaxLife[i] = fx.debrisLifetime;
    }
  }

  // ── Star ring ─────────────────────────────────────────────────────────

  _createStarRing(carBody, duration) {
    // Remove existing star ring for this car if any
    this._removeStarRing(carBody);

    const fx = OBSTACLE_STUN.fx;
    const group = new THREE.Group();

    for (let i = 0; i < fx.starCount; i++) {
      const star = new THREE.Mesh(this._starGeo, this._starMat);
      // Distribute evenly around the ring
      const angle = (i / fx.starCount) * Math.PI * 2;
      star.userData.baseAngle = angle;
      group.add(star);
    }

    // Position group at car height (will follow car each frame)
    this._scene.add(group);

    this._activeStuns.push({
      carBody,
      timer: 0,
      duration,
      stars: group,
    });
  }

  _removeStarRing(carBody) {
    for (let i = this._activeStuns.length - 1; i >= 0; i--) {
      if (this._activeStuns[i].carBody === carBody) {
        this._scene.remove(this._activeStuns[i].stars);
        this._activeStuns[i].stars.traverse((child) => {
          if (child.geometry && child.geometry !== this._starGeo) child.geometry.dispose();
        });
        this._activeStuns.splice(i, 1);
      }
    }
  }

  // ── Car flash ─────────────────────────────────────────────────────────

  _flashCar(carBody) {
    if (!carBody.mesh) return;
    const mats = carBody.mesh.userData.emissiveMaterials;
    if (!mats || mats.length === 0) return;

    const originals = new Map();
    for (const mat of mats) {
      originals.set(mat, {
        intensity: mat.emissiveIntensity,
        color: mat.emissive.getHex(),
      });
      mat.emissiveIntensity = OBSTACLE_STUN.fx.flashIntensity;
      mat.emissive.setHex(OBSTACLE_STUN.fx.flashColor);
    }

    this._flashes.push({
      carBody,
      timer: OBSTACLE_STUN.fx.flashDuration,
      originalMats: originals,
    });
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(dt) {
    this._updateDebris(dt);
    this._updateStars(dt);
    this._updateFlashes(dt);
    this._updateWobble(dt);
  }

  _updateDebris(dt) {
    const gravity = 12;
    let needsUpdate = false;

    for (let i = 0; i < this._debrisPoolSize; i++) {
      if (!this._debrisActive[i]) continue;
      needsUpdate = true;

      this._debrisLife[i] -= dt;
      if (this._debrisLife[i] <= 0) {
        this._debrisActive[i] = false;
        this._debrisMatrix.makeScale(0, 0, 0);
        this._debrisMesh.setMatrixAt(i, this._debrisMatrix);
        continue;
      }

      // Physics
      this._debrisVel[i].y -= gravity * dt;
      this._debrisPos[i].addScaledVector(this._debrisVel[i], dt);

      // Scale fades out (deterministic — no per-frame Math.random())
      const lifeRatio = this._debrisLife[i] / this._debrisMaxLife[i];
      const scale = lifeRatio;

      this._debrisMatrix.makeScale(scale, scale, scale);
      this._debrisMatrix.setPosition(this._debrisPos[i]);
      this._debrisMesh.setMatrixAt(i, this._debrisMatrix);
    }

    if (needsUpdate) {
      this._debrisMesh.instanceMatrix.needsUpdate = true;
    }
  }

  _updateStars(dt) {
    const fx = OBSTACLE_STUN.fx;

    for (let i = this._activeStuns.length - 1; i >= 0; i--) {
      const stun = this._activeStuns[i];
      stun.timer += dt;

      // Remove if stun ended
      if (!stun.carBody._isStunned) {
        this._scene.remove(stun.stars);
        this._activeStuns.splice(i, 1);
        continue;
      }

      // Position stars group at car
      const carPos = stun.carBody.mesh.position;
      stun.stars.position.set(carPos.x, carPos.y + 1.5, carPos.z);

      // Fade out in last 20% of stun
      const fadeT = stun.timer / stun.duration;
      const alpha = fadeT > 0.8 ? (1 - fadeT) / 0.2 : 1.0;

      // Orbit each star
      for (const star of stun.stars.children) {
        const angle = star.userData.baseAngle + stun.timer * fx.starOrbitSpeed;
        star.position.set(
          Math.cos(angle) * fx.starOrbitRadius,
          Math.sin(stun.timer * 3) * 0.2, // slight vertical bob
          Math.sin(angle) * fx.starOrbitRadius,
        );
        // Always face camera (billboard) — approximated by rotating Y
        star.rotation.y = -angle;
        star.material.opacity = 0.9 * alpha;
      }
    }
  }

  _updateFlashes(dt) {
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const flash = this._flashes[i];
      flash.timer -= dt;

      if (flash.timer <= 0) {
        // Restore original emissive color AND intensity
        for (const [mat, orig] of flash.originalMats) {
          mat.emissiveIntensity = orig.intensity;
          mat.emissive.setHex(orig.color);
        }
        this._flashes.splice(i, 1);
      }
    }
  }

  _updateWobble(dt) {
    const { wobbleFreq, wobbleAmplitude } = OBSTACLE_STUN;

    for (const cb of this._getStunnedCars()) {
      // Apply sinusoidal roll wobble to the car's body parts
      const bodyParts = cb.mesh.userData.bodyParts;
      if (!bodyParts || bodyParts.length === 0) continue;

      const elapsed = cb._stunTimer; // counts down
      const wobble = Math.sin(elapsed * wobbleFreq * Math.PI * 2) * wobbleAmplitude;

      for (const part of bodyParts) {
        part.rotation.z = wobble;
      }
    }
  }

  /** Helper: returns all currently stunned CarBody references from active stuns.
   *  Returns a reused scratch array — do not retain the reference. */
  _getStunnedCars() {
    const cars = this._stunnedScratch;
    cars.length = 0;
    for (const stun of this._activeStuns) {
      if (stun.carBody._isStunned) cars.push(stun.carBody);
    }
    return cars;
  }

  dispose() {
    this._scene.remove(this._debrisMesh);
    this._debrisMesh.geometry.dispose();
    this._debrisMesh.material.dispose();
    for (const stun of this._activeStuns) {
      this._scene.remove(stun.stars);
    }
    this._activeStuns.length = 0;
    this._starGeo.dispose();
    this._starMat.dispose();
  }
}
