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

// ── Announcer FX chain (Quake-style: compressed, present, reverberant) ──
// All params tuneable from here. Chain: preGain → comp → hiPass → hiShelf
// → [dry + convolver wet] → SFX bus.
const ANNOUNCER_FX = {
  preGain: 1.4,             // boost entering the chain
  compThreshold: -22,       // dB — push voice forward in the mix
  compRatio: 8,
  compAttack: 0.003,
  compRelease: 0.25,
  compKnee: 6,
  hiPassHz: 120,            // cut sub rumble under vocal range
  hiShelfHz: 3000,          // presence band
  hiShelfGain: 4,           // dB — brightness, cuts through engines
  reverbDurationSec: 1.8,   // total IR length
  reverbDecay: 3.0,         // higher = faster tail decay
  dryMix: 0.7,
  wetMix: 0.45,
  cooldownSec: 1.0,         // min spacing between any two announcer plays
};

class SFXPlayerSingleton {
  constructor() {
    /** @type {Map<string, AudioBuffer>} name → decoded buffer */
    this._samples = new Map();

    /** @type {Array<ActiveSFX>} currently playing sounds */
    this._active = [];

    // Announcer FX chain (lazy-init on first use)
    this._anncInput = null;
    this._anncLastPlayTime = 0;
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

    // Defensive resume — browsers sometimes auto-suspend the AudioContext
    // after multi-second gaps of no audio activity (e.g. the WebSocket
    // handshake between the user's click and gameplay start in MP). Any
    // scheduled source.start() inside a suspended context is silent, so
    // we kick it back awake here; the persistent gesture listeners in
    // AudioManager cover the case where resume() is rejected without a
    // fresh gesture.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Enforce global cooldown on announcer voice lines (Quake-style — no overlap).
    // `announcerOverride: true` bypasses the cooldown AND stops any in-flight
    // announcer, so important lines (e.g. multi-kill) always win.
    if (opts.effect === 'announcer') {
      const now = ctx.currentTime;
      if (opts.announcerOverride) {
        for (let i = this._active.length - 1; i >= 0; i--) {
          const a = this._active[i];
          if (!a.isAnnouncer) continue;
          try { a.source.stop(); } catch (_) {}
          try { a.gainNode.disconnect(); } catch (_) {}
          this._active.splice(i, 1);
        }
      } else if (now - this._anncLastPlayTime < ANNOUNCER_FX.cooldownSec) {
        return;
      }
      this._anncLastPlayTime = now;
    }

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
    source.connect(gainNode);

    let lastNode = gainNode;

    if (opts.effect === 'announcer') {
      // Route through the shared announcer FX chain (lazy-built).
      gainNode.connect(this._getAnnouncerInput(ctx, sfxBus));
      lastNode = gainNode;
    } else if (isSpatial && Math.abs(pan) > 0.01) {
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
      isAnnouncer: opts.effect === 'announcer',
    };

    source.onended = () => { entry.ended = true; };
    this._active.push(entry);
  }

  /**
   * Lazy-build the announcer FX chain and return its input node.
   * The chain is shared across all clips played with effect: 'announcer'.
   */
  _getAnnouncerInput(ctx, sfxBus) {
    if (this._anncInput) return this._anncInput;

    const cfg = ANNOUNCER_FX;
    const input = ctx.createGain();
    input.gain.value = cfg.preGain;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = cfg.compThreshold;
    comp.ratio.value = cfg.compRatio;
    comp.attack.value = cfg.compAttack;
    comp.release.value = cfg.compRelease;
    comp.knee.value = cfg.compKnee;

    const hiPass = ctx.createBiquadFilter();
    hiPass.type = 'highpass';
    hiPass.frequency.value = cfg.hiPassHz;

    const hiShelf = ctx.createBiquadFilter();
    hiShelf.type = 'highshelf';
    hiShelf.frequency.value = cfg.hiShelfHz;
    hiShelf.gain.value = cfg.hiShelfGain;

    const reverb = ctx.createConvolver();
    reverb.buffer = this._makeReverbIR(ctx, cfg.reverbDurationSec, cfg.reverbDecay);

    const dry = ctx.createGain();
    dry.gain.value = cfg.dryMix;
    const wet = ctx.createGain();
    wet.gain.value = cfg.wetMix;

    // Wiring
    input.connect(comp);
    comp.connect(hiPass);
    hiPass.connect(hiShelf);
    hiShelf.connect(dry);
    hiShelf.connect(reverb);
    reverb.connect(wet);
    dry.connect(sfxBus);
    wet.connect(sfxBus);

    this._anncInput = input;
    return input;
  }

  /** Synthesize a simple decaying-noise impulse response for convolution reverb. */
  _makeReverbIR(ctx, durationSec, decay) {
    const sr = ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * durationSec));
    const ir = ctx.createBuffer(2, length, sr);
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const t = 1 - i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(t, decay);
      }
    }
    return ir;
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
