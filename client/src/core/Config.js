/**
 * All game constants derived from GAME_DESIGN.md
 */

// ── Stat Scaling ────────────────────────────────────────────────────
// Base values are for stat 10 (theoretical max). Each car's real value
// is  BASE * (carStat / MAX_STAT).  Change the base to retune ALL cars
// proportionally.  Stat range is 2–8, MAX_STAT = 10.
export const STAT_BASE = {
  maxStat: 10,          // denominator for scaling — never change
  speed: 35,            // u/s at stat 10 → stat 8 = 22.4, stat 3 = 8.4
  accel: 40,            // u/s² at stat 10 → per-car, proportional to speed stat
  mass: 10,             // kg at stat 10
  handling: 5.5,        // handling factor at stat 10
};

// Computed lookup tables (same shape as before, so nothing else breaks)
function _buildStatMap() {
  const m = STAT_BASE.maxStat;
  const map = { speed: {}, mass: {}, handling: {}, accel: {} };
  for (let s = 2; s <= 8; s++) {
    map.speed[s]    = +(STAT_BASE.speed    * s / m).toFixed(1);
    map.accel[s]    = +(STAT_BASE.accel    * s / m).toFixed(1);
    map.mass[s]     = +(STAT_BASE.mass     * s / m).toFixed(1);
    map.handling[s] = +(STAT_BASE.handling * s / m).toFixed(2);
  }
  return map;
}
export const STAT_MAP = _buildStatMap();

// ── Cars ─────────────────────────────────────────────────────────────
export const CARS = {
  FANG: {
    name: 'FANG',
    subtitle: 'Muscle Car',
    stats: { speed: 6, mass: 5, handling: 4 },
    ability: {
      name: 'NITRO',
      description: 'Burst of speed (1.8× for 1.5s)',
      multiplier: 1.8,
      duration: 1.5,
      cooldown: 6,
    },
    color: 0xdc143c, // Cherry Red
    shape: 'muscle',
  },
  HORNET: {
    name: 'HORNET',
    subtitle: 'Go-Kart',
    stats: { speed: 7, mass: 2, handling: 6 },
    ability: {
      name: 'DASH',
      description: 'Instant short-range teleport forward (5 units)',
      distance: 5,
      cooldown: 4,
    },
    color: 0xffd700, // Electric Yellow
    shape: 'kart',
  },
  RHINO: {
    name: 'RHINO',
    subtitle: 'Armored Truck',
    stats: { speed: 3, mass: 8, handling: 4 },
    ability: {
      name: 'RAM',
      description: '2s of infinite mass + slight speed boost',
      duration: 2,
      infiniteMass: 999,
      cooldown: 8,
    },
    color: 0x6e7b8b, // Gunmetal Grey
    shape: 'truck',
  },
  VIPER: {
    name: 'VIPER',
    subtitle: 'Formula Racer',
    stats: { speed: 8, mass: 3, handling: 4 },
    ability: {
      name: 'TRAIL',
      description: '3s speed boost (1.5×) + damaging fire trail',
      multiplier: 1.5,
      duration: 3,
      cooldown: 7,
    },
    color: 0x39ff14, // Neon Green
    shape: 'formula',
  },
  TOAD: {
    name: 'TOAD',
    subtitle: 'Van',
    stats: { speed: 4, mass: 6, handling: 5 },
    ability: {
      name: 'PULSE',
      description: 'Radial knockback (8 unit radius, strong force)',
      radius: 8,
      cooldown: 6,
    },
    color: 0x7b2d8b, // Deep Purple
    shape: 'van',
  },
  LYNX: {
    name: 'LYNX',
    subtitle: 'Hatchback',
    stats: { speed: 5, mass: 4, handling: 6 },
    ability: {
      name: 'DRIFT',
      description: '2s zero-friction turning + speed maintained',
      duration: 2,
      cooldown: 5,
    },
    color: 0x1e90ff, // Ocean Blue
    shape: 'cabrio',
  },
  MAMMOTH: {
    name: 'MAMMOTH',
    subtitle: 'Tractor',
    stats: { speed: 4, mass: 7, handling: 4 },
    ability: {
      name: 'LEAP',
      description: 'Jump up, radial shockwave on landing',
      shockwaveRadius: 6,
      shockwaveForce: 200,
      cooldown: 7,
    },
    color: 0xcc5500, // Burnt Orange
    shape: 'monster',
  },
  GHOST: {
    name: 'GHOST',
    subtitle: 'Cyber Car',
    stats: { speed: 6, mass: 3, handling: 6 },
    ability: {
      name: 'PHASE',
      description: '0.8s intangibility (pass through cars)',
      duration: 0.8,
      cooldown: 5,
    },
    color: 0xe0e8ff, // Ice White
    shape: 'cyber',
  },
};

