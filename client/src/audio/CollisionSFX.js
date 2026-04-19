/**
 * CollisionSFX — procedural car-to-car collision sounds using Web Audio API.
 *
 * Synthesizes layered metallic crash/crunch sounds that scale with damage tier:
 *  - Body thud (low-frequency sine oscillator)
 *  - Metal crunch (filtered noise burst)
 *  - Glass/debris (high-pass filtered noise, heavy+ only)
 *  - Sub boom (ultra-low sine, devastating only)
 *
 * All synthesis is real-time with zero external audio files.
 * Supports spatial positioning (distance attenuation + stereo pan).
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS, SPATIAL } from './AudioConfig.js';
import { COLLISION_IMPACT, MISSILE_IMPACT } from '../core/Config.js';

/**
 * Play a collision impact sound at the given world position.
 * @param {string} tier — 'light' | 'heavy' | 'devastating'
 * @param {number} x — world X position
 * @param {number} z — world Z position
 */
export function playCollisionSFX(tier, x, z) {
  if (!audioManager.isInitialized) return;
  audioManager.ensureRunning();

  const ctx = audioManager.ctx;
  const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
  if (!ctx || !sfxBus) return;

  // Spatial attenuation
  const dist = audioManager.distanceToListener(x, z);
  const spatialGain = audioManager.distanceGain(dist, SPATIAL.refDistance, SPATIAL.maxDistance);
  if (spatialGain < 0.02) return; // too far

  // Stereo pan
  const dx = x - audioManager.listenerX;
  const dz = z - audioManager.listenerZ;
  const d = Math.sqrt(dx * dx + dz * dz);
  let pan = 0;
  if (d > 0.5) {
    pan = Math.max(-1, Math.min(1, Math.sin(Math.atan2(dx, dz)) * 0.8));
  }

  // Build spatial chain: gain → panner → bus
  const masterGain = ctx.createGain();
  masterGain.gain.value = spatialGain;

  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  masterGain.connect(panner);
  panner.connect(sfxBus);

  const now = ctx.currentTime;
  const cfg = COLLISION_IMPACT.audio[tier];

  // ── Layer 1: Body thud (sine oscillator with pitch drop) ──
  if (cfg.thud) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.thud.freq, now);
    osc.frequency.exponentialRampToValueAtTime(cfg.thud.freq * 0.4, now + cfg.thud.decay);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.thud.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.thud.decay);

    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + cfg.thud.decay + 0.01);
  }

  // ── Layer 2: Metal crunch (bandpass-filtered noise) ──
  if (cfg.crunch) {
    const bufferSize = Math.floor(ctx.sampleRate * cfg.crunch.decay);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime((cfg.crunch.freqLo + cfg.crunch.freqHi) / 2, now);
    bandpass.Q.setValueAtTime(1.5, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.crunch.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.crunch.decay);

    // Add a subtle distortion for metallic character
    const waveshaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = (Math.PI + 3) * x / (Math.PI + 3 * Math.abs(x));
    }
    waveshaper.curve = curve;
    waveshaper.oversample = 'none';

    source.connect(bandpass);
    bandpass.connect(waveshaper);
    waveshaper.connect(gain);
    gain.connect(masterGain);
    source.start(now);
    source.stop(now + cfg.crunch.decay + 0.01);
  }

  // ── Layer 3: Glass/debris (high-pass filtered noise, heavy+ only) ──
  if (cfg.glass) {
    const bufferSize = Math.floor(ctx.sampleRate * cfg.glass.decay);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.setValueAtTime(cfg.glass.freqHi, now);
    highpass.Q.setValueAtTime(0.7, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.glass.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.glass.decay);

    source.connect(highpass);
    highpass.connect(gain);
    gain.connect(masterGain);
    source.start(now);
    source.stop(now + cfg.glass.decay + 0.01);
  }

  // ── Layer 4: Sub boom (devastating only — ultra-low sine) ──
  if (cfg.sub) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.sub.freq, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + cfg.sub.decay);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.sub.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.sub.decay);

    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + cfg.sub.decay + 0.01);
  }

  // Clean up master gain node after all sounds finish
  const maxDecay = Math.max(
    cfg.thud?.decay || 0,
    cfg.crunch?.decay || 0,
    cfg.glass?.decay || 0,
    cfg.sub?.decay || 0,
  );
  setTimeout(() => {
    try { masterGain.disconnect(); } catch (_) {}
  }, (maxDecay + 0.1) * 1000);
}

/**
 * Play a victim-perspective impact sound (non-spatial, centered).
 * Used when the local player is hit by a missile or turret bullet.
 * @param {string} weaponType — 'missile' | 'turret'
 */
export function playVictimImpactSFX(weaponType) {
  if (!audioManager.isInitialized) return;
  audioManager.ensureRunning();

  const ctx = audioManager.ctx;
  const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
  if (!ctx || !sfxBus) return;

  const cfg = MISSILE_IMPACT.victimAudio[weaponType];
  if (!cfg) return;

  const now = ctx.currentTime;

  // Thud (non-spatial — victim hears it "in their head")
  if (cfg.thud) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.thud.freq, now);
    osc.frequency.exponentialRampToValueAtTime(cfg.thud.freq * 0.3, now + cfg.thud.decay);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.thud.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.thud.decay);

    osc.connect(gain);
    gain.connect(sfxBus);
    osc.start(now);
    osc.stop(now + cfg.thud.decay + 0.01);
  }

  // Metal crunch
  if (cfg.crunch) {
    const bufferSize = Math.floor(ctx.sampleRate * cfg.crunch.decay);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime((cfg.crunch.freqLo + cfg.crunch.freqHi) / 2, now);
    bandpass.Q.setValueAtTime(1.2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(cfg.crunch.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.crunch.decay);

    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(sfxBus);
    source.start(now);
    source.stop(now + cfg.crunch.decay + 0.01);
  }
}
