/**
 * SampleEngineAudio — sample-based engine audio with 4-layer crossfade.
 *
 * Replaces the oscillator-based EngineAudio with realistic engine sounds
 * using pre-recorded samples from real cars. Each car gets 4 looping
 * AudioBufferSourceNodes (on_low, off_low, on_high, off_high) whose
 * gains are crossfaded based on RPM and throttle.
 *
 * Key design decisions:
 *  - All sources are created once and loop forever. Only gain/detune change per frame.
 *  - LOD system: full 4-layer for nearby, 2-layer for mid-range, culled for far.
 *  - Equal-power crossfade (cosine curves) for smooth, pop-free transitions.
 *  - Pitch via AudioBufferSourceNode.detune (hardware-accelerated in all browsers).
 *  - All smoothing uses delta-time for multiplayer/variable-framerate safety.
 *
 * Audio graph per car:
 *   [on_low  BufferSource] → [GainNode] ─┐
 *   [off_low BufferSource] → [GainNode] ──┤→ [CarGain] → [StereoPanner] → ENGINE bus
 *   [on_high BufferSource] → [GainNode] ──┤
 *   [off_high BufferSource]→ [GainNode] ──┘
 */

import { audioManager } from './AudioManager.js';
import { GearSimulator } from './GearSimulator.js';
import {
  AUDIO_BUS,
  ENGINE_SAMPLES,
  CAR_ENGINE_PROFILES,
  RPM_CROSSFADE_FRACTIONS,
  SPATIAL,
  PRIORITY,
} from './AudioConfig.js';

// ── Helpers ───────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Equal-power crossfade (from the engine-audio reference implementation).
 * Returns two gains that sum to 1.0 in power (not amplitude).
 *
 * @param {number} value - Current value (e.g., RPM or throttle)
 * @param {number} start - Value at which gain1=0, gain2=1
 * @param {number} end   - Value at which gain1=1, gain2=0
 * @returns {{ gain1: number, gain2: number }}
 */
function crossFade(value, start, end) {
  const x = clamp((value - start) / (end - start), 0, 1);
  return {
    gain1: Math.cos((1 - x) * 0.5 * Math.PI),  // fades IN as value increases
    gain2: Math.cos(x * 0.5 * Math.PI),          // fades OUT as value increases
  };
}

// Layer keys in the order we create them
const LAYER_KEYS = ['on_low', 'off_low', 'on_high', 'off_high'];

// LOD levels
const LOD_FULL = 0;    // 4 layers
const LOD_MEDIUM = 1;  // 2 layers (dominant throttle state only)
const LOD_CULLED = 2;  // all gains = 0

class SampleEngineAudioManager {
  constructor() {
    /** @type {Map<object, EngineVoice>} carBody → voice data */
    this._engines = new Map();
  }