// Ordered list for UI carousel
export const CAR_ORDER = ['FANG', 'HORNET', 'RHINO', 'VIPER', 'TOAD', 'LYNX', 'MAMMOTH', 'GHOST'];

// ── Arena (Volcano Flat — single octagonal platform) ─────────────────
export const ARENA = {
  shape: 'volcano_flat',
  diameter: 120,

  lava: {
    radius: 10,          // central lava pool
    killTime: 2.0,       // seconds of contact to die
  },

  // Static rock obstacles (pillars + boulders)
  rockObstacles: {
    // Tall pillars near the lava rim
    pillars: [
      { angle: 0.4,   dist: 16, height: 5.5, baseRadius: 1.8 },
      { angle: 1.6,   dist: 18, height: 7.0, baseRadius: 2.0 },
      { angle: 2.8,   dist: 15, height: 4.5, baseRadius: 1.6 },
      { angle: 4.2,   dist: 17, height: 6.0, baseRadius: 1.9 },
      { angle: 5.5,   dist: 19, height: 5.0, baseRadius: 1.7 },
    ],
    // Scattered boulders across the arena
    boulders: [
      { angle: 0.9,  dist: 28, radius: 2.0 },
      { angle: 1.2,  dist: 40, radius: 1.5 },
      { angle: 2.1,  dist: 35, radius: 2.5 },
      { angle: 2.6,  dist: 22, radius: 1.8 },
      { angle: 3.3,  dist: 45, radius: 1.4 },
      { angle: 3.8,  dist: 30, radius: 2.2 },
      { angle: 4.5,  dist: 38, radius: 1.6 },
      { angle: 5.0,  dist: 25, radius: 2.0 },
      { angle: 5.8,  dist: 42, radius: 1.3 },
      { angle: 0.1,  dist: 50, radius: 1.7 },
      { angle: 1.8,  dist: 48, radius: 1.9 },
      { angle: 3.0,  dist: 52, radius: 1.5 },
    ],
  },

  // Lava eruptions (radial shockwave from center)
  eruption: {
    interval: 20,        // seconds between eruptions
    warningTime: 2,      // seconds of warning before blast
    force: 25,           // outward push force
    radius: 50,          // max reach

    // ── Visual & audio FX ──
    fx: {
      // Warning phase (2s before blast)
      warning: {
        lavaGlowTarget: 5.0,    // emissive intensity peak
        lavaGlowSpeed: 2.0,     // how fast glow ramps up
        bubbleSpeedMult: 3.0,   // lava bubbles accelerate
        pulseSpeed: 4,          // pulsing frequency during warning
        pulseAmount: 0.8,       // pulsing amplitude
      },

      // Lava surge particles (burst upward from pool at eruption)
      surge: {
        count: 30,              // particles in the burst
        size: 1.2,
        launchSpeed: 18,        // upward velocity
        launchSpeedVariance: 8,
        spreadSpeed: 6,         // horizontal spread
        gravity: 10,
        lifetime: 2.5,
      },

      // Debris chunks (larger arcing pieces)
      debris: {
        count: 8,               // instanced mesh pool
        radius: 0.25,
        launchSpeed: 8,
        launchSpeedVariance: 4,
        launchUpSpeed: 12,
        launchUpVariance: 6,
        gravity: 10,
        lifetime: 2.0,
      },

      // Screen flash (brief white-orange flash at eruption moment)
      flash: {
        duration: 0.25,         // seconds
        color: 0xff6622,
        maxOpacity: 0.35,
      },

      // Enhanced shockwave ring
      ring: {
        duration: 1.0,          // seconds (was 0.8)
        segments: 48,
        innerRadius: 2,
        outerRadius: 5,
      },

      // Camera shake
      cameraShake: {
        intensity: 0.012,       // 4x stronger than geyser shake
        duration: 400,          // ms
        falloffStart: 30,       // distance where shake starts to fade
        falloffEnd: 60,         // distance where shake is zero
      },
    },
  },

  // Random geysers
  geysers: {
    count: 6,            // active geysers at any time
    lifetime: 3,         // seconds a geyser stays active
    cooldown: 5,         // seconds before new geyser spawns in that slot
    radius: 2.5,         // geyser effect radius
    launchForce: 15,     // upward push
    warningTime: 1.5,    // seconds of ground glow before eruption

    // ── Visual FX parameters ──
    fx: {
      // Steam particles (warning + active phases)
      steam: {
        count: 10,             // particles per geyser (perf: reduced from 18)
        size: 1.4,             // point size (larger to compensate fewer particles)
        riseSpeed: 2.5,        // base upward speed (units/s)
        riseSpeedVariance: 1.5,
        driftSpeed: 0.8,       // horizontal wander
        spawnRadius: 1.2,      // spread around geyser center
        lifetime: 1.8,         // seconds per particle
        lifetimeVariance: 0.8,
        spawnStagger: 0.6,     // stagger initial spawns over this duration
        activeSpeedMultiplier: 2.2, // faster during eruption
        lingerTime: 1.5,       // seconds steam persists into cooldown
      },

      // Lava fountain particles (active phase)
      fountain: {
        count: 20,             // particles per geyser (perf: reduced from 35)
        size: 0.9,             // point size (larger to compensate)
        launchSpeed: 12,       // base upward velocity
        launchSpeedVariance: 5,
        spreadSpeed: 2.5,      // horizontal spread velocity
        gravity: 14,           // downward acceleration
        lifetime: 2.0,
        lifetimeVariance: 0.6,
        spawnStagger: 0.4,
      },

      // Lava droplets (small arcing spheres — InstancedMesh pool)
      droplets: {
        countPerGeyser: 4,     // per geyser (perf: reduced from 6)
        radius: 0.14,          // sphere radius (slightly larger)
        launchSpeed: 3.5,      // outward horizontal speed
        launchSpeedVariance: 2.0,
        launchUpSpeed: 6,      // initial upward speed
        launchUpVariance: 3,
        gravity: 12,
        lifetime: 1.5,
        scaleMin: 0.7,
        scaleMax: 1.5,
      },

      // Splash ring (eruption moment)
      splash: {
        duration: 0.6,         // seconds for ring to expand and fade
        startScale: 0.3,
        endScale: 3.5,
        initialOpacity: 0.85,
      },

      // Multi-layer eruption column
      column: {
        layers: 2,             // concentric cylinders (perf: reduced from 3)
        baseRadius: 0.9,       // inner column radius
        height: 7,             // column height
        opacities: [0.85, 0.35], // per layer (inner → outer)
        radiusScale: [1.0, 2.0],  // per layer multiplier
        wobbleSpeed: 3.5,      // oscillation frequency
        wobbleAmount: 0.15,    // lateral sway
        riseSpeed: 4.0,        // how fast column appears (scale Y per second)
        shrinkSpeed: 3.0,      // how fast column disappears
      },

      // Ground crack pattern (warning phase) — single merged mesh per geyser
      cracks: {
        count: 5,              // radial crack lines (merged into one mesh)
        length: 2.8,           // how far cracks extend
        width: 0.08,
        height: 0.04,
        growSpeed: 2.5,        // scale growth rate during warning
      },

      // Warning ring (pulsing ground ring)
      warningRing: {
        innerRadius: 1.8,
        outerRadius: 2.3,
        pulseSpeed: 6,         // oscillation frequency
        pulseAmount: 0.15,     // scale variation
      },

      // Shared geyser lights (2 pooled lights, not 6)
      light: {
        poolSize: 2,           // max simultaneous lights (perf: was 6)
        warningColor: 0xff6600,
        warningIntensity: 1.2,
        activeColor: 0xff4400,
        activeIntensity: 3.0,
        range: 10,
        height: 2.5,
        flickerSpeed: 8,
        flickerAmount: 0.3,
        fadeOutTime: 1.0,      // seconds to fade during cooldown
      },

      // Scorch mark (burned ground)
      scorch: {
        radius: 3.0,           // scorch mark size
        fadeDelay: 2.0,        // seconds before fading starts
        fadeDuration: 3.0,     // seconds to fully fade
        emissiveIntensity: 1.2,
        emissiveFadeSpeed: 0.5, // emissive dims faster than texture
      },

      // Camera shake (only when geyser is near player)
      cameraShake: {
        maxDistance: 15,        // beyond this, no shake
        intensity: 0.003,      // shake magnitude
        duration: 150,         // milliseconds
      },
    },
  },

  boostPadCount: 8,
  boostPadImpulse: 10,
  boostPadCooldownPerCar: 1,
  powerupPedestalCount: 6,
  powerupRespawnTime: 8,
};

