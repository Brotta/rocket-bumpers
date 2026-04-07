import * as THREE from 'three';
import { ARENA, THEME } from '../core/Config.js';

/**
 * GeyserFX — Optimized particle and visual effects for geysers.
 *
 * Performance strategy:
 *   • Shared materials (never cloned per slot)
 *   • Single InstancedMesh for ALL lava droplets across all geysers
 *   • Single shared splash ring (teleported between geysers on demand)
 *   • BufferGeometry.needsUpdate only when particles are actually moving
 *   • Idle slots are fully skipped (zero per-frame cost)
 */

const FX = ARENA.geysers.fx;
const TOTAL_DROPLETS = FX.droplets.countPerGeyser * ARENA.geysers.count;

// Reusable objects to avoid per-frame allocations
const _dummy = new THREE.Object3D();

export class GeyserFX {
  constructor(scene) {
    this.scene = scene;
    this._slots = [];
    this._elapsed = 0;

    // Shared materials (one instance, never cloned)
    this._steamMat = new THREE.PointsMaterial({
      color: 0xccbbaa,
      size: FX.steam.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._fountainMat = new THREE.PointsMaterial({
      color: THEME.lavaColor,
      size: FX.fountain.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // ── Global InstancedMesh for all droplets ──
    const dropletGeo = new THREE.SphereGeometry(FX.droplets.radius, 4, 3);
    const dropletMat = new THREE.MeshBasicMaterial({
      color: THEME.lavaColor,
    });
    this._dropletMesh = new THREE.InstancedMesh(dropletGeo, dropletMat, TOTAL_DROPLETS);
    this._dropletMesh.frustumCulled = true;
    // Hide all instances initially (move below ground)
    for (let i = 0; i < TOTAL_DROPLETS; i++) {
      _dummy.position.set(0, -100, 0);
      _dummy.updateMatrix();
      this._dropletMesh.setMatrixAt(i, _dummy.matrix);
    }
    this._dropletMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this._dropletMesh);
    this._dropletData = []; // flat array of all droplet state
    for (let i = 0; i < TOTAL_DROPLETS; i++) {
      this._dropletData.push({ vx: 0, vy: 0, vz: 0, x: 0, y: -100, z: 0, life: 0, active: false, rx: 0, rz: 0 });
    }
    this._dropletsDirty = false;

    // ── Single shared splash ring ──
    const splashGeo = new THREE.TorusGeometry(1, 0.15, 6, 16);
    splashGeo.rotateX(-Math.PI / 2);
    this._splashMat = new THREE.MeshBasicMaterial({
      color: THEME.lavaColor,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this._splashRing = new THREE.Mesh(splashGeo, this._splashMat);
    this._splashRing.visible = false;
    this.scene.add(this._splashRing);
    this._splashTimer = 0;
    this._splashActive = false;
  }

  // ── Create FX data for one geyser slot ────────────────────────────
  createSlot() {
    const slot = {};
    const slotIndex = this._slots.length;

    // ── Steam point cloud ──
    const steamCount = FX.steam.count;
    const steamPositions = new Float32Array(steamCount * 3);
    slot.steamData = [];
    for (let i = 0; i < steamCount; i++) {
      steamPositions[i * 3 + 1] = -100;
      slot.steamData.push({ vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0 });
    }
    const steamGeo = new THREE.BufferGeometry();
    steamGeo.setAttribute('position', new THREE.BufferAttribute(steamPositions, 3));
    slot.steamPoints = new THREE.Points(steamGeo, this._steamMat);
    // Keep frustumCulled false for point clouds — their particles scatter far
    // and Three.js auto-bounding would pop them in/out incorrectly.
    // The real perf win is MeshBasicMaterial on columns/droplets.
    slot.steamPoints.frustumCulled = false;
    slot.steamPoints.visible = false;
    this.scene.add(slot.steamPoints);

    // ── Lava fountain point cloud ──
    const fountainCount = FX.fountain.count;
    const fountainPositions = new Float32Array(fountainCount * 3);
    slot.fountainData = [];
    for (let i = 0; i < fountainCount; i++) {
      fountainPositions[i * 3 + 1] = -100;
      slot.fountainData.push({ vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, active: false });
    }
    const fountainGeo = new THREE.BufferGeometry();
    fountainGeo.setAttribute('position', new THREE.BufferAttribute(fountainPositions, 3));
    slot.fountainPoints = new THREE.Points(fountainGeo, this._fountainMat);
    slot.fountainPoints.frustumCulled = false;
    slot.fountainPoints.visible = false;
    this.scene.add(slot.fountainPoints);

    // ── Droplet index range (into global InstancedMesh) ──
    slot.dropletStart = slotIndex * FX.droplets.countPerGeyser;
    slot.dropletEnd = slot.dropletStart + FX.droplets.countPerGeyser;

    // ── State tracking ──
    slot.geyserX = 0;
    slot.geyserZ = 0;
    slot.phase = 'idle';
    slot.phaseTimer = 0;
    slot.steamActive = false;
    slot.fountainActive = false;

    this._slots.push(slot);
    return slotIndex;
  }

  // ── Trigger: warning ──────────────────────────────────────────────
  startWarning(slotIndex, x, z) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.geyserX = x;
    slot.geyserZ = z;
    slot.phase = 'warning';
    slot.phaseTimer = 0;
    slot.steamActive = true;
    slot.steamPoints.visible = true;
    this._resetSteamParticles(slot, x, z);
  }

  // ── Trigger: eruption ─────────────────────────────────────────────
  startEruption(slotIndex, x, z) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.geyserX = x;
    slot.geyserZ = z;
    slot.phase = 'active';
    slot.phaseTimer = 0;
    slot.fountainActive = true;
    slot.fountainPoints.visible = true;
    slot.steamActive = true;
    slot.steamPoints.visible = true;

    this._resetFountainParticles(slot, x, z);
    this._triggerSplash(x, z);
    this._launchDroplets(slot, x, z);
  }

  // ── Trigger: cooldown ─────────────────────────────────────────────
  startCooldown(slotIndex) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.phase = 'cooldown';
    slot.phaseTimer = 0;
    slot.fountainActive = false;
  }

  // ── Trigger: idle ─────────────────────────────────────────────────
  setIdle(slotIndex) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.phase = 'idle';
    slot.steamActive = false;
    slot.steamPoints.visible = false;
    slot.fountainActive = false;
    slot.fountainPoints.visible = false;
  }

  // ── Main update ───────────────────────────────────────────────────
  update(dt) {
    this._elapsed += dt;
    this._dropletsDirty = false;

    for (const slot of this._slots) {
      if (slot.phase === 'idle') continue;
      slot.phaseTimer += dt;

      this._updateSteam(slot, dt);
      this._updateFountain(slot, dt);
      this._updateDroplets(slot, dt);

      // Auto-hide steam after cooldown lingering
      if (slot.phase === 'cooldown' && slot.phaseTimer > FX.steam.lingerTime) {
        slot.steamActive = false;
      }
      if (!slot.steamActive && slot.phase === 'cooldown') {
        let anyVisible = false;
        for (const p of slot.steamData) {
          if (p.life > 0 && p.life < p.maxLife) { anyVisible = true; break; }
        }
        if (!anyVisible) slot.steamPoints.visible = false;
      }
    }

    // Single batch update for all droplet instances
    if (this._dropletsDirty) {
      this._dropletMesh.instanceMatrix.needsUpdate = true;
    }

    // Shared splash ring
    this._updateSplash(dt);
  }

  // ── Steam ─────────────────────────────────────────────────────────
  _resetSteamParticles(slot, x, z) {
    const pos = slot.steamPoints.geometry.attributes.position.array;
    for (let i = 0; i < slot.steamData.length; i++) {
      const p = slot.steamData[i];
      p.life = -Math.random() * FX.steam.spawnStagger;
      p.maxLife = FX.steam.lifetime + Math.random() * FX.steam.lifetimeVariance;
      p.vx = (Math.random() - 0.5) * FX.steam.driftSpeed;
      p.vy = FX.steam.riseSpeed + Math.random() * FX.steam.riseSpeedVariance;
      p.vz = (Math.random() - 0.5) * FX.steam.driftSpeed;
      const angle = Math.random() * Math.PI * 2;
      const spread = Math.random() * FX.steam.spawnRadius;
      pos[i * 3] = x + Math.cos(angle) * spread;
      pos[i * 3 + 1] = 0.1;
      pos[i * 3 + 2] = z + Math.sin(angle) * spread;
    }
    slot.steamPoints.geometry.attributes.position.needsUpdate = true;
  }

  _updateSteam(slot, dt) {
    if (!slot.steamPoints.visible) return;
    const pos = slot.steamPoints.geometry.attributes.position.array;
    const x = slot.geyserX, z = slot.geyserZ;
    const isActive = slot.phase === 'active';
    const speedMult = isActive ? FX.steam.activeSpeedMultiplier : 1.0;
    let anyMoved = false;

    for (let i = 0; i < slot.steamData.length; i++) {
      const p = slot.steamData[i];
      p.life += dt;
      if (p.life < 0) continue;

      if (p.life > p.maxLife) {
        if (slot.steamActive) {
          p.life = 0;
          p.maxLife = FX.steam.lifetime + Math.random() * FX.steam.lifetimeVariance;
          p.vx = (Math.random() - 0.5) * FX.steam.driftSpeed;
          p.vy = (FX.steam.riseSpeed + Math.random() * FX.steam.riseSpeedVariance) * speedMult;
          p.vz = (Math.random() - 0.5) * FX.steam.driftSpeed;
          const angle = Math.random() * Math.PI * 2;
          const spread = Math.random() * FX.steam.spawnRadius * (isActive ? 1.3 : 1.0);
          pos[i * 3] = x + Math.cos(angle) * spread;
          pos[i * 3 + 1] = 0.1;
          pos[i * 3 + 2] = z + Math.sin(angle) * spread;
          anyMoved = true;
        } else {
          pos[i * 3 + 1] = -100;
          anyMoved = true;
        }
        continue;
      }

      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt * speedMult;
      pos[i * 3 + 2] += p.vz * dt;
      p.vx += (Math.random() - 0.5) * 0.3 * dt;
      p.vz += (Math.random() - 0.5) * 0.3 * dt;
      anyMoved = true;
    }

    if (anyMoved) {
      slot.steamPoints.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ── Fountain ──────────────────────────────────────────────────────
  _resetFountainParticles(slot, x, z) {
    const pos = slot.fountainPoints.geometry.attributes.position.array;
    for (let i = 0; i < slot.fountainData.length; i++) {
      const p = slot.fountainData[i];
      p.active = true;
      p.life = -Math.random() * FX.fountain.spawnStagger;
      p.maxLife = FX.fountain.lifetime + Math.random() * FX.fountain.lifetimeVariance;
      const angle = Math.random() * Math.PI * 2;
      const spreadSpeed = Math.random() * FX.fountain.spreadSpeed;
      p.vx = Math.cos(angle) * spreadSpeed;
      p.vy = FX.fountain.launchSpeed + Math.random() * FX.fountain.launchSpeedVariance;
      p.vz = Math.sin(angle) * spreadSpeed;
      pos[i * 3] = x;
      pos[i * 3 + 1] = 0.2;
      pos[i * 3 + 2] = z;
    }
    slot.fountainPoints.geometry.attributes.position.needsUpdate = true;
  }

  _updateFountain(slot, dt) {
    if (!slot.fountainPoints.visible) return;
    const pos = slot.fountainPoints.geometry.attributes.position.array;
    const gravity = FX.fountain.gravity;
    const x = slot.geyserX, z = slot.geyserZ;
    let anyAlive = false;
    let anyMoved = false;

    for (let i = 0; i < slot.fountainData.length; i++) {
      const p = slot.fountainData[i];
      if (!p.active) continue;
      p.life += dt;
      if (p.life < 0) { anyAlive = true; continue; }

      if (p.life > p.maxLife || pos[i * 3 + 1] < -0.5) {
        if (slot.fountainActive) {
          p.life = 0;
          p.maxLife = FX.fountain.lifetime + Math.random() * FX.fountain.lifetimeVariance;
          const angle = Math.random() * Math.PI * 2;
          const spreadSpeed = Math.random() * FX.fountain.spreadSpeed;
          p.vx = Math.cos(angle) * spreadSpeed;
          p.vy = FX.fountain.launchSpeed + Math.random() * FX.fountain.launchSpeedVariance;
          p.vz = Math.sin(angle) * spreadSpeed;
          pos[i * 3] = x;
          pos[i * 3 + 1] = 0.2;
          pos[i * 3 + 2] = z;
          anyAlive = true;
          anyMoved = true;
        } else {
          p.active = false;
          pos[i * 3 + 1] = -100;
          anyMoved = true;
        }
        continue;
      }

      p.vy -= gravity * dt;
      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt;
      pos[i * 3 + 2] += p.vz * dt;
      anyAlive = true;
      anyMoved = true;
    }

    if (anyMoved) {
      slot.fountainPoints.geometry.attributes.position.needsUpdate = true;
    }
    if (!anyAlive && !slot.fountainActive) {
      slot.fountainPoints.visible = false;
    }
  }

  // ── Droplets (InstancedMesh) ──────────────────────────────────────
  _launchDroplets(slot, x, z) {
    for (let i = slot.dropletStart; i < slot.dropletEnd; i++) {
      const d = this._dropletData[i];
      d.active = true;
      d.life = 0;
      d.x = x;
      d.y = 0.5;
      d.z = z;
      const angle = Math.random() * Math.PI * 2;
      const speed = FX.droplets.launchSpeed + Math.random() * FX.droplets.launchSpeedVariance;
      d.vx = Math.cos(angle) * speed;
      d.vy = FX.droplets.launchUpSpeed + Math.random() * FX.droplets.launchUpVariance;
      d.vz = Math.sin(angle) * speed;
      d.rx = Math.random() * 3;
      d.rz = Math.random() * 2;
      const s = FX.droplets.scaleMin + Math.random() * (FX.droplets.scaleMax - FX.droplets.scaleMin);
      _dummy.position.set(d.x, d.y, d.z);
      _dummy.scale.setScalar(s);
      _dummy.rotation.set(0, 0, 0);
      _dummy.updateMatrix();
      this._dropletMesh.setMatrixAt(i, _dummy.matrix);
    }
    this._dropletsDirty = true;
  }

  _updateDroplets(slot, dt) {
    for (let i = slot.dropletStart; i < slot.dropletEnd; i++) {
      const d = this._dropletData[i];
      if (!d.active) continue;
      d.life += dt;

      if (d.life > FX.droplets.lifetime || d.y < -0.5) {
        d.active = false;
        d.y = -100;
        _dummy.position.set(0, -100, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        this._dropletMesh.setMatrixAt(i, _dummy.matrix);
        this._dropletsDirty = true;
        continue;
      }

      d.vy -= FX.droplets.gravity * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rx += 3 * dt;
      d.rz += 2 * dt;

      _dummy.position.set(d.x, d.y, d.z);
      _dummy.rotation.set(d.rx, 0, d.rz);
      _dummy.updateMatrix();
      this._dropletMesh.setMatrixAt(i, _dummy.matrix);
      this._dropletsDirty = true;
    }
  }

  // ── Splash (single shared ring) ───────────────────────────────────
  _triggerSplash(x, z) {
    this._splashRing.position.set(x, 0.15, z);
    this._splashRing.scale.set(0.3, 1, 0.3);
    this._splashMat.opacity = FX.splash.initialOpacity;
    this._splashRing.visible = true;
    this._splashActive = true;
    this._splashTimer = 0;
  }

  _updateSplash(dt) {
    if (!this._splashActive) return;
    this._splashTimer += dt;
    const t = this._splashTimer / FX.splash.duration;
    if (t >= 1) {
      this._splashRing.visible = false;
      this._splashActive = false;
      return;
    }
    const scale = FX.splash.startScale + t * (FX.splash.endScale - FX.splash.startScale);
    this._splashRing.scale.set(scale, 1, scale);
    this._splashMat.opacity = FX.splash.initialOpacity * (1 - t * t);
  }

  // ── Cleanup ───────────────────────────────────────────────────────
  dispose() {
    for (const slot of this._slots) {
      this.scene.remove(slot.steamPoints);
      slot.steamPoints.geometry.dispose();
      this.scene.remove(slot.fountainPoints);
      slot.fountainPoints.geometry.dispose();
    }
    this.scene.remove(this._dropletMesh);
    this._dropletMesh.geometry.dispose();
    this._dropletMesh.material.dispose();
    this.scene.remove(this._splashRing);
    this._splashRing.geometry.dispose();
    this._splashMat.dispose();
    this._steamMat.dispose();
    this._fountainMat.dispose();
  }
}
