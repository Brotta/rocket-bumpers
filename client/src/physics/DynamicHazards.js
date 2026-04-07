import { ARENA } from '../core/Config.js';
import { GeyserAudio } from '../audio/GeyserAudio.js';

/**
 * DynamicHazards — manages lava eruptions, geysers, and lava pool damage.
 *
 * Eruption: periodic radial shockwave from center pushing all cars outward.
 * Geysers:  random spots on the arena that launch cars upward.
 * Lava:     central pool kills after sustained contact.
 *
 * Geyser visuals are delegated to ArenaBuilder (columns, cracks, rings, lights,
 * scorch marks) and GeyserFX (particles). Audio is handled by GeyserAudio.
 */
export class DynamicHazards {
  constructor(arena) {
    this._arena = arena; // ArenaBuilder (for visual hooks)
    this._callbacks = { kill: [], geyserErupt: [], eruptionBlast: [] };

    // ── Lava pool damage ──
    this._lavaTimers = new Map(); // CarBody → seconds in lava

    // ── Eruptions ──
    this._eruptionTimer = ARENA.eruption.interval * 0.5; // first eruption at half interval
    this._eruptionWarning = false;
    this._eruptionWarningTimer = 0;

    // ── Geysers ──
    this._geysers = [];
    for (let i = 0; i < ARENA.geysers.count; i++) {
      this._geysers.push({
        x: 0, z: 0,
        state: 'idle',     // 'idle' | 'warning' | 'active' | 'cooldown'
        timer: Math.random() * 3, // stagger initial spawns
        slotIndex: i,
      });
    }

    // ── Audio ──
    this._audio = new GeyserAudio();

    // ── Camera reference (for flash effect parenting) ──
    this._camera = null;
  }

  on(event, cb) {
    if (this._callbacks[event]) this._callbacks[event].push(cb);
  }

  /** Initialize audio — call after first user interaction (click/key) */
  initAudio() {
    this._audio.init();
  }

  /** Resume audio context (browser autoplay policy) */
  resumeAudio() {
    this._audio.resume();
  }

  reset() {
    this._lavaTimers.clear();
    this._eruptionTimer = ARENA.eruption.interval * 0.5;
    this._eruptionWarning = false;
    for (const g of this._geysers) {
      g.state = 'idle';
      g.timer = Math.random() * 3;
      this._arena.geyserSetIdle(g.slotIndex);
    }
    this._audio.stopAll();
  }

  update(dt, carBodies) {
    this._updateLava(dt, carBodies);
    this._updateEruptions(dt, carBodies);
    this._updateGeysers(dt, carBodies);

    // Update audio listener position to local player (first car body)
    if (carBodies.length > 0) {
      const pos = carBodies[0].body.position;
      this._audio.setListenerPosition(pos.x, pos.z);
    }
  }

  // ── Lava Pool ────────────────────────────────────────────────────────
  _updateLava(dt, carBodies) {
    const { radius, killTime } = ARENA.lava;

    for (const cb of carBodies) {
      const pos = cb.body.position;
      const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
      const inLava = dist < radius && pos.y < 1.5;

      if (inLava) {
        const timer = (this._lavaTimers.get(cb) || 0) + dt;
        this._lavaTimers.set(cb, timer);

        // Visual feedback
        const intensity = Math.min(timer / killTime, 1.0);
        this._setCarEmissive(cb, 0.15 + intensity * 1.5);

        if (timer >= killTime) {
          this._lavaTimers.delete(cb);
          this._setCarEmissive(cb, 0.15);
          for (const fn of this._callbacks.kill) fn(cb);
        }
      } else if (this._lavaTimers.has(cb)) {
        this._lavaTimers.delete(cb);
        this._setCarEmissive(cb, 0.15);
      }
    }
  }

  // ── Eruptions ────────────────────────────────────────────────────────
  _updateEruptions(dt, carBodies) {
    this._eruptionTimer -= dt;

    // Warning phase: trigger visual + audio warning
    if (this._eruptionTimer <= ARENA.eruption.warningTime && !this._eruptionWarning) {
      this._eruptionWarning = true;
      // Visual: pulsing lava glow + accelerated bubbles (handled by ArenaBuilder)
      this._arena.startEruptionWarning();
      // Audio: deep rumble building
      this._audio.playEruptionWarning();
    }

    if (this._eruptionTimer <= 0) {
      this._eruptionTimer = ARENA.eruption.interval;
      this._eruptionWarning = false;

      // Reset lava shader emissive boost to normal
      if (this._arena._lavaMaterial && this._arena._lavaMaterial.uniforms) {
        this._arena._lavaMaterial.uniforms.uEmissiveBoost.value = 0;
      }

      // Apply radial force to all cars
      const { force, radius: maxRadius } = ARENA.eruption;
      for (const cb of carBodies) {
        const pos = cb.body.position;
        const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
        if (dist > maxRadius || dist < 0.1) continue;

        const falloff = 1 - (dist / maxRadius);
        const pushForce = force * falloff;
        const angle = Math.atan2(pos.z, pos.x);

        cb.body.velocity.x += Math.cos(angle) * pushForce;
        cb.body.velocity.z += Math.sin(angle) * pushForce;
        cb.body.velocity.y += 3 * falloff;
      }

      // Visual: shockwave + surge particles + debris + flash
      // (camera reference passed via callback from Game.js)
      this._arena.showEruptionBlast(this._camera);

      // Audio: massive explosion
      this._audio.playEruptionBlast();

      // Notify listeners (Game.js uses this for camera shake)
      for (const fn of this._callbacks.eruptionBlast) fn();
    }
  }