// ── Theme (Volcano palette) ─────────────────────────────────────────
export const THEME = {
  surface: 0x2a1a0e,
  surfaceLight: 0x3a2a1e,
  rockColor: 0x1a1a1a,
  lavaColor: 0xff4400,
  lavaEmissive: 0xff2200,
  edgeGlow: 0xff4400,
  edgeTube: 0xff6600,
  ambientColor: 0x331100,
  sunColor: 0xffaa66,
  fogColor: 0x1a0e08,
  skyBackground: 0x1a0e08,
  boostPad: 0xffcc00,
  ember: 0xff6600,
  geyserWarning: 0xff6600,
  geyserActive: 0xff3300,
};

// ── Damage / HP System ──────────────────────────────────────────────
export const DAMAGE = {
  BASE_DAMAGE: 8,          // base damage per collision
  REF_SPEED: 15,           // reference relative speed (u/s) — at 15 u/s velocityFactor = 1.0
  MIN_SPEED: 3,            // below this relative speed: zero damage
  MIN_DAMAGE: 2,           // minimum damage if speed threshold is met
  MAX_DAMAGE: 45,          // cap per single hit (prevents one-shots)

  // Impact angle multiplier range
  ANGLE_MIN: 0.3,          // glancing blow (90°)
  ANGLE_MAX: 1.0,          // head-on (0° / 180°)

  // Armor: victim mass reduces incoming damage
  ARMOR_FACTOR: 0.08,      // damage / (1 + victimMass * ARMOR_FACTOR)

  // HP
  MAX_HP: 100,

  // Environmental damage
  LAVA_DPS: 20,            // damage per second in lava pool
  GEYSER_DAMAGE: 15,       // instant damage from geyser eruption
  FALL_DAMAGE: 25,         // damage from falling off edge (+ respawn)
  OBSTACLE_DAMAGE: 5,      // damage from pillar/boulder impact

  // Ability damage
  TRAIL_DAMAGE: 12,        // VIPER trail fire (single touch)
  PULSE_DAMAGE: 8,         // TOAD radial knockback
  LEAP_DAMAGE: 15,         // MAMMOTH landing shockwave

  // Hit tier thresholds (for VFX feedback, not scoring)
  hitThresholds: {
    light: 3,              // min relative speed for any damage
    heavy: 12,             // heavy hit VFX
    devastating: 25,       // devastating hit VFX
  },

  // Per-pair damage cooldown (prevents continuous damage when pushing)
  PAIR_COOLDOWN: 1.0,      // seconds — same pair can't deal damage again for this long
  BOUNCE_IMPULSE: 5,       // separation impulse on damage hit (u/s, applied to each car outward)
};