  /**
   * Create engine audio for a car. Call after audioManager.init() and preloadAll().
   * @param {object} carBody - CarBody instance (needs .carType, .maxSpeed)
   * @param {boolean} isLocal - Whether this is the local player's car
   */
  addCar(carBody, isLocal = false) {
    if (!audioManager.isInitialized) return;
    if (this._engines.has(carBody)) return;

    const profile = CAR_ENGINE_PROFILES[carBody.carType];
    if (!profile) {
      console.warn(`SampleEngineAudio: no profile for car type "${carBody.carType}"`);
      return;
    }

    const sampleSet = ENGINE_SAMPLES[profile.sampleSet];
    if (!sampleSet) {
      console.warn(`SampleEngineAudio: no sample set "${profile.sampleSet}"`);
      return;
    }

    const ctx = audioManager.ctx;
    const engineBus = audioManager.getBus(AUDIO_BUS.ENGINE);
    if (!ctx || !engineBus) return;

    // ── Per-car gain (distance attenuation applied here) ──
    const carGain = ctx.createGain();
    carGain.gain.value = isLocal ? SPATIAL.localBoost : 0;

    // ── Stereo panner (left/right based on relative position) ──
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    // ── Optional post-processing filter (e.g., high-pass for GHOST) ──
    let lastNode = carGain;
    let postFilter = null;
    if (profile.postFilter) {
      postFilter = ctx.createBiquadFilter();
      postFilter.type = profile.postFilter;
      postFilter.frequency.value = profile.postFilterFreq || 400;
      postFilter.Q.value = 0.7;
      carGain.connect(postFilter);
      postFilter.connect(panner);
      lastNode = postFilter;
    } else {
      carGain.connect(panner);
    }
    panner.connect(engineBus);

    // ── Create 4 looping sample layers ──
    const layers = {};
    for (const key of LAYER_KEYS) {
      const sampleDef = sampleSet[key];
      if (!sampleDef) continue;

      const buffer = audioManager.getCachedSample(sampleDef.url);
      if (!buffer) {
        console.warn(`SampleEngineAudio: sample not loaded: ${sampleDef.url}`);
        continue;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gainNode = ctx.createGain();
      gainNode.gain.value = 0; // starts silent, crossfade will set values

      source.connect(gainNode);
      gainNode.connect(carGain);
      source.start();

      layers[key] = {
        source,
        gainNode,
        sampleRPM: sampleDef.rpm,
        sampleVolume: sampleDef.volume,
      };
    }

    // ── Bail out if no layers were created (samples not loaded yet) ──
    // This prevents adding an engine entry with empty layers, which would
    // block later re-add attempts via the dedup check.
    const layerCount = Object.keys(layers).length;
    if (layerCount === 0) {
      // Clean up the nodes we already created
      try { carGain.disconnect(); } catch (_) {}
      try { panner.disconnect(); } catch (_) {}
      if (postFilter) try { postFilter.disconnect(); } catch (_) {}
      return;
    }

    // ── Gear simulator (produces RPM and throttle from car speed) ──
    const gearSim = new GearSimulator(profile);

    // ── Register voice with AudioManager for priority tracking ──
    const voiceId = audioManager.registerVoice({
      priority: isLocal ? PRIORITY.LOCAL_ENGINE : PRIORITY.ENEMY_ENGINE_FAR,
      category: AUDIO_BUS.ENGINE,
      protected: isLocal,
      gainNode: carGain,
    });

    this._engines.set(carBody, {
      layers,
      carGain,
      panner,
      postFilter,
      gearSim,
      profile,
      isLocal,
      voiceId,
      currentLOD: isLocal ? LOD_FULL : LOD_CULLED,
    });
  }

  /**
   * Remove engine audio for a car (on death/removal).
   */
  removeCar(carBody) {
    const voice = this._engines.get(carBody);
    if (!voice) return;

    // Stop and disconnect all sources
    for (const key of LAYER_KEYS) {
      const layer = voice.layers[key];
      if (!layer) continue;
      try { layer.source.stop(); } catch (_) {}
      try { layer.source.disconnect(); } catch (_) {}
      try { layer.gainNode.disconnect(); } catch (_) {}
    }

    try { voice.carGain.disconnect(); } catch (_) {}
    try { voice.panner.disconnect(); } catch (_) {}
    if (voice.postFilter) {
      try { voice.postFilter.disconnect(); } catch (_) {}
    }

    audioManager.unregisterVoice(voice.voiceId);
    this._engines.delete(carBody);
  }

  /**
   * Update all engine sounds. Call every frame from the render loop.
   * @param {number} dt - Frame delta time (seconds)
   */
  update(dt) {
    if (!audioManager.isInitialized || dt <= 0) return;

    for (const [carBody, voice] of this._engines) {
      const { layers, carGain, panner, gearSim, profile, isLocal, voiceId } = voice;

      // ── 1. Calculate distance from CAMERA (listener) to car, and LOD ──
      // All cars use the same distance model. The listener is the camera,
      // so free-cam / spectator / zoom-out all affect audio correctly.
      const pos = carBody.body.position;
      const distance = audioManager.distanceToListener(pos.x, pos.z);

      let lod;
      if (isLocal) {
        // Local player always gets full LOD, but still respects distance
        lod = LOD_FULL;
      } else if (distance > SPATIAL.lodMedium) {
        lod = LOD_CULLED;
      } else if (distance > SPATIAL.lodFull) {
        lod = LOD_MEDIUM;
      } else {
        lod = LOD_FULL;
      }

      // Update voice priority based on distance
      if (!isLocal) {
        let priority = PRIORITY.ENEMY_ENGINE_FAR;
        if (distance < 15) priority = PRIORITY.ENEMY_ENGINE_NEAR;
        else if (distance < 30) priority = PRIORITY.ENEMY_ENGINE_MID;
        audioManager.updateVoice(voiceId, { priority, distance });
      }

      voice.currentLOD = lod;

      // ── 2. If culled, zero all gains and skip processing ──
      if (lod === LOD_CULLED) {
        for (const key of LAYER_KEYS) {
          if (layers[key]) layers[key].gainNode.gain.value = 0;
        }
        carGain.gain.value = 0;
        continue;
      }

      // ── 3. Update gear simulator (produces RPM and throttle) ──
      gearSim.update(carBody, dt);
      const rpm = gearSim.rpm;
      const throttle = gearSim.throttle;

      // ── 4. Calculate crossfade gains ──
      // RPM crossfade: blend between low and high samples.
      // Thresholds are per-profile fractions of the car's RPM range so cars
      // with low redlines (e.g. MAMMOTH=5000) still crossfade correctly.
      const rpmRange = profile.redlineRPM - profile.idleRPM;
      const rpmLow  = profile.idleRPM + RPM_CROSSFADE_FRACTIONS.lowFrac  * rpmRange;
      const rpmHigh = profile.idleRPM + RPM_CROSSFADE_FRACTIONS.highFrac * rpmRange;
      const { gain1: highGain, gain2: lowGain } = crossFade(rpm, rpmLow, rpmHigh);

      // Throttle crossfade: blend between on and off samples
      const { gain1: onGain, gain2: offGain } = crossFade(throttle, 0, 1);

      // ── 5. Apply gains based on LOD ──
      if (lod === LOD_FULL) {
        // Full 4-layer crossfade
        this._setLayerGain(layers.on_low,   onGain  * lowGain);
        this._setLayerGain(layers.off_low,  offGain * lowGain);
        this._setLayerGain(layers.on_high,  onGain  * highGain);
        this._setLayerGain(layers.off_high, offGain * highGain);
      } else {
        // LOD_MEDIUM: 2 layers only (dominant throttle + both RPM ranges)
        // Determine dominant throttle state
        if (throttle > 0.5) {
          // On-throttle dominant
          this._setLayerGain(layers.on_low,   lowGain);
          this._setLayerGain(layers.off_low,  0);
          this._setLayerGain(layers.on_high,  highGain);
          this._setLayerGain(layers.off_high, 0);
        } else {
          // Off-throttle dominant
          this._setLayerGain(layers.on_low,   0);
          this._setLayerGain(layers.off_low,  lowGain);
          this._setLayerGain(layers.on_high,  0);
          this._setLayerGain(layers.off_high, highGain);
        }
      }

      // ── 6. Apply pitch detuning (cents) ──
      // detune = (currentRPM - sampleRPM) * rpmPitchFactor
      const pitchFactor = profile.rpmPitchFactor;
      for (const key of LAYER_KEYS) {
        const layer = layers[key];
        if (!layer) continue;
        layer.source.detune.value = (rpm - layer.sampleRPM) * pitchFactor;
      }

      // ── 7. Apply distance attenuation to carGain ──
      // All cars (including local) use camera-based distance attenuation.
      // Local player gets a volume boost so their engine is always prominent.
      {
        const vol = audioManager.distanceGain(
          distance,
          SPATIAL.refDistance,
          SPATIAL.maxDistance,
        );
        const boost = isLocal ? SPATIAL.localBoost : 1.0;
        carGain.gain.value = Math.max(vol, isLocal ? 0.3 : 0) * boost;
      }

      // ── 8. Apply stereo panning (all cars, including local at distance) ──
      {
        const dx = pos.x - audioManager.listenerX;
        const dz = pos.z - audioManager.listenerZ;
        if (distance > 0.5) {
          const angle = Math.atan2(dx, dz);
          panner.pan.value = clamp(Math.sin(angle) * 0.8, -1, 1);
        } else {
          panner.pan.value = 0;
        }
      }
    }

    // Voice limit enforcement is available via audioManager.enforceVoiceLimits()
    // but disabled for now — with ~16 voices total (8 engines + geysers) we're
    // well under the 32-voice limit. Enabling per-frame culling risks zeroing
    // the local player's carGain for 1 frame before restore, causing audio dropouts.
    // Re-enable when multiplayer pushes voice count near the limit.
  }

  /**
   * Set a layer's gain, multiplied by its per-sample volume.
   * @param {object|undefined} layer
   * @param {number} gain - 0-1 crossfade gain
   */
  _setLayerGain(layer, gain) {
    if (!layer) return;
    layer.gainNode.gain.value = gain * layer.sampleVolume;
  }

  /**
   * Stop all engine sounds (round end, cleanup).
   */
  stopAll() {
    for (const carBody of [...this._engines.keys()]) {
      this.removeCar(carBody);
    }
  }

  /**
   * Reset a car's gear simulator (e.g., on respawn).
   */
  resetCar(carBody) {
    const voice = this._engines.get(carBody);
    if (voice) {
      voice.gearSim.reset();
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────
export const sampleEngineAudio = new SampleEngineAudioManager();
