import * as THREE from 'three';
import { CAR_FEEL } from '../core/Config.js';

/**
 * TireSmokeFX — Realistic tire smoke clouds during hard turns / drift.
 *
 * Design: Each particle is a large soft gaussian blob that GROWS over its
 * lifetime (smoke expands). High spawn rate + overlapping particles = dense
 * cloud trail. Spawns from EVERY rear wheel simultaneously.
 *
 * Performance:
 *   • Single shared Points geometry for ALL smoke across all cars
 *   • Fixed particle pool (zero allocations at runtime)
 *   • Per-particle size attribute (grows over life) via vertex shader
 *   • Particles hidden at y=-100 when inactive
 *   • needsUpdate only set when any particle is alive
 */

const SMOKE = {
  maxParticles: 300,          // large pool — smoke is dense
  spawnRate: 160,              // particles/sec per car at max intensity
  lifetime: 1.2,              // seconds — longer = longer trail
  lifetimeVariance: 0.4,
  // Size grows from start to end over lifetime
  sizeStart: 2.0,             // initial point size (world units)
  sizeEnd: 6.0,               // final point size — smoke expands!
  riseSpeed: 0.6,             // gentle upward drift (not a rocket)
  spreadSpeed: 0.4,           // gentle horizontal scatter
  // Opacity envelope
  peakOpacity: 0.5,           // max opacity at peak
  fadeInFrac: 0.08,           // fraction of life to reach peak
  // Thresholds
  minSteerRatio: 0.2,         // minimum steer fraction to emit
  minSpeedRatio: 0.25,        // minimum speed fraction to emit
  // Color
  color: 0xcccccc,            // light gray
};

const _wheelWorldPos = new THREE.Vector3();