// ── Round / Timing ───────────────────────────────────────────────────
export const ROUND = {
  lobbyMin: 5,        // seconds
  lobbyMax: 30,
  countdown: 3,
  playTime: 180,
  resultsTime: 8,
  noRespawnLastSeconds: 10,
};

// ── Respawn ──────────────────────────────────────────────────────────
export const RESPAWN = {
  deathCamDuration: 2,     // seconds
  invincibilityDuration: 1.5,
  fallOffY: -5,            // Y threshold for "fell off"
};

// ── KO Attribution ───────────────────────────────────────────────────
export const KO_ATTRIBUTION = {
  windowSeconds: 3, // lastHitBy must be within this window
};

// ── Physics ──────────────────────────────────────────────────────────
export const PHYSICS = {
  maxVelocity: 45,        // u/s global cap (lowered to match new speed range)
  networkSendRate: 20,    // Hz
};

// ── Obstacle Stun (boulder / pillar collision) ──────────────────────
export const OBSTACLE_STUN = {
  // Minimum speed for stun + damage; below this → soft bounce only
  minStunSpeed: 8,        // u/s — gentle contact just bounces off

  // Stun duration scales with impact speed
  minDuration: 0.5,       // seconds — light tap
  maxDuration: 1.5,       // seconds — full speed crash
  speedForMaxStun: 25,    // u/s — at this speed or above, max stun duration

  // Physics response on impact
  bounceForce: 3,         // gentle push-away (replaces old speed*0.6)
  speedKill: 0.95,        // kill 95% of car speed on impact
  pushOut: 0.4,           // positional push to prevent sticking (units)

  // Stun behaviour
  spinRate: 8,            // rad/s — dizzy spin while stunned
  wobbleFreq: 12,         // Hz — visual wobble frequency
  wobbleAmplitude: 0.08,  // rad — max roll wobble angle

  // Immunity after stun ends (prevents chain-stuns from sliding along obstacle)
  immunityDuration: 0.3,  // seconds

  // Camera shake on impact
  cameraShake: {
    intensity: 0.015,
    duration: 250,        // ms
  },

  // Visual FX
  fx: {
    // Rock debris particles at impact point
    debrisCount: 8,
    debrisSize: 0.15,
    debrisSpeed: 4,
    debrisLifetime: 0.8,
    debrisColor: 0x8B7355,

    // Orbiting stars/sparkles around stunned car
    starCount: 5,
    starSize: 0.25,
    starOrbitRadius: 1.8,
    starOrbitSpeed: 6,     // rad/s
    starColor: 0xFFDD44,

    // Impact flash on car
    flashDuration: 0.15,   // seconds
    flashColor: 0xFFFFFF,
    flashIntensity: 3.0,
  },
};

