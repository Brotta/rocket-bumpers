/**
 * SFXPlayer — pool-based one-shot sound effect player.
 *
 * Plays short, non-looping sounds (collisions, power-ups, abilities, UI)
 * through the SFX bus with optional spatial positioning.
 *
 * Design:
 *  - All samples are pre-decoded at load time via audioManager.loadSample()
 *  - Each play() call creates a new AudioBufferSourceNode (cheap, auto-GC'd)
 *  - Priority system: if at max active SFX, lowest priority gets dropped
 *  - Spatial: optional distance attenuation + stereo panning
 *  - All time values use seconds (delta-time safe for multiplayer)
 *
 * Usage:
 *   await sfxPlayer.register('hit_light', 'assets/audio/sfx/hit_light.ogg');
 *   sfxPlayer.play('hit_light', { priority: 6, x: 10, z: 5 });
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS, SPATIAL, PRIORITY } from './AudioConfig.js';

const MAX_ACTIVE_SFX = 16; // max simultaneous one-shot sounds

class SFXPlayerSingleton {
  constructor() {
    /** @type {Map<string, AudioBuffer>} name → decoded buffer */
    this._samples = new Map();

    /** @type {Array<ActiveSFX>} currently playing sounds */
    this._active = [];
  }

  /**
   * Register (pre-load) a sound effect by name.
   * @param {string} name - Unique identifier for this SFX
   * @param {string} url - Path to the audio file
   */
  async register(name, url) {
    if (this._samples.has(name)) return;
    if (!audioManager.isInitialized) return;

    try {
      const buffer = await audioManager.loadSample(url);
      this._samples.set(name, buffer);
    } catch (e) {
      console.warn(`SFXPlayer: failed to load "${name}" from ${url}`, e);
    }
  }

  /**
   * Register multiple SFX at once.
   * @param {Array<{name: string, url: string}>} entries
   */
  async registerAll(entries) {
    await Promise.allSettled(
      entries.map(({ name, url }) => this.register(name, url)),
    );
  }

  /**
   * Play a one-shot sound effect.
   *
   * @param {string} name - Registered SFX name
   * @param {object} [opts]
   * @param {number} [opts.priority=5] - Voice priority (higher = more important)
   * @param {number} [opts.volume=1.0] - Gain multiplier (0-1)
   * @param {number} [opts.x] - World X position (for spatial, omit for non-spatial)
   * @param {number} [opts.z] - World Z position (for spatial, omit for non-spatial)
   * @param {number} [opts.playbackRate=1.0] - Pitch/speed (1.0 = normal)
   */
  play(name, opts = {}) {
    if (!audioManager.isInitialized) return;

    const buffer = this._samples.get(name);
    if (!buffer) return;

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    const {
      priority = 5,
      volume = 1.0,
      x, z,
      playbackRate = 1.0,
    } = opts;

    // Purge finished sounds
    this._cleanup();

    // Enforce max concurrent SFX
    if (this._active.length >= MAX_ACTIVE_SFX) {
      // Find lowest priority active sound
      let lowestIdx = 0;
      let lowestPri = this._active[0].priority;
      for (let i = 1; i < this._active.length; i++) {
        if (this._active[i].priority < lowestPri) {
          lowestPri = this._active[i].priority;
          lowestIdx = i;
        }
      }
      // Only replace if our priority is higher
      if (priority <= lowestPri) return; // drop this sound instead
      // Stop the lowest priority sound
      const evicted = this._active[lowestIdx];
      try { evicted.source.stop(); } catch (_) {}
      this._active.splice(lowestIdx, 1);
    }

    // Calculate spatial gain and pan
    let spatialGain = 1.0;
    let pan = 0;
    const isSpatial = x !== undefined && z !== undefined;
    if (isSpatial) {
      const dist = audioManager.distanceToListener(x, z);
      spatialGain = audioManager.distanceGain(dist, SPATIAL.refDistance, SPATIAL.maxDistance);
      if (spatialGain < 0.01) return; // too far, don't bother

      // Simple L/R panning
      const dx = x - audioManager.listenerX;
      const dz = z - audioManager.listenerZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.5) {
        pan = Math.max(-1, Math.min(1, Math.sin(Math.atan2(dx, dz)) * 0.8));
      }
    }

    // Build audio graph: source → gain → [panner] → SFX bus
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;

    const gainNode = ctx.createGain();
    gainNode.gain.value = volume * spatialGain;

    let lastNode = gainNode;

    if (isSpatial && Math.abs(pan) > 0.01) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gainNode.connect(panner);
      panner.connect(sfxBus);
      lastNode = panner;
    } else {
      gainNode.connect(sfxBus);
    }

    source.start();

    // Track for cleanup
    const entry = {
      source,
      gainNode,
      priority,
      startTime: ctx.currentTime,
      duration: buffer.duration / playbackRate,
      ended: false,
    };

    source.onended = () => { entry.ended = true; };
    this._active.push(entry);
  }

  /**
   * Remove entries for sounds that have finished playing.
   */
  _cleanup() {
    for (let i = this._active.length - 1; i >= 0; i--) {
      if (this._active[i].ended) {
        try { this._active[i].gainNode.disconnect(); } catch (_) {}
        this._active.splice(i, 1);
      }
    }
  }

  /**
   * Stop all active SFX.
   */
  stopAll() {
    for (const entry of this._active) {
      try { entry.source.stop(); } catch (_) {}
      try { entry.gainNode.disconnect(); } catch (_) {}
    }
    this._active.length = 0;
  }
}

export const sfxPlayer = new SFXPlayerSingleton();