  // ── Geysers ──────────────────────────────────────────────────────────
  _updateGeysers(dt, carBodies) {
    const radius = ARENA.diameter / 2;
    const { lifetime, cooldown, radius: geyserR, launchForce, warningTime } = ARENA.geysers;

    for (const g of this._geysers) {
      g.timer -= dt;

      switch (g.state) {
        case 'idle':
          if (g.timer <= 0) {
            // Pick random position on arena (avoid lava center and very edge)
            const a = Math.random() * Math.PI * 2;
            const d = ARENA.lava.radius + 5 + Math.random() * (radius * 0.7 - ARENA.lava.radius - 5);
            g.x = Math.cos(a) * d;
            g.z = Math.sin(a) * d;
            g.state = 'warning';
            g.timer = warningTime;

            // Visual: warning phase (cracks, steam, ring, light)
            this._arena.geyserStartWarning(g.slotIndex, g.x, g.z);
            // Audio: low rumble building
            this._audio.startWarning(g.slotIndex, g.x, g.z);
          }
          break;

        case 'warning':
          // Marker pulse (simple emissive animation on the base disk)
          const slot = this._arena._geyserSlots[g.slotIndex];
          if (slot) {
            slot.markerMat.emissiveIntensity = 1.0 + Math.sin(g.timer * 8) * 0.5;
          }

          if (g.timer <= 0) {
            g.state = 'active';
            g.timer = lifetime;

            // Visual: full eruption (columns, particles, splash, scorch, light)
            this._arena.geyserStartEruption(g.slotIndex, g.x, g.z);
            // Audio: explosion + sustained hiss
            this._audio.startEruption(g.slotIndex, g.x, g.z);
            // Notify listeners (Game.js uses this for camera shake)
            for (const fn of this._callbacks.geyserErupt) {
              fn({ x: g.x, z: g.z, slotIndex: g.slotIndex });
            }
          }
          break;

        case 'active':
          // Launch cars that touch the geyser
          for (const cb of carBodies) {
            const dx = cb.body.position.x - g.x;
            const dz = cb.body.position.z - g.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < geyserR && cb.body.position.y < 2) {
              // Dampen horizontal velocity so car doesn't fly off the map
              cb.body.velocity.x *= 0.3;
              cb.body.velocity.z *= 0.3;
              cb.body.velocity.y = launchForce;
              // Slight outward push
              if (dist > 0.1) {
                cb.body.velocity.x += (dx / dist) * 2;
                cb.body.velocity.z += (dz / dist) * 2;
              }
              // Set airborne state — no traction until landing
              if (!cb._geyserAirborne) {
                cb._geyserAirborne = true;
                cb._geyserAirborneTime = 0;
                // Random spin: 1.5–3 full rotations/sec, random direction
                cb._geyserSpinRate = (Math.random() > 0.5 ? 1 : -1)
                  * (Math.PI * 3 + Math.random() * Math.PI * 3);
              }
            }
          }

          if (g.timer <= 0) {
            g.state = 'cooldown';
            g.timer = cooldown;

            // Visual: column shrinks, scorch fades, residual steam
            this._arena.geyserStartCooldown(g.slotIndex);
            // Audio: sizzle decay
            this._audio.startCooldown(g.slotIndex, g.x, g.z);
          }
          break;

        case 'cooldown':
          if (g.timer <= 0) {
            g.state = 'idle';
            g.timer = 1 + Math.random() * 3; // random delay before next

            // Fully reset visuals
            this._arena.geyserSetIdle(g.slotIndex);
          }
          break;
      }
    }
  }

  _setCarEmissive(cb, intensity) {
    if (!cb.mesh) return;
    // Use cached emissive materials array (populated at car build time)
    const mats = cb.mesh.userData.emissiveMaterials;
    if (mats) {
      for (let i = 0; i < mats.length; i++) {
        mats[i].emissiveIntensity = intensity;
      }
    }
  }
}
