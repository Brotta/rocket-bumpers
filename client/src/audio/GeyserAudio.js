/**
 * GeyserAudio — Procedural Web Audio API sound design for geysers.
 *
 * All sounds are synthesized in real-time — no external audio files needed.
 * Uses a combination of noise, filtered oscillators, and envelopes to create
 * realistic-but-stylized volcanic geyser sounds:
 *
 *   • Warning rumble: low-frequency filtered noise with rising pitch
 *   • Eruption blast: layered noise burst + sub-bass impact
 *   • Active hiss: sustained steam/lava hiss with modulation
 *   • Cooldown sizzle: decaying crackle
 *
 * Migrated to use the centralized AudioManager:
 *  - Uses audioManager.ctx instead of creating its own AudioContext
 *  - Connects to the SFX bus instead of its own master gain
 *  - Uses audioManager for listener position and distance calculation
 *  - Geyser voices near the player are registered as protected
 *  - Lava eruption is always protected (global event)
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS, SPATIAL, PRIORITY, GEYSER_PROTECT_DISTANCE } from './AudioConfig.js';

export class GeyserAudio {
  constructor() {
    this._activeNodes = new Map(); // slotIndex → { nodes... }
    this._maxDistance = 40; // beyond this distance, sound is silent
    this._refDistance = 5;  // distance at which volume is 1.0
  }

  /**
   * Calculate distance-based volume attenuation.
   * Returns 0–1 gain value using inverse-distance model.
   */
  _distanceGain(geyserX, geyserZ) {
    return audioManager.distanceGain(
      audioManager.distanceToListener(geyserX, geyserZ),
      this._refDistance,
      this._maxDistance,
    );
  }

  // ── Warning phase: low rumble building in intensity ────────────────
  startWarning(slotIndex, x, z) {
    if (!audioManager.isInitialized) return;
    this._stopSlot(slotIndex);

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    const gain = this._distanceGain(x, z);
    if (gain < 0.01) return; // too far, skip

    // Create noise source for rumble
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    // Low-pass filter: starts at 80Hz, sweeps up to 300Hz over warning duration
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 80;
    filter.frequency.linearRampToValueAtTime(300, ctx.currentTime + 1.5);
    filter.Q.value = 2;

    // Volume envelope: fade in
    const volNode = ctx.createGain();
    volNode.gain.value = 0;
    volNode.gain.linearRampToValueAtTime(0.3 * gain, ctx.currentTime + 0.8);
    volNode.gain.linearRampToValueAtTime(0.5 * gain, ctx.currentTime + 1.5);

    // Sub-bass oscillator for ground vibration feel
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 30;
    subOsc.frequency.linearRampToValueAtTime(50, ctx.currentTime + 1.5);
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    subGain.gain.linearRampToValueAtTime(0.15 * gain, ctx.currentTime + 1.0);

    // LFO for rumble modulation
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4; // 4Hz tremolo
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.1 * gain;

    // Connect graph
    noise.connect(filter);
    filter.connect(volNode);
    lfo.connect(lfoGain);
    lfoGain.connect(volNode.gain);
    volNode.connect(sfxBus);

    subOsc.connect(subGain);
    subGain.connect(sfxBus);

    noise.start();
    subOsc.start();
    lfo.start();

    // Register voice — protected if near player
    const dist = audioManager.distanceToListener(x, z);
    const isProtected = dist < GEYSER_PROTECT_DISTANCE;
    const voiceId = audioManager.registerVoice({
      priority: isProtected ? PRIORITY.GEYSER_NEAR : PRIORITY.GEYSER_MID,
      category: AUDIO_BUS.SFX,
      protected: isProtected,
      gainNode: volNode,
    });

    this._activeNodes.set(slotIndex, {
      phase: 'warning',
      x, z,
      sources: [noise, subOsc, lfo],
      gains: [volNode, subGain, lfoGain],
      filters: [filter],
      voiceId,
    });
  }

  // ── Eruption: explosive burst + sustained hiss ─────────────────────
  startEruption(slotIndex, x, z) {
    if (!audioManager.isInitialized) return;
    this._stopSlot(slotIndex);

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    const gain = this._distanceGain(x, z);
    if (gain < 0.01) return;

    // ── Impact burst: short noise burst through band-pass ──
    const burstLen = 0.3;
    const burstBuffer = ctx.createBuffer(1, ctx.sampleRate * burstLen, ctx.sampleRate);
    const burstData = burstBuffer.getChannelData(0);
    for (let i = 0; i < burstData.length; i++) {
      burstData[i] = Math.random() * 2 - 1;
    }
    const burst = ctx.createBufferSource();
    burst.buffer = burstBuffer;

    const burstFilter = ctx.createBiquadFilter();
    burstFilter.type = 'bandpass';
    burstFilter.frequency.value = 200;
    burstFilter.Q.value = 1;

    const burstGain = ctx.createGain();
    burstGain.gain.value = 0.7 * gain;
    burstGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + burstLen);

    burst.connect(burstFilter);
    burstFilter.connect(burstGain);
    burstGain.connect(sfxBus);
    burst.start();

    // ── Sub-bass impact thud ──
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.value = 60;
    thud.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.3);
    const thudGain = ctx.createGain();
    thudGain.gain.value = 0.4 * gain;
    thudGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    thud.connect(thudGain);
    thudGain.connect(sfxBus);
    thud.start();
    thud.stop(ctx.currentTime + 0.5);

    // ── Sustained hiss: filtered noise for steam/lava jet ──
    const hissLen = 4; // slightly longer than geyser lifetime for fade
    const hissBuffer = ctx.createBuffer(1, ctx.sampleRate * hissLen, ctx.sampleRate);
    const hissData = hissBuffer.getChannelData(0);
    for (let i = 0; i < hissData.length; i++) {
      hissData[i] = Math.random() * 2 - 1;
    }
    const hiss = ctx.createBufferSource();
    hiss.buffer = hissBuffer;

    const hissHP = ctx.createBiquadFilter();
    hissHP.type = 'highpass';
    hissHP.frequency.value = 800;

    const hissLP = ctx.createBiquadFilter();
    hissLP.type = 'lowpass';
    hissLP.frequency.value = 4000;
    // Modulate filter for "wavering" sound
    hissLP.frequency.linearRampToValueAtTime(6000, ctx.currentTime + 1.0);
    hissLP.frequency.linearRampToValueAtTime(3000, ctx.currentTime + 3.0);

    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hissGain.gain.linearRampToValueAtTime(0.25 * gain, ctx.currentTime + 0.15);
    // Hold then fade
    hissGain.gain.setValueAtTime(0.25 * gain, ctx.currentTime + 2.5);
    hissGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + hissLen);

    hiss.connect(hissHP);
    hissHP.connect(hissLP);
    hissLP.connect(hissGain);
    hissGain.connect(sfxBus);
    hiss.start();

    // ── Crackle: random pops (simulated with short noise grains) ──
    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0.12 * gain;
    crackleGain.connect(sfxBus);

    const crackleInterval = setInterval(() => {
      if (!audioManager.ctx || audioManager.ctx.state === 'closed') {
        clearInterval(crackleInterval);
        return;
      }
      const popLen = 0.02 + Math.random() * 0.03;
      const pop = ctx.createBuffer(1, ctx.sampleRate * popLen, ctx.sampleRate);
      const popData = pop.getChannelData(0);
      for (let i = 0; i < popData.length; i++) {
        popData[i] = (Math.random() * 2 - 1) * (1 - i / popData.length);
      }
      const popSrc = ctx.createBufferSource();
      popSrc.buffer = pop;
      const popFilter = ctx.createBiquadFilter();
      popFilter.type = 'bandpass';
      popFilter.frequency.value = 1000 + Math.random() * 3000;
      popFilter.Q.value = 3;
      popSrc.connect(popFilter);
      popFilter.connect(crackleGain);
      popSrc.start();
    }, 60 + Math.random() * 100);

    // Register voice — protected if near player
    const dist = audioManager.distanceToListener(x, z);
    const isProtected = dist < GEYSER_PROTECT_DISTANCE;
    const voiceId = audioManager.registerVoice({
      priority: isProtected ? PRIORITY.GEYSER_NEAR : PRIORITY.GEYSER_MID,
      category: AUDIO_BUS.SFX,
      protected: isProtected,
      gainNode: hissGain,
    });

    this._activeNodes.set(slotIndex, {
      phase: 'active',
      x, z,
      sources: [burst, hiss, thud],
      gains: [burstGain, hissGain, thudGain, crackleGain],
      filters: [burstFilter, hissHP, hissLP],
      intervals: [crackleInterval],
      voiceId,
    });

    // Auto-cleanup after hiss ends
    setTimeout(() => {
      clearInterval(crackleInterval);
    }, hissLen * 1000);
  }

  // ── Cooldown: sizzle/crackle decay ─────────────────────────────────
  startCooldown(slotIndex, x, z) {
    if (!audioManager.isInitialized) return;
    this._stopSlot(slotIndex);

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    const gain = this._distanceGain(x, z);
    if (gain < 0.01) return;

    // Short sizzle: filtered noise decaying
    const sizzleLen = 2.0;
    const sizzleBuffer = ctx.createBuffer(1, ctx.sampleRate * sizzleLen, ctx.sampleRate);
    const sizzleData = sizzleBuffer.getChannelData(0);
    for (let i = 0; i < sizzleData.length; i++) {
      sizzleData[i] = Math.random() * 2 - 1;
    }
    const sizzle = ctx.createBufferSource();
    sizzle.buffer = sizzleBuffer;

    const sizzleHP = ctx.createBiquadFilter();
    sizzleHP.type = 'highpass';
    sizzleHP.frequency.value = 2000;

    const sizzleGain = ctx.createGain();
    sizzleGain.gain.value = 0.15 * gain;
    sizzleGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + sizzleLen);

    sizzle.connect(sizzleHP);
    sizzleHP.connect(sizzleGain);
    sizzleGain.connect(sfxBus);
    sizzle.start();

    this._activeNodes.set(slotIndex, {
      phase: 'cooldown',
      x, z,
      sources: [sizzle],
      gains: [sizzleGain],
      filters: [sizzleHP],
      voiceId: null,
    });

    // Auto-cleanup
    setTimeout(() => {
      this._stopSlot(slotIndex);
    }, sizzleLen * 1000);
  }

  // ══════════════════════════════════════════════════════════════════
  // CENTRAL LAVA ERUPTION AUDIO
  // ══════════════════════════════════════════════════════════════════

  // ── Eruption warning: deep rumble building over 2 seconds ─────────
  playEruptionWarning() {
    if (!audioManager.isInitialized) return;
    this._stopSlot('eruption-warning');

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    // Deep rumble noise
    const bufferSize = ctx.sampleRate * 2.5;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    // Low-pass filter sweeping up
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 50;
    filter.frequency.linearRampToValueAtTime(250, ctx.currentTime + 2.0);
    filter.Q.value = 3;

    // Volume ramp
    const volNode = ctx.createGain();
    volNode.gain.value = 0;
    volNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 1.5);
    volNode.gain.linearRampToValueAtTime(0.7, ctx.currentTime + 2.0);

    // Sub-bass rumble (deeper than geyser — this is the volcano)
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 20;
    subOsc.frequency.linearRampToValueAtTime(40, ctx.currentTime + 2.0);
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    subGain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 1.5);

    // Second sub harmonic for richness
    const subOsc2 = ctx.createOscillator();
    subOsc2.type = 'triangle';
    subOsc2.frequency.value = 35;
    subOsc2.frequency.linearRampToValueAtTime(55, ctx.currentTime + 2.0);
    const subGain2 = ctx.createGain();
    subGain2.gain.value = 0;
    subGain2.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 1.8);

    // Tremolo LFO — accelerating as eruption approaches
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 2;
    lfo.frequency.linearRampToValueAtTime(12, ctx.currentTime + 2.0);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.15;

    noise.connect(filter);
    filter.connect(volNode);
    lfo.connect(lfoGain);
    lfoGain.connect(volNode.gain);
    volNode.connect(sfxBus);
    subOsc.connect(subGain);
    subGain.connect(sfxBus);
    subOsc2.connect(subGain2);
    subGain2.connect(sfxBus);

    noise.start();
    subOsc.start();
    subOsc2.start();
    lfo.start();

    // Lava eruption warning is ALWAYS protected (global event)
    const voiceId = audioManager.registerVoice({
      priority: PRIORITY.LAVA_ERUPTION,
      category: AUDIO_BUS.SFX,
      protected: true,
      gainNode: volNode,
    });

    this._activeNodes.set('eruption-warning', {
      phase: 'eruption-warning',
      sources: [noise, subOsc, subOsc2, lfo],
      gains: [volNode, subGain, subGain2, lfoGain],
      filters: [filter],
      voiceId,
    });
  }

  // ── Eruption blast: massive explosion + aftermath ──────────────────
  playEruptionBlast() {
    if (!audioManager.isInitialized) return;
    this._stopSlot('eruption-warning');
    this._stopSlot('eruption-blast');

    const ctx = audioManager.ctx;
    const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
    if (!ctx || !sfxBus) return;

    // ── Layer 1: massive impact thud ──
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.value = 80;
    thud.frequency.exponentialRampToValueAtTime(15, ctx.currentTime + 0.6);
    const thudGain = ctx.createGain();
    thudGain.gain.value = 0.65;
    thudGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    thud.connect(thudGain);
    thudGain.connect(sfxBus);
    thud.start();
    thud.stop(ctx.currentTime + 1.0);

    // ── Layer 2: noise burst (wide-band explosion) ──
    const burstLen = 0.5;
    const burstBuffer = ctx.createBuffer(1, ctx.sampleRate * burstLen, ctx.sampleRate);
    const burstData = burstBuffer.getChannelData(0);
    for (let i = 0; i < burstData.length; i++) {
      burstData[i] = Math.random() * 2 - 1;
    }
    const burst = ctx.createBufferSource();
    burst.buffer = burstBuffer;

    const burstBP = ctx.createBiquadFilter();
    burstBP.type = 'bandpass';
    burstBP.frequency.value = 150;
    burstBP.Q.value = 0.5; // wide band

    const burstGain = ctx.createGain();
    burstGain.gain.value = 0.8;
    burstGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + burstLen);

    burst.connect(burstBP);
    burstBP.connect(burstGain);
    burstGain.connect(sfxBus);
    burst.start();

    // ── Layer 3: mid rumble tail (fading roar) ──
    const roarLen = 3.0;
    const roarBuffer = ctx.createBuffer(1, ctx.sampleRate * roarLen, ctx.sampleRate);
    const roarData = roarBuffer.getChannelData(0);
    for (let i = 0; i < roarData.length; i++) {
      roarData[i] = Math.random() * 2 - 1;
    }
    const roar = ctx.createBufferSource();
    roar.buffer = roarBuffer;

    const roarLP = ctx.createBiquadFilter();
    roarLP.type = 'lowpass';
    roarLP.frequency.value = 600;
    roarLP.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + roarLen);

    const roarGain = ctx.createGain();
    roarGain.gain.value = 0.35;
    roarGain.gain.setValueAtTime(0.35, ctx.currentTime + 0.5);
    roarGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + roarLen);

    roar.connect(roarLP);
    roarLP.connect(roarGain);
    roarGain.connect(sfxBus);
    roar.start();

    // ── Layer 4: debris crackle (falling rock sounds) ──
    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0.18;
    crackleGain.connect(sfxBus);

    let crackleCount = 0;
    const maxCrackles = 20;
    const crackleInterval = setInterval(() => {
      crackleCount++;
      if (!audioManager.ctx || audioManager.ctx.state === 'closed' || crackleCount > maxCrackles) {
        clearInterval(crackleInterval);
        return;
      }
      const popLen = 0.03 + Math.random() * 0.04;
      const pop = ctx.createBuffer(1, ctx.sampleRate * popLen, ctx.sampleRate);
      const popData = pop.getChannelData(0);
      for (let i = 0; i < popData.length; i++) {
        popData[i] = (Math.random() * 2 - 1) * (1 - i / popData.length);
      }
      const popSrc = ctx.createBufferSource();
      popSrc.buffer = pop;
      const popFilter = ctx.createBiquadFilter();
      popFilter.type = 'bandpass';
      popFilter.frequency.value = 500 + Math.random() * 2000;
      popFilter.Q.value = 4;
      popSrc.connect(popFilter);
      popFilter.connect(crackleGain);
      popSrc.start();
    }, 80 + Math.random() * 120);

    // Lava eruption blast is ALWAYS protected (global event)
    const voiceId = audioManager.registerVoice({
      priority: PRIORITY.LAVA_ERUPTION,
      category: AUDIO_BUS.SFX,
      protected: true,
      gainNode: roarGain,
    });

    this._activeNodes.set('eruption-blast', {
      phase: 'eruption-blast',
      sources: [thud, burst, roar],
      gains: [thudGain, burstGain, roarGain, crackleGain],
      filters: [burstBP, roarLP],
      intervals: [crackleInterval],
      voiceId,
    });

    // Auto-cleanup
    setTimeout(() => {
      clearInterval(crackleInterval);
      this._stopSlot('eruption-blast');
    }, roarLen * 1000);
  }

  // ── Stop all audio for a slot ──────────────────────────────────────
  _stopSlot(slotIndex) {
    const entry = this._activeNodes.get(slotIndex);
    if (!entry) return;

    for (const src of entry.sources || []) {
      try { src.stop(); } catch (_) { /* already stopped */ }
      try { src.disconnect(); } catch (_) {}
    }
    for (const g of entry.gains || []) {
      try { g.disconnect(); } catch (_) {}
    }
    for (const f of entry.filters || []) {
      try { f.disconnect(); } catch (_) {}
    }
    for (const iv of entry.intervals || []) {
      clearInterval(iv);
    }

    // Unregister voice
    if (entry.voiceId != null) {
      audioManager.unregisterVoice(entry.voiceId);
    }

    this._activeNodes.delete(slotIndex);
  }

  /** Stop all geyser audio (e.g. round end) */
  stopAll() {
    for (const idx of this._activeNodes.keys()) {
      this._stopSlot(idx);
    }
  }

  dispose() {
    this.stopAll();
  }
}
