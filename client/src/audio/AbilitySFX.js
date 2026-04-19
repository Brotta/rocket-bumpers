/**
 * AbilitySFX — procedural sound effects for ability activation/deactivation.
 *
 * Mirrors the style of CollisionSFX.js: pure Web Audio synthesis, optional
 * spatial positioning (distance attenuation + stereo pan), auto-cleanup.
 *
 * Currently provides:
 *   - playRamGrowSFX(x?, z?)    → RHINO mushroom grow (Mario 1-UP style pop)
 *   - playRamShrinkSFX(x?, z?)  → RHINO mushroom shrink (deflate)
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS, SPATIAL } from './AudioConfig.js';

/** Build a spatial master-gain → panner → SFX bus chain. Returns { node, now } or null. */
function _openSpatialSink(x, z) {
  if (!audioManager.isInitialized) return null;
  const ctx = audioManager.ctx;
  const sfxBus = audioManager.getBus(AUDIO_BUS.SFX);
  if (!ctx || !sfxBus) return null;

  let spatialGain = 1.0;
  let pan = 0;
  const isSpatial = x !== undefined && z !== undefined;
  if (isSpatial) {
    const dist = audioManager.distanceToListener(x, z);
    spatialGain = audioManager.distanceGain(dist, SPATIAL.refDistance, SPATIAL.maxDistance);
    if (spatialGain < 0.02) return null;
    const dx = x - audioManager.listenerX;
    const dz = z - audioManager.listenerZ;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 0.5) {
      pan = Math.max(-1, Math.min(1, Math.sin(Math.atan2(dx, dz)) * 0.8));
    }
  }

  const node = ctx.createGain();
  node.gain.value = spatialGain;

  if (isSpatial && Math.abs(pan) > 0.01) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    node.connect(panner);
    panner.connect(sfxBus);
  } else {
    node.connect(sfxBus);
  }

  return { ctx, node, now: ctx.currentTime };
}

function _scheduleCleanup(node, seconds) {
  setTimeout(() => { try { node.disconnect(); } catch (_) {} }, seconds * 1000);
}

/**
 * Play the RHINO RAM "grow" SFX — Mario-mushroom style ascending arpeggio
 * with a sub-thud at onset. Runs ~0.35 s, matching the grow animation.
 */
export function playRamGrowSFX(x, z) {
  const sink = _openSpatialSink(x, z);
  if (!sink) return;
  const { ctx, node, now } = sink;

  // ── Layer 1: sub thud at onset (weighty "pop") ─────────────────────
  {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.55, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(g); g.connect(node);
    osc.start(now); osc.stop(now + 0.25);
  }

  // ── Layer 2: chiptune ascending arpeggio (C major pentatonic) ──────
  // 8 blips over ~0.35 s — classic power-up pop.
  const notes = [523.25, 659.25, 783.99, 880.00, 1046.50, 1318.51, 1567.98, 2093.00];
  const step = 0.04; // 40 ms per blip → 8 × 40 = 320 ms run
  for (let i = 0; i < notes.length; i++) {
    const t = now + i * step;
    const dur = 0.065;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(notes[i], t);

    // Second detuned oscillator for fatness
    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(notes[i] * 2, t); // octave up sparkle
    osc2.detune.value = 6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    // Soft low-pass to tame square harshness
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    lp.Q.value = 0.3;

    osc.connect(lp);
    osc2.connect(lp);
    lp.connect(g);
    g.connect(node);
    osc.start(t); osc.stop(t + dur + 0.01);
    osc2.start(t); osc2.stop(t + dur + 0.01);
  }

  // ── Layer 3: quick whoosh on tail (air inflating) ──────────────────
  {
    const size = Math.floor(ctx.sampleRate * 0.3);
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(600, now);
    bp.frequency.exponentialRampToValueAtTime(2400, now + 0.28);
    bp.Q.value = 1.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.15, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    src.connect(bp); bp.connect(g); g.connect(node);
    src.start(now); src.stop(now + 0.31);
  }

  _scheduleCleanup(node, 0.45);
}

/**
 * Play the RHINO RAM "shrink" SFX — quick deflate slide down.
 * Runs ~0.2 s, matching the shrink animation.
 */
export function playRamShrinkSFX(x, z) {
  const sink = _openSpatialSink(x, z);
  if (!sink) return;
  const { ctx, node, now } = sink;

  // ── Layer 1: descending sawtooth slide (deflate) ───────────────────
  {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.2);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4000, now);
    lp.frequency.exponentialRampToValueAtTime(600, now + 0.2);
    lp.Q.value = 2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(lp); lp.connect(g); g.connect(node);
    osc.start(now); osc.stop(now + 0.22);
  }

  // ── Layer 2: "pop" at the end (soft thud of settling) ──────────────
  {
    const t = now + 0.17;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.08);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

    osc.connect(g); g.connect(node);
    osc.start(t); osc.stop(t + 0.11);
  }

  _scheduleCleanup(node, 0.3);
}
