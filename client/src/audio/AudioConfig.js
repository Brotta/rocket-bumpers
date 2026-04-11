/**
 * AudioConfig — all audio system constants, engine sample definitions,
 * gear tables, spatial settings, and per-car engine profiles.
 *
 * Single source of truth for the centralized audio system.
 */

// ── Audio bus categories ──────────────────────────────────────────────
export const AUDIO_BUS = {
  ENGINE: 'ENGINE',
  SFX:    'SFX',
  MUSIC:  'MUSIC',
  UI:     'UI',
};

// ── Volume defaults (0-1) ─────────────────────────────────────────────
export const AUDIO_VOLUMES = {
  master: 0.7,
  [AUDIO_BUS.ENGINE]: 0.25,  // halved from 0.5 — engines were too loud
  [AUDIO_BUS.SFX]:    0.8,
  [AUDIO_BUS.MUSIC]:  0.4,
  [AUDIO_BUS.UI]:     0.9,
};

// ── Spatial audio settings ────────────────────────────────────────────
export const SPATIAL = {
  maxDistance:  50,   // beyond this, sound is silent
  refDistance:   8,   // distance at which volume = 1.0
  localBoost:   1.0, // volume multiplier for local player engine

  // LOD tiers for engine audio (distance from listener)
  lodFull:     20,   // 4-layer crossfade
  lodMedium:   35,   // 2-layer simplified
  // beyond lodMedium: all gains zeroed (culled)
};

// ── Voice management ──────────────────────────────────────────────────
export const VOICE_LIMITS = {
  maxVoices:       32,  // total concurrent AudioBufferSourceNodes with audible gain
  maxEngineVoices: 16,  // max engine voice groups (each = 4 sources)
};

// ── Priority levels (higher = more important, never culled first) ─────
export const PRIORITY = {
  LOCAL_ENGINE:     10,
  LAVA_ERUPTION:    10,  // global event, always audible
  GEYSER_NEAR:       9,  // protected when close (<15 units)
  ENEMY_ENGINE_NEAR:  7,
  SFX_IMPACT:        6,
  GEYSER_MID:        6,
  SFX_ABILITY:       5,
  ENEMY_ENGINE_MID:   4,
  MUSIC:              3,
  ENEMY_ENGINE_FAR:   2,
  AMBIENT:            1,
};

// ── Protected voice distance threshold ────────────────────────────────
// Geysers within this distance become protected (cannot be culled by voice manager)
export const GEYSER_PROTECT_DISTANCE = 15;

// ── Engine sample sets ────────────────────────────────────────────────
// Each set has 4 looping layers: on_low, off_low, on_high, off_high
// `rpm` = the RPM at which the sample was recorded (used for detune calculation)
// `volume` = per-sample gain multiplier
export const ENGINE_SAMPLES = {
  bac_mono: {
    on_low:   { url: 'assets/audio/engines/bac_mono/on_low.ogg',   rpm: 1000, volume: 0.5 },
    off_low:  { url: 'assets/audio/engines/bac_mono/off_low.ogg',  rpm: 1000, volume: 0.5 },
    on_high:  { url: 'assets/audio/engines/bac_mono/on_high.ogg',  rpm: 1000, volume: 0.5 },
    off_high: { url: 'assets/audio/engines/bac_mono/off_high.ogg', rpm: 1000, volume: 0.5 },
  },
  ferrari_458: {
    on_low:   { url: 'assets/audio/engines/ferrari_458/on_low.ogg',   rpm: 5300, volume: 1.5 },
    off_low:  { url: 'assets/audio/engines/ferrari_458/off_low.ogg',  rpm: 6900, volume: 1.4 },
    on_high:  { url: 'assets/audio/engines/ferrari_458/on_high.ogg',  rpm: 7700, volume: 2.5 },
    off_high: { url: 'assets/audio/engines/ferrari_458/off_high.ogg', rpm: 7900, volume: 1.6 },
  },
  procar: {
    on_low:   { url: 'assets/audio/engines/procar/on_low.ogg',   rpm: 3200, volume: 1.0 },
    off_low:  { url: 'assets/audio/engines/procar/off_low.ogg',  rpm: 3400, volume: 1.3 },
    on_high:  { url: 'assets/audio/engines/procar/on_high.ogg',  rpm: 8000, volume: 1.0 },
    off_high: { url: 'assets/audio/engines/procar/off_high.ogg', rpm: 8430, volume: 1.3 },
  },
};

// ── Limiter sample (shared across all engine types) ───────────────────
export const LIMITER_SAMPLE = {
  url: 'assets/audio/engines/limiter.ogg',
  rpm: 8000,
  volume: 0.4,
};

// ── RPM crossfade thresholds ──────────────────────────────────────────
// Crossfade between low and high samples is calculated PER-PROFILE as a
// fraction of the car's RPM range (idle→redline). This ensures cars with
// low redlines (MAMMOTH=5000) still crossfade correctly.
//   rpmLow  = idleRPM + lowFrac  * (redlineRPM - idleRPM)
//   rpmHigh = idleRPM + highFrac * (redlineRPM - idleRPM)
export const RPM_CROSSFADE_FRACTIONS = {
  lowFrac:  0.25,  // crossfade starts at 25% of RPM range
  highFrac: 0.70,  // crossfade ends at 70% of RPM range
};

