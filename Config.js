/**
 * 🚀 ROCKET BUMPERS — All tunables in one place
 * Reference: GAME_DESIGN.md
 */

// ─── Stat Points → Real Values Mapping ─────────────
const SPEED_MAP  = { 2: 20, 3: 24, 4: 28, 5: 32, 6: 36, 7: 40, 8: 44 };
const MASS_MAP   = { 2: 3,  3: 4,  4: 5,  5: 6,  6: 7,  7: 8,  8: 9  };
const HANDLE_MAP = { 2: 2.0, 3: 2.5, 4: 3.0, 5: 3.5, 6: 4.0, 7: 4.5, 8: 5.0 };

export const CONFIG = {

  // ─── Cars ─────────────────────────────────────────
  CARS: {
    FANG: {
      name: 'FANG',
      subtitle: 'Muscle Car',
      description: 'The all-rounder. Good first pick.',
      stats: { speed: 6, mass: 5, handling: 4 },
      defaultColor: 0xff3333,
      ability: {
        name: 'NITRO',
        description: 'Burst of speed (1.8× for 1.5s)',
        type: 'NITRO',
        cooldown: 6,
        duration: 1.5,
        speedMultiplier: 1.8,
      },
    },
    HORNET: {
      name: 'HORNET',
      subtitle: 'Go-Kart',
      description: 'Blazing fast, flies off on impact. High risk high reward.',
      stats: { speed: 7, mass: 2, handling: 6 },
      defaultColor: 0xffee33,
      ability: {
        name: 'DASH',
        description: 'Instant teleport forward (5 units)',
        type: 'DASH',
        cooldown: 4,
        distance: 5,
      },
    },
    RHINO: {
      name: 'RHINO',
      subtitle: 'Armored Truck',
      description: 'Slow bulldozer. When RAM is active, nothing stops you.',
      stats: { speed: 3, mass: 8, handling: 4 },
      defaultColor: 0x888899,
      ability: {
        name: 'RAM',
        description: 'Infinite mass + speed boost (2s)',
        type: 'RAM',
        cooldown: 8,
        duration: 2,
        massOverride: 999,
        speedBoost: 1.3,
      },
    },
    VIPER: {
      name: 'VIPER',
      subtitle: 'Formula Racer',
      description: 'Fastest car. Pure glass cannon.',
      stats: { speed: 8, mass: 3, handling: 4 },
      defaultColor: 0x33ff55,
      ability: {
        name: 'TRAIL',
        description: 'Speed boost + damaging fire trail (3s)',
        type: 'TRAIL',
        cooldown: 7,
        duration: 3,
        speedMultiplier: 1.5,
        trailInterval: 0.3,
        trailLifetime: 2,
        trailKnockback: 150,
      },
    },
    TOAD: {
      name: 'TOAD',
      subtitle: 'Van',
      description: 'Tanky and nimble. PULSE clears space around you.',
      stats: { speed: 4, mass: 6, handling: 5 },
      defaultColor: 0x8833cc,
      ability: {
        name: 'PULSE',
        description: 'Radial knockback (8 unit radius)',
        type: 'PULSE',
        cooldown: 6,
        radius: 8,
        force: 300,
      },
    },
    LYNX: {
      name: 'LYNX',
      subtitle: 'Hatchback',
      description: 'The skill car. Master DRIFT to weave through chaos.',
      stats: { speed: 5, mass: 4, handling: 6 },
      defaultColor: 0x3388ff,
      ability: {
        name: 'DRIFT',
        description: 'Zero-friction turns + keep speed (2s)',
        type: 'DRIFT',
        cooldown: 5,
        duration: 2,
      },
    },
    MAMMOTH: {
      name: 'MAMMOTH',
      subtitle: 'Tractor',
      description: 'Airborne chaos. LEAP over enemies, crush them on landing.',
      stats: { speed: 4, mass: 7, handling: 4 },
      defaultColor: 0xff8833,
      ability: {
        name: 'LEAP',
        description: 'Jump up, shockwave on landing',
        type: 'LEAP',
        cooldown: 7,
        jumpImpulse: 12,
        landingRadius: 6,
        landingForce: 200,
        // Track isLeaping flag; trigger shockwave on floor collision event
        // Landing shockwave updates victims' lastHitBy for KO attribution
      },
    },
    GHOST: {
      name: 'GHOST',
      subtitle: 'Cyber Car',
      description: 'Dodge anything. Time PHASE to avoid hits.',
      stats: { speed: 6, mass: 3, handling: 6 },
      defaultColor: 0xeeeeff,
      ability: {
        name: 'PHASE',
        description: 'Intangible for 0.8s (pass through cars, arena still solid)',
        type: 'PHASE',
        cooldown: 5,
        duration: 0.8,
        // Uses PHASE_COLLISION_MASK from PHYSICS — keeps arena collision, disables car/pickup/trail
      },
    },
  },

  // Helper: get real physics values from stat points
  getCarPhysics(carType) {
    const car = this.CARS[carType];
    if (!car) throw new Error(`Unknown car type: ${carType}`);
    return {
      maxSpeed: SPEED_MAP[car.stats.speed],
      mass: MASS_MAP[car.stats.mass],
      turnSpeed: HANDLE_MAP[car.stats.handling],
      acceleration: 40,          // same for all
      brakeDeceleration: 60,     // same for all
    };
  },

  // Car list for UI iteration
  CAR_ORDER: ['FANG', 'HORNET', 'RHINO', 'VIPER', 'TOAD', 'LYNX', 'MAMMOTH', 'GHOST'],

  // Player colors (assigned by server, separate from car default color)
  PLAYER_COLORS: [
    0xff3333, 0x33ff33, 0x3333ff, 0xffff33,
    0xff33ff, 0x33ffff, 0xff8833, 0x8833ff,
    0xff3388, 0x33ff88, 0x88ff33, 0xffffff,
  ],

  // ─── Arena ────────────────────────────────────────
  ARENA: {
    DIAMETER: 80,
    SIDES: 8,
    RAMP_COUNT: 4,
    RAMP_ANGLE_DEG: 15,
    RAMP_LENGTH: 10,
    BOOST_PAD_COUNT: 8,
    POWERUP_PEDESTAL_COUNT: 6,
    FALL_THRESHOLD_Y: -5,
    EDGE_GLOW_COLOR: 0x00ffff,
    SURFACE_COLOR: 0x111118,
    BOOST_PAD_COLOR: 0xff8800,
    BOOST_PAD_IMPULSE: 15,        // u/s added in car's forward direction
    BOOST_PAD_CAR_COOLDOWN: 1,    // seconds before same car can re-trigger same pad
  },

  // ─── Camera ───────────────────────────────────────
  CAMERA: {
    OFFSET_BACK: 8,
    OFFSET_UP: 5,
    LOOK_AHEAD: 3,
    LERP_FACTOR: 0.08,
    SHAKE_DECAY: 0.3,
    SHAKE_INTENSITY: { SMALL: 0.1, BIG: 0.3, MEGA: 0.5 },
  },

  // ─── Scoring ──────────────────────────────────────
  SCORING: {
    HIT_THRESHOLD_SMALL: 5,
    HIT_THRESHOLD_BIG: 15,
    HIT_THRESHOLD_MEGA: 25,
    POINTS_SMALL: 10,
    POINTS_BIG: 25,
    POINTS_MEGA: 50,
    POINTS_KNOCKOUT: 100,
    POINTS_FELL: -50,
    POINTS_POWERUP_KILL: 30,
    POINTS_ABILITY_KO: 75,
    KO_ATTRIBUTION_WINDOW: 3,     // seconds — if victim falls within this time after hit, attacker gets KO credit
    SHIELD_VS_RAM_REDUCTION: 0.5, // Shield absorbs this fraction of RAM force (RAM partially overrides Shield)
  },

  // ─── Power-ups (arena pickups) ────────────────────
  POWERUPS: {
    RESPAWN_TIME: 8,
    TYPES: {
      ROCKET_BOOST: { color: 0xff8800, duration: 2, speedMultiplier: 2 },
      SHOCKWAVE:    { color: 0x4488ff, radius: 15, force: 500 },
      SHIELD:       { color: 0x33ff33, duration: 4, massMultiplier: 2 },
      MAGNET:       { color: 0xaa33ff, duration: 3, radius: 8 },
    },
  },

  // ─── Round ────────────────────────────────────────
  ROUND: {
    LOBBY_MIN_WAIT: 5,
    LOBBY_MAX_WAIT: 30,
    COUNTDOWN_DURATION: 3,
    PLAY_DURATION: 90,
    RESULTS_DURATION: 8,
    NO_RESPAWN_LAST_SECONDS: 10,
  },

  // ─── Respawn ──────────────────────────────────────
  RESPAWN: {
    DEATH_CAM_DURATION: 2,
    INVINCIBILITY_DURATION: 1.5,
    SPAWN_MARGIN: 15,
  },

  // ─── Network ──────────────────────────────────────
  NETWORK: {
    SEND_RATE: 20,
    INTERPOLATION_BUFFER: 3,
    PARTYKIT_HOST: 'rocket-bumpers.YOUR_USERNAME.partykit.dev', // TODO: replace
    MAX_PLAYERS: 8,
  },

  // ─── AI Bots ──────────────────────────────────────
  BOTS: {
    NAMES: ['TURBO', 'BLAZE', 'NITRO', 'CRASH', 'FURY', 'BOLT', 'HAVOC', 'STORM'],
    EDGE_DANGER_DISTANCE: 10,
    POWERUP_SEEK_RANGE: 20,
    STATE_UPDATE_INTERVAL: 0.5,
    PERSONALITIES: {
      AGGRESSIVE:  { aggression: 0.9, edgeCaution: 0.3, abilityUsage: 0.8, powerupPriority: 0.5 },
      DEFENSIVE:   { aggression: 0.3, edgeCaution: 0.9, abilityUsage: 0.4, powerupPriority: 0.9 },
      KAMIKAZE:    { aggression: 1.0, edgeCaution: 0.1, abilityUsage: 1.0, powerupPriority: 0.2 },
      HUNTER:      { aggression: 0.7, edgeCaution: 0.6, abilityUsage: 0.6, powerupPriority: 0.8 },
    },
  },

  // ─── Effects ──────────────────────────────────────
  EFFECTS: {
    ROCKET_FLAME: { particlesPerFrame: 15, lifetime: 0.3, startScale: 0.3, endScale: 0.0 },
    COLLISION_SPARKS: { count: 20, lifetime: 0.5 },
    POWERUP_PICKUP: { ringExpandTime: 0.5, particleCount: 30 },
  },

  // ─── Audio ────────────────────────────────────────
  AUDIO: {
    MASTER_VOLUME: 0.7,
    SFX_VOLUME: 0.8,
    MUSIC_VOLUME: 0.4,
  },

  // ─── Performance ──────────────────────────────────
  PERFORMANCE: {
    MOBILE_PARTICLE_MULTIPLIER: 0.5,
    TARGET_FPS: 60,
    DT_CAP: 1 / 30,
  },

  // ─── Physics ──────────────────────────────────────
  PHYSICS: {
    GRAVITY: -9.82,
    FIXED_TIMESTEP: 1 / 60,
    MAX_SUBSTEPS: 3,
    MAX_VELOCITY: 70,              // absolute cap on any car speed regardless of multipliers
    COLLISION_GROUPS: {
      ARENA:  1,                   // floor, ramps — collides with everything
      CAR:    2,                   // car bodies — collides with ARENA + CAR + PICKUP + TRAIL
      PICKUP: 4,                   // power-up pedestals — collides with CAR only
      TRAIL:  8,                   // VIPER trail fire objects — collides with CAR only
    },
    // PHASE / Invincible mask: collide with ARENA only (group 1)
    PHASE_COLLISION_MASK: 1,
    // Normal car mask: collide with ARENA + CAR + PICKUP + TRAIL (1|2|4|8 = 15)
    NORMAL_CAR_COLLISION_MASK: 15,
  },
};