// ── Car Feel — visual + handling dynamics ─────────────────────────────
// Drift-style kinematic model: heading rotates proportionally to speed,
// velocity blends toward facing direction via lateral friction.
// At zero speed → zero turning. Smooth, natural drift feel.
export const CAR_FEEL = {
  // ── Steering ──
  // maxSteerAngle: per-frame steering increment (rad) — like Drift Zero's maxSteer
  maxSteerAngle: 0.095,      // max steer per frame (rad) — tuned for arcade feel
  steerSpeed: 0.14,          // interpolation factor toward target steer (per frame at 60fps)
  steerReturnSpeed: 0.09,    // how fast steer self-centers when no input
  // High-speed steering reduction (understeer) — at max speed, steer is scaled by this
  steerAtSpeed: 0.40,        // 0=no reduction, 1=zero steer at max speed

  // ── Heading rotation ──
  // heading += steerAngle * (speed/maxSpeed) * direction * dt*60
  // No bicycle model — simpler, more predictable, better drift feel.
  minTurnSpeed: 0.2,         // u/s — minimum speed to produce any turning

  // ── Acceleration ──
  accelRate: 22,             // u/s² fallback (per-car overrides via CarBody.accelRate)
  accelFalloffStart: 0.65,   // start tapering at 65% of max speed
  accelFalloffMin: 0.25,     // at max speed, accel is 25% of base

  // ── Braking ──
  brakeDecel: 30,            // u/s² braking force
  reverseAccel: 10,          // u/s² reverse acceleration
  reverseMaxFactor: 0.35,    // max reverse speed = 35% of forward max

  // ── Friction (multiplicative per-frame, like Drift Zero) ──
  // Applied as speed *= pow(factor, dt*60). Values < 1 = friction.
  drag: 0.993,               // aero drag when accelerating/braking (very light)
  groundFriction: 0.955,     // rolling friction when coasting (moderate decel)

  // ── Lateral friction (drift model) ──
  // velocity blends toward desired (heading-aligned) velocity each frame.
  // lateralFriction < 1 = the car slides laterally (drifts).
  // lf = pow(lateralFriction, dt*60); vel = vel*lf + desired*(1-lf)
  lateralFriction: 0.94,     // base lateral grip (lower = more drift)

  // ── Drift mode tuning (LYNX ability + general drift feel) ──
  driftLateralFriction: 0.70, // much lower grip during drift ability
  driftSteerMultiplier: 1.5,  // wider steer angle during drift
  driftDragOverride: 0.985,   // less speed loss during drift

  // Visual body roll on turning (applied to mesh, not physics)
  roll: {
    maxAngle: 0.06,          // ~3.4° max roll
    speedInfluence: 1.0,
    massDamping: 0.4,
    smoothing: 10,
  },

  // Visual pitch on accel/brake (applied to mesh, not physics)
  pitch: {
    accelAngle: -0.015,      // ~0.9° nose-up on accel
    brakeAngle: 0.03,        // ~1.7° nose-down on brake
    smoothing: 8,
  },

  // ── Dynamic camera ──
  camera: {
    followDist: 6,
    height: 3.5,
    lookAhead: 5,
    followSmoothing: 0.07,

    baseFOV: 40,
    maxFOVBoost: 8,
    fovSmoothing: 4,

    steerOffsetMax: 2.5,
    steerOffsetSmoothing: 5,

    steerTiltMax: 0.025,
    steerTiltSmoothing: 6,

    speedPullback: 5,
  },
};