// ── Gear tables ──────────────────────────────────────────────────────
// Each gear defines the fraction of maxSpeed at which it "tops out".
// Fewer gears = each gear covers more speed range = longer RPM sweeps = more audible.

const GEARS_4 = [
  { maxSpeedFrac: 0.50 },  // 1st — short launch gear
  { maxSpeedFrac: 0.65 },  // 2nd
  { maxSpeedFrac: 0.85 },  // 3rd
  { maxSpeedFrac: 1.00 },  // 4th — top gear
];

const GEARS_3 = [
  { maxSpeedFrac: 0.50 },  // 1st
  { maxSpeedFrac: 0.80 },  // 2nd
  { maxSpeedFrac: 1.00 },  // 3rd
];

const GEARS_2 = [
  { maxSpeedFrac: 0.75 },  // 1st — big low gear
  { maxSpeedFrac: 1.00 },  // 2nd — cruise
];

// ── Gear simulation defaults ──────────────────────────────────────────
export const GEAR_DEFAULTS = {
  shiftDropFrac:       0.45,   // RPM drops to this fraction of redline on upshift (lower = more dramatic)
  shiftDuration:       0.18,   // seconds of "neutral" during shift (longer = more audible shift)
  downshiftHysteresis: 0.05,   // speed must drop 5% below gear boundary to downshift
  rpmSmoothingUp:      6.0,    // smoothing factor for RPM increases (per second)
  rpmSmoothingDown:    8.0,    // decay for downshift feel
  throttleSmoothingUp:  8.0,   // how fast throttle ramps up
  throttleSmoothingDown: 5.0,  // how fast throttle ramps down (slower = engine braking feel)
};

// ── Per-car engine audio profiles ─────────────────────────────────────
// sampleSet: which ENGINE_SAMPLES set to use
// idleRPM / redlineRPM: the RPM range for this car (affects pitch and gear mapping)
// rpmPitchFactor: cents per RPM difference (higher = more pitch change per RPM)
// gears: gear table array
// postFilter: optional BiquadFilter type applied after car gain (e.g., 'highpass' for electric)
// postFilterFreq: cutoff frequency for postFilter
export const CAR_ENGINE_PROFILES = {
  FANG: {
    // Muscle car — speed 6, intermediate → 3 gears
    sampleSet:      'ferrari_458',
    idleRPM:        1000,
    redlineRPM:     8900,
    rpmPitchFactor: 0.2,
    gears:          GEARS_3,
  },
  HORNET: {
    // Go-kart — speed 7, light & fast → 3 gears
    sampleSet:      'bac_mono',
    idleRPM:        1200,
    redlineRPM:     9000,
    rpmPitchFactor: 0.2,
    gears:          GEARS_3,
  },
  RHINO: {
    // Armored truck — speed 3, slow & heavy → 2 gears
    sampleSet:      'procar',
    idleRPM:        800,
    redlineRPM:     6000,
    rpmPitchFactor: 0.15,
    gears:          GEARS_2,
  },
  VIPER: {
    // Formula racer — speed 8, fastest car → 4 gears (max)
    sampleSet:      'ferrari_458',
    idleRPM:        1000,
    redlineRPM:     9000,
    rpmPitchFactor: 0.2,
    gears:          GEARS_4,
  },
  TOAD: {
    // Van — speed 4, slow → 2 gears
    sampleSet:      'procar',
    idleRPM:        900,
    redlineRPM:     7000,
    rpmPitchFactor: 0.18,
    gears:          GEARS_2,
  },
  LYNX: {
    // Sporty hatchback — speed 5, intermediate → 3 gears
    sampleSet:      'bac_mono',
    idleRPM:        1000,
    redlineRPM:     9000,
    rpmPitchFactor: 0.2,
    gears:          GEARS_3,
  },
  MAMMOTH: {
    // Tractor — speed 4, slow & heavy → 2 gears
    sampleSet:      'procar',
    idleRPM:        700,
    redlineRPM:     5000,
    rpmPitchFactor: 0.12,
    gears:          GEARS_2,
  },
  GHOST: {
    // Cyber car — speed 6, intermediate → 3 gears
    sampleSet:      'bac_mono',
    idleRPM:        1500,
    redlineRPM:     9000,
    rpmPitchFactor: 0.25,
    gears:          GEARS_3,
    postFilter:     'highpass',
    postFilterFreq: 400,
  },
};

/**
 * Collect all unique sample URLs that need to be preloaded at game start.
 * Returns a flat array of URL strings.
 */
export function getAllEngineSampleURLs() {
  const urls = new Set();
  for (const profile of Object.values(CAR_ENGINE_PROFILES)) {
    const samples = ENGINE_SAMPLES[profile.sampleSet];
    if (samples) {
      for (const s of Object.values(samples)) {
        urls.add(s.url);
      }
    }
  }
  urls.add(LIMITER_SAMPLE.url);
  return [...urls];
}