export class TireSmokeFX {
  constructor(scene) {
    this.scene = scene;

    // Particle data pool
    this._data = [];
    const positions = new Float32Array(SMOKE.maxParticles * 3);
    const opacities = new Float32Array(SMOKE.maxParticles);
    const sizes = new Float32Array(SMOKE.maxParticles);

    for (let i = 0; i < SMOKE.maxParticles; i++) {
      positions[i * 3 + 1] = -100;
      opacities[i] = 0;
      sizes[i] = 0;
      this._data.push({
        active: false,
        x: 0, y: -100, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 0,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('opacity', new THREE.BufferAttribute(opacities, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Custom shader: per-particle opacity + per-particle size + gaussian blob
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(SMOKE.color) },
      },
      vertexShader: `
        attribute float opacity;
        attribute float size;
        varying float vOpacity;
        void main() {
          vOpacity = opacity;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (250.0 / -mvPos.z);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float vOpacity;
        void main() {
          // Gaussian blob — soft cloud shape, no hard edges
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float alpha = vOpacity * exp(-d * d * 3.0);
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this._points = new THREE.Points(geo, this._material);
    this._points.frustumCulled = false;
    this._points.renderOrder = 1; // render after cars
    this.scene.add(this._points);

    this._nextParticle = 0;
    this._hasActive = false;
  }

  /**
   * Call each frame after syncMesh + animateWheels.
   * @param {number} dt
   * @param {Array} carBodies
   */
  update(dt, carBodies) {
    // ── 1. Spawn new particles from turning cars ──
    for (const cb of carBodies) {
      const absSpeed = Math.abs(cb._currentSpeed);
      const effectiveMax = cb.maxSpeed * cb.speedMultiplier;
      const speedRatio = Math.min(absSpeed / Math.max(effectiveMax, 1), 1);

      // Compute steer intensity
      const handlingFactor = cb.handling / 3.5;
      let maxAngle = CAR_FEEL.maxSteerAngle * handlingFactor;
      if (cb.driftMode) maxAngle *= 1.5;
      const steerRatio = maxAngle > 0 ? Math.abs(cb._steerAngle) / maxAngle : 0;

      // Skip if below thresholds
      if (steerRatio < SMOKE.minSteerRatio || speedRatio < SMOKE.minSpeedRatio) continue;

      // Intensity: quadratic steer * linear speed, capped at 1
      const intensity = Math.min(1, steerRatio * steerRatio * speedRatio * 2.0);
      const driftBoost = cb.driftMode ? 1.6 : 1.0;
      const effectiveIntensity = Math.min(1, intensity * driftBoost);

      // How many particles this frame
      const rate = SMOKE.spawnRate * effectiveIntensity;
      const particlesThisFrame = rate * dt;
      let toSpawn = Math.floor(particlesThisFrame);
      if (Math.random() < (particlesThisFrame - toSpawn)) toSpawn++;
      if (toSpawn === 0) continue;

      // Get back wheels — spawn from ALL of them, not random
      const backWheels = cb.mesh?.userData?.backWheels;
      if (!backWheels || backWheels.length === 0) continue;

      // Distribute spawns evenly across all back wheels
      for (let s = 0; s < toSpawn; s++) {
        const wheel = backWheels[s % backWheels.length];
        wheel.getWorldPosition(_wheelWorldPos);

        const p = this._data[this._nextParticle];
        p.active = true;
        // Spawn at ground level near wheel with small jitter
        p.x = _wheelWorldPos.x + (Math.random() - 0.5) * 0.25;
        p.y = _wheelWorldPos.y - 0.1 + Math.random() * 0.15;
        p.z = _wheelWorldPos.z + (Math.random() - 0.5) * 0.25;
        // Gentle velocities — smoke drifts, doesn't fly
        p.vx = (Math.random() - 0.5) * SMOKE.spreadSpeed;
        p.vy = SMOKE.riseSpeed * (0.7 + Math.random() * 0.6);
        p.vz = (Math.random() - 0.5) * SMOKE.spreadSpeed;
        p.maxLife = SMOKE.lifetime + (Math.random() - 0.5) * SMOKE.lifetimeVariance;
        p.life = 0;

        this._nextParticle = (this._nextParticle + 1) % SMOKE.maxParticles;
      }
    }

    // ── 2. Update alive particles ──
    const posArr = this._points.geometry.attributes.position.array;
    const opaArr = this._points.geometry.attributes.opacity.array;
    const sizeArr = this._points.geometry.attributes.size.array;
    let anyActive = false;

    for (let i = 0; i < SMOKE.maxParticles; i++) {
      const p = this._data[i];
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        posArr[i * 3 + 1] = -100;
        opaArr[i] = 0;
        sizeArr[i] = 0;
        continue;
      }

      anyActive = true;
      const t = p.life / p.maxLife; // 0→1 normalized age

      // Move
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Dampen horizontal drift (smoke settles)
      p.vx *= 0.97;
      p.vz *= 0.97;

      // Size: grows from sizeStart to sizeEnd (smoke expands)
      const size = SMOKE.sizeStart + (SMOKE.sizeEnd - SMOKE.sizeStart) * t;

      // Opacity envelope: quick fade-in, long fade-out
      let opacity;
      if (t < SMOKE.fadeInFrac) {
        opacity = t / SMOKE.fadeInFrac;
      } else {
        // Smooth ease-out curve for natural dissipation
        const fadeT = (t - SMOKE.fadeInFrac) / (1 - SMOKE.fadeInFrac);
        opacity = 1.0 - fadeT * fadeT; // quadratic fade out
      }
      opacity *= SMOKE.peakOpacity;

      posArr[i * 3] = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;
      opaArr[i] = opacity;
      sizeArr[i] = size;
    }

    if (anyActive || this._hasActive) {
      this._points.geometry.attributes.position.needsUpdate = true;
      this._points.geometry.attributes.opacity.needsUpdate = true;
      this._points.geometry.attributes.size.needsUpdate = true;
    }
    this._hasActive = anyActive;
  }

  dispose() {
    this.scene.remove(this._points);
    this._points.geometry.dispose();
    this._material.dispose();
  }
}
