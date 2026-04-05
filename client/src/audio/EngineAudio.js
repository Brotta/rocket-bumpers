/**
 * EngineAudio — Procedural engine sounds for each car using Web Audio API.
 *
 * Each car gets a layered oscillator stack (harmonics) + filtered noise (mechanical rumble).
 * Pitch (frequency) maps to current speed. Volume attenuates with distance for non-local cars.
 *
 * Architecture:
 *   Per car: [Oscillator1] → [Gain1] ─┐
 *            [Oscillator2] → [Gain2] ──┤→ [CarGain] → [Master]
 *            [NoiseSource] → [LPF] → [NoiseGain] ─┘
 *
 * The master gain node is shared and used for global mute control.
 */

import { ENGINE_AUDIO } from '../core/Config.js';

class EngineAudioManager {
  constructor() {
    this._ctx = null;
    this._master = null;
    this._engines = new Map(); // CarBody → engine node group
    this._initialized = false;
    this._listenerPos = { x: 0, z: 0 };
    this._muted = false;
  }

  /**
   * Initialize AudioContext. Must be called from a user gesture.
   */
  init() {
    if (this._initialized) return;
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = ENGINE_AUDIO.masterVolume;
      this._master.connect(this._ctx.destination);
      this._initialized = true;
    } catch (e) {
      console.warn('EngineAudio: Web Audio not available', e);
    }
  }

  /**
   * Create engine sound nodes for a car.
   * @param {object} carBody - CarBody instance (needs .carType, .maxSpeed)
   * @param {boolean} isLocal - Whether this is the local player's car
   */
  addCar(carBody, isLocal = false) {
    if (!this._initialized) return;
    if (this._engines.has(carBody)) return;

    const profile = ENGINE_AUDIO.profiles[carBody.carType];
    if (!profile) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;

    // Per-car gain (distance attenuation applied here)
    const carGain = ctx.createGain();
    carGain.gain.value = isLocal ? ENGINE_AUDIO.localBoost : 1.0;
    carGain.connect(this._master);

    // Per-car tone filter: softens harsh sawtooth/square harmonics
    const toneLPF = ctx.createBiquadFilter();
    toneLPF.type = 'lowpass';
    toneLPF.frequency.setValueAtTime(
      profile.toneLPF || ENGINE_AUDIO.toneLPF || 1200, now,
    );
    toneLPF.Q.setValueAtTime(0.7, now); // gentle slope, no resonance
    toneLPF.connect(carGain);

    // Subtle amplitude LFO for organic engine irregularity
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    // Randomize LFO rate per car so they don't pulse in sync
    lfo.frequency.setValueAtTime(3 + Math.random() * 4, now); // 3-7 Hz
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0.06, now); // very subtle wobble
    lfo.connect(lfoGain);
    lfoGain.connect(carGain.gain); // modulates car volume slightly
    lfo.start(now);

    // Oscillator layers
    const oscNodes = profile.oscillators.map((osc) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = osc.type;
      oscillator.frequency.setValueAtTime(profile.baseFreq * osc.freqRatio, now);
      // Apply per-oscillator detuning for thicker, more organic sound
      if (osc.detune) {
        oscillator.detune.setValueAtTime(osc.detune, now);
      }

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(osc.gain, now);

      oscillator.connect(gainNode).connect(toneLPF);
      oscillator.start(now);

      return { oscillator, gainNode, freqRatio: osc.freqRatio };
    });

    // Noise layer (mechanical rumble)
    let noiseSource = null;
    let noiseGain = null;
    if (profile.noiseGain > 0) {
      // Create looping noise buffer
      const bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;

      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(profile.noiseLPF, now);

      noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(profile.noiseGain, now);

      noiseSource.connect(lpf).connect(noiseGain).connect(toneLPF);
      noiseSource.start(now);
    }

    this._engines.set(carBody, {
      oscNodes,
      noiseSource,
      noiseGain,
      carGain,
      toneLPF,
      lfo,
      lfoGain,
      profile,
      isLocal,
      currentRPM: 0, // smoothed 0-1 RPM ratio
    });
  }

  /**
   * Remove engine sound for a car (on death/removal).
   */
  removeCar(carBody) {
    const engine = this._engines.get(carBody);
    if (!engine) return;

    for (const { oscillator } of engine.oscNodes) {
      try { oscillator.stop(); } catch (_) {}
      try { oscillator.disconnect(); } catch (_) {}
    }
    if (engine.noiseSource) {
      try { engine.noiseSource.stop(); } catch (_) {}
      try { engine.noiseSource.disconnect(); } catch (_) {}
    }
    if (engine.lfo) {
      try { engine.lfo.stop(); } catch (_) {}
      try { engine.lfo.disconnect(); } catch (_) {}
    }
    if (engine.lfoGain) {
      try { engine.lfoGain.disconnect(); } catch (_) {}
    }
    if (engine.toneLPF) {
      try { engine.toneLPF.disconnect(); } catch (_) {}
    }
    try { engine.carGain.disconnect(); } catch (_) {}

    this._engines.delete(carBody);
  }

  /**
   * Update listener position (local player position).
   */
  setListenerPosition(x, z) {
    this._listenerPos.x = x;
    this._listenerPos.z = z;
  }

  /**
   * Update all engine sounds. Call every frame.
   * @param {number} dt - Frame delta time
   */
  update(dt) {
    if (!this._initialized || this._muted) return;

    const smoothing = ENGINE_AUDIO.rpmSmoothing;

    for (const [carBody, engine] of this._engines) {
      const { profile, oscNodes, noiseGain, carGain, toneLPF, isLocal } = engine;

      // Calculate RPM ratio from car speed
      const absSpeed = Math.abs(carBody._currentSpeed);
      const maxSpeed = Math.max(carBody.maxSpeed * carBody.speedMultiplier, 1);
      const targetRPM = Math.min(absSpeed / maxSpeed, 1);

      // Smooth RPM transition
      engine.currentRPM += (targetRPM - engine.currentRPM) * Math.min(1, smoothing * dt);

      // Map RPM to frequency
      const freq = profile.baseFreq + (profile.maxFreq - profile.baseFreq) * engine.currentRPM;

      // Update oscillator frequencies
      const now = this._ctx.currentTime;
      for (const { oscillator, freqRatio } of oscNodes) {
        oscillator.frequency.setTargetAtTime(freq * freqRatio, now, 0.03);
      }

      // Scale noise with RPM (louder at higher RPM)
      if (noiseGain) {
        const nGain = profile.noiseGain * (0.3 + 0.7 * engine.currentRPM);
        noiseGain.gain.setTargetAtTime(nGain, now, 0.05);
      }

      // Modulate tone filter with RPM — opens up at higher speed for brighter sound
      if (toneLPF) {
        const baseCutoff = profile.toneLPF || ENGINE_AUDIO.toneLPF || 1200;
        const filterFreq = baseCutoff * (0.6 + 0.4 * engine.currentRPM);
        toneLPF.frequency.setTargetAtTime(filterFreq, now, 0.08);
      }

      // Distance attenuation for non-local cars
      if (!isLocal) {
        const dx = carBody.body.position.x - this._listenerPos.x;
        const dz = carBody.body.position.z - this._listenerPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        let vol = 0;
        if (dist < ENGINE_AUDIO.spatialRefDist) {
          vol = 1.0;
        } else if (dist < ENGINE_AUDIO.spatialMaxDist) {
          // Inverse distance falloff
          vol = ENGINE_AUDIO.spatialRefDist / dist;
        }
        carGain.gain.setTargetAtTime(vol, now, 0.05);
      }
    }
  }

  /**
   * Stop all engine sounds.
   */
  stopAll() {
    for (const carBody of [...this._engines.keys()]) {
      this.removeCar(carBody);
    }
  }

  /**
   * Mute/unmute engine audio.
   */
  setMuted(muted) {
    this._muted = muted;
    if (this._master) {
      this._master.gain.setTargetAtTime(
        muted ? 0 : ENGINE_AUDIO.masterVolume,
        this._ctx.currentTime,
        0.05,
      );
    }
  }

  /**
   * Pause audio context (e.g., tab hidden).
   */
  pause() {
    if (this._ctx && this._ctx.state === 'running') {
      this._ctx.suspend();
    }
  }

  /**
   * Resume audio context.
   */
  resume() {
    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }
}

export const engineAudio = new EngineAudioManager();