// ── Engine Audio ─────────────────────────────────────────────────────
// Procedural engine sounds — each car type has a unique sonic profile.
// baseFreq: fundamental oscillator pitch at idle (Hz)
// maxFreq: pitch at full speed (Hz)
// oscillators: array of { type, freqRatio, gain } — layered harmonics
// noiseGain: filtered noise level (mechanical rumble)
// noiseLPF: low-pass cutoff for noise (Hz)
// volume: base gain for this car's engine
export const ENGINE_AUDIO = {
  masterVolume: 0.07,            // overall engine volume (background level)
  localBoost: 2.0,               // local player volume multiplier
  spatialMaxDist: 50,            // beyond this, bot engine is silent
  spatialRefDist: 8,             // distance where bot volume is 1.0
  rpmSmoothing: 8,               // how fast pitch tracks speed (higher = faster)
  toneLPF: 1200,                 // master low-pass filter cutoff to soften harsh harmonics

  profiles: {
    FANG: {
      // Muscle car — deep V8 rumble, two-stroke pulse feel
      baseFreq: 55, maxFreq: 180,
      oscillators: [
        { type: 'sawtooth', freqRatio: 1.0, gain: 0.12, detune: -5 },
        { type: 'square', freqRatio: 0.5, gain: 0.08, detune: 3 },
        { type: 'sawtooth', freqRatio: 2.0, gain: 0.03, detune: -8 },
      ],
      noiseGain: 0.025, noiseLPF: 350,
      toneLPF: 900, // darker muscle car tone
    },
    HORNET: {
      // Go-kart — small engine, high-pitched buzz
      baseFreq: 120, maxFreq: 440,
      oscillators: [
        { type: 'square', freqRatio: 1.0, gain: 0.09, detune: 4 },
        { type: 'square', freqRatio: 2.01, gain: 0.06, detune: -6 },
        { type: 'sawtooth', freqRatio: 3.0, gain: 0.02, detune: 7 },
      ],
      noiseGain: 0.012, noiseLPF: 1600,
      toneLPF: 1800,
    },
    RHINO: {
      // Armored truck — heavy diesel, low throb
      baseFreq: 38, maxFreq: 110,
      oscillators: [
        { type: 'sawtooth', freqRatio: 1.0, gain: 0.13, detune: -3 },
        { type: 'triangle', freqRatio: 0.5, gain: 0.09, detune: 5 },
        { type: 'square', freqRatio: 1.5, gain: 0.03, detune: -7 },
      ],
      noiseGain: 0.035, noiseLPF: 280,
      toneLPF: 700,
    },
    VIPER: {
      // Formula racer — high-revving scream
      baseFreq: 100, maxFreq: 520,
      oscillators: [
        { type: 'sawtooth', freqRatio: 1.0, gain: 0.09, detune: 6 },
        { type: 'sawtooth', freqRatio: 2.0, gain: 0.06, detune: -4 },
        { type: 'sine', freqRatio: 4.0, gain: 0.02, detune: 0 },
      ],
      noiseGain: 0.018, noiseLPF: 2500,
      toneLPF: 2200, // brighter for racer whine
    },
    TOAD: {
      // Van — mid-range flat engine tone
      baseFreq: 65, maxFreq: 180,
      oscillators: [
        { type: 'triangle', freqRatio: 1.0, gain: 0.10, detune: -4 },
        { type: 'square', freqRatio: 1.0, gain: 0.05, detune: 6 },
        { type: 'sawtooth', freqRatio: 2.0, gain: 0.02, detune: -3 },
      ],
      noiseGain: 0.025, noiseLPF: 450,
      toneLPF: 1000,
    },
    LYNX: {
      // Sporty hatchback — 4-cylinder punchy
      baseFreq: 80, maxFreq: 340,
      oscillators: [
        { type: 'sawtooth', freqRatio: 1.0, gain: 0.09, detune: 5 },
        { type: 'square', freqRatio: 2.0, gain: 0.05, detune: -7 },
        { type: 'triangle', freqRatio: 0.5, gain: 0.04, detune: 3 },
      ],
      noiseGain: 0.018, noiseLPF: 700,
      toneLPF: 1400,
    },
    MAMMOTH: {
      // Tractor — slow deep diesel chug
      baseFreq: 30, maxFreq: 85,
      oscillators: [
        { type: 'sawtooth', freqRatio: 1.0, gain: 0.14, detune: -6 },
        { type: 'square', freqRatio: 0.5, gain: 0.09, detune: 4 },
        { type: 'triangle', freqRatio: 1.5, gain: 0.03, detune: -5 },
      ],
      noiseGain: 0.04, noiseLPF: 220,
      toneLPF: 600, // very dark, rumbly
    },
    GHOST: {
      // Cyber car — electric whine, sine-heavy
      baseFreq: 150, maxFreq: 800,
      oscillators: [
        { type: 'sine', freqRatio: 1.0, gain: 0.10, detune: 2 },
        { type: 'sine', freqRatio: 2.01, gain: 0.06, detune: -3 },
        { type: 'triangle', freqRatio: 0.5, gain: 0.02, detune: 5 },
      ],
      noiseGain: 0.006, noiseLPF: 4000,
      toneLPF: 3500, // cleanest/brightest — electric car
    },
  },
};

// ── Collision Filter Groups (bitmask) ────────────────────────────────
export const COLLISION_GROUPS = {
  ARENA:  1,
  CAR:    2,
  PICKUP: 4,
  TRAIL:  8,
  MISSILE: 16,
};

// ── Power-ups ────────────────────────────────────────────────────────
export const POWERUPS = {
  MISSILE: {
    name: 'Missile',
    color: 0xff4400,        // Orange-red
    icon: '/assets/icons/Missile.png',
    damage: 30,
    speedBonus: 0.15,       // 15% faster than car speed
    accel: 60,              // acceleration (u/s²) — faster than any car
    lifetime: 4,            // seconds before self-destruct
    radius: 0.3,            // collision radius
  },
  HOMING_MISSILE: {
    name: 'Homing Missile',
    color: 0xff0066,        // Hot pink
    icon: '/assets/icons/HomingMissile.png',
    damage: 30,
    straightTime: 0.1,      // seconds flying straight before homing
    turnRate: 2.8,          // rad/s max turn rate (fallible — can be dodged)
    speed: 28,              // fixed speed (u/s)
    lifetime: 5,            // seconds before self-destruct
    radius: 0.3,
    seekRadius: 80,         // max distance to acquire target
    losAngle: Math.PI * 0.6, // ~108° — missile loses lock outside this cone
    reacquireDelay: 0.5,    // seconds before re-acquiring after losing lock
  },
  SHIELD: {
    name: 'Shield',
    color: 0x00ff88,        // Green
    icon: '/assets/icons/Shield.png',
    damageReduction: 0.5,   // halves incoming damage
    duration: 5,            // seconds
  },
  REPAIR_KIT: {
    name: 'Repair Kit',
    color: 0x44ff44,        // Bright green
    icon: '/assets/icons/RepairKit.png',
    heal: 30,               // instant HP restored (capped at maxHp)
  },
  HOLO_EVADE: {
    name: 'Holo Evade',
    color: 0x00ccff,        // Cyan
    icon: '/assets/icons/HoloEvade.png',
    duration: 1.0,          // seconds decoys are active
    fadeOutTime: 0.3,        // seconds for decoys to fade after duration
    decoyCount: 2,           // number of holographic copies
    decoySpeedFactor: 1.0,   // decoys move at same speed as car
    decoySpreadAngle: Math.PI / 2, // ±90° max spread from car forward
    missileConfuseChance: 0.5, // 50% chance homing re-targets a decoy
    carOpacity: 0.35,        // car transparency while active
  },
  AUTO_TURRET: {
    name: 'Auto Turret',
    color: 0xffaa00,        // Warm orange
    icon: '/assets/icons/Turret.png',
    duration: 6,            // seconds turret is active
    fireRate: 0.8,          // seconds between shots
    damage: 8,              // per bullet (low but sustained)
    range: 25,              // target acquisition radius (u)
    bulletSpeed: 35,        // projectile speed (u/s)
    bulletLifetime: 1.5,    // seconds before bullet self-destructs
    bulletRadius: 0.4,      // collision radius
    knockback: 1.5,         // impulse on hit (very low)
    turnRate: 4.0,          // turret yaw rotation speed (rad/s)
  },
  GLITCH_BOMB: {
    name: 'Glitch Bomb',
    color: 0x00ff41,        // Matrix green
    icon: '/assets/icons/RetroBomb.png',
    duration: 5,            // seconds glitch effect lasts on victims
    blastRadius: 18,        // area of effect around detonation (u)
    damage: 10,             // light damage on detonation
    scanlineIntensity: 0.7, // CRT scanline opacity
    rgbShiftAmount: 8,      // pixel offset for chromatic aberration
    noiseIntensity: 0.4,    // static noise overlay opacity
    tearFrequency: 3,       // screen tears per second
  },
};

// ── Power-up spawn weights (higher = more common) ────────────────────
export const POWERUP_WEIGHTS = {
  MISSILE: 22,
  HOMING_MISSILE: 18,
  SHIELD: 18,
  REPAIR_KIT: 18,
  HOLO_EVADE: 12,
  AUTO_TURRET: 12,
  GLITCH_BOMB: 6,           // Rare — powerful area denial
};

// ── Shield vs RAM ────────────────────────────────────────────────────
export const SHIELD_VS_RAM = {
  forceAbsorption: 0.5, // Shield absorbs 50% of RAM force
};

// ── Players / Bots ───────────────────────────────────────────────────
export const PLAYERS = {
  maxPerRoom: 8,
  nicknameMaxLength: 12,
  nicknameDefault: 'PLAYER',
};

/**
 * Get spawn position for car at a given slot index (0-7).
 * Places 8 cars at the 8 octagon vertices, facing center.
 * @param {number} index — slot 0-7
 * @returns {{ x: number, y: number, z: number, yaw: number }}
 */
export function getSpawnPosition(index) {
  const SPAWN_RADIUS = ARENA.diameter / 2 * 0.72; // 72% of arena radius
  const angle = (index / PLAYERS.maxPerRoom) * Math.PI * 2;
  const x = Math.cos(angle) * SPAWN_RADIUS;
  const z = Math.sin(angle) * SPAWN_RADIUS;
  // Face toward center: forward is (-sin(yaw), -cos(yaw)), we need it to point at (0,0)
  // Direction to center = (-x, -z), so: -sin(yaw) = -x → sin(yaw) = x, -cos(yaw) = -z → cos(yaw) = z
  const yaw = Math.atan2(x, z);
  return { x, y: 0.6, z, yaw };
}

export const BOTS = {
  names: ['TURBO', 'BLAZE', 'NITRO', 'CRASH', 'FURY', 'BOLT', 'HAVOC', 'STORM'],
  personalities: ['Aggressive', 'Defensive', 'Kamikaze', 'Hunter', 'Brawler', 'Trickster', 'Survivor', 'Hothead'],
};

// ── Game States ──────────────────────────────────────────────────────
export const GAME_STATES = {
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  RESULTS: 'RESULTS',
};
