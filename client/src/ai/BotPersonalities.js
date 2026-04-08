/**
 * BotPersonalities — 8 distinct playstyle presets that tune BotBrain decisions.
 *
 * Each personality creates a recognisably different opponent:
 *   Aggressive  — charges relentlessly, abilities on cooldown
 *   Defensive   — cautious, collects power-ups, punishes mistakes
 *   Kamikaze    — all-in berserker, low self-preservation
 *   Hunter      — patient stalker, picks the weakest target
 *   Brawler     — mid-range bully, loves crowded fights
 *   Trickster   — erratic movement, flanks, uses abilities unpredictably
 *   Survivor    — preservation first, only fights when advantageous
 *   Hothead     — aggressive but sloppy, loses composure when hit
 *
 * Human-imperfection parameters keep bots from feeling robotic:
 *   reactionDelay  — seconds before responding to new information
 *   steerNoise     — radians of random wobble on steering
 *   mistakeChance  — per-think chance of a brief wrong turn
 *   coastChance    — per-think chance of releasing throttle briefly
 *   overcommit     — how long (s) bot keeps charging when it should bail
 *   panicThreshold — HP % below which bot enters panicky behaviour
 *   dodgeSkill     — 0-1 how well the bot dodges incoming threats (0 = oblivious, 1 = pro)
 *   flankBias      — 0-1 tendency to approach targets from the side rather than head-on
 *   revengeWeight  — 0-1 how strongly the bot prioritises who last hit it
 *   momentumCommit — seconds the bot commits to current direction before reconsidering
 */

export const PERSONALITIES = {
  Aggressive: {
    targetRange: 32,
    chargeSpeed: 1.0,
    evadeThreshold: 0.25,
    powerupWeight: 0.25,
    abilityEagerness: 0.85,
    roamTime: 0.8,
    // Human-feel
    reactionDelay: 0.18,
    steerNoise: 0.07,
    mistakeChance: 0.008,
    retargetChance: 0.025,
    coastChance: 0.03,
    // New params
    overcommit: 0.6,
    panicThreshold: 25,
    dodgeSkill: 0.55,
    flankBias: 0.1,
    revengeWeight: 0.6,
    momentumCommit: 0.3,
    throttleAggression: 0.9,   // how often bot floors it (0 = cautious, 1 = always full gas)
    combatPersistence: 0.8,    // how long bot sticks with a fight vs disengaging
  },

  Defensive: {
    targetRange: 20,
    chargeSpeed: 0.7,
    evadeThreshold: 0.5,
    powerupWeight: 0.8,
    abilityEagerness: 0.4,
    roamTime: 1.8,
    reactionDelay: 0.25,
    steerNoise: 0.03,
    mistakeChance: 0.005,
    retargetChance: 0.01,
    coastChance: 0.06,
    overcommit: 0.15,
    panicThreshold: 40,
    dodgeSkill: 0.7,
    flankBias: 0.3,
    revengeWeight: 0.2,
    momentumCommit: 0.25,
    throttleAggression: 0.5,
    combatPersistence: 0.35,
  },

  Kamikaze: {
    targetRange: 45,
    chargeSpeed: 1.3,
    evadeThreshold: 0.08,
    powerupWeight: 0.05,
    abilityEagerness: 1.0,
    roamTime: 0.4,
    reactionDelay: 0.12,
    steerNoise: 0.1,
    mistakeChance: 0.012,
    retargetChance: 0.04,
    coastChance: 0.01,
    overcommit: 1.2,
    panicThreshold: 10,
    dodgeSkill: 0.2,
    flankBias: 0.0,
    revengeWeight: 0.3,
    momentumCommit: 0.5,
    throttleAggression: 1.0,
    combatPersistence: 0.95,
  },

  Hunter: {
    targetRange: 38,
    chargeSpeed: 0.85,
    evadeThreshold: 0.3,
    powerupWeight: 0.5,
    abilityEagerness: 0.7,
    roamTime: 1.0,
    reactionDelay: 0.2,
    steerNoise: 0.04,
    mistakeChance: 0.004,
    retargetChance: 0.008,
    coastChance: 0.04,
    overcommit: 0.3,
    panicThreshold: 30,
    dodgeSkill: 0.65,
    flankBias: 0.5,
    revengeWeight: 0.15,
    momentumCommit: 0.35,
    throttleAggression: 0.7,
    combatPersistence: 0.6,
  },

  Brawler: {
    targetRange: 25,
    chargeSpeed: 1.1,
    evadeThreshold: 0.2,
    powerupWeight: 0.35,
    abilityEagerness: 0.9,
    roamTime: 0.6,
    reactionDelay: 0.15,
    steerNoise: 0.08,
    mistakeChance: 0.01,
    retargetChance: 0.05,
    coastChance: 0.02,
    overcommit: 0.8,
    panicThreshold: 20,
    dodgeSkill: 0.35,
    flankBias: 0.05,
    revengeWeight: 0.8,
    momentumCommit: 0.4,
    throttleAggression: 0.95,
    combatPersistence: 0.9,
  },

  Trickster: {
    targetRange: 28,
    chargeSpeed: 0.9,
    evadeThreshold: 0.35,
    powerupWeight: 0.6,
    abilityEagerness: 0.8,
    roamTime: 1.2,
    reactionDelay: 0.22,
    steerNoise: 0.12,
    mistakeChance: 0.006,
    retargetChance: 0.06,
    coastChance: 0.08,
    overcommit: 0.2,
    panicThreshold: 35,
    dodgeSkill: 0.75,
    flankBias: 0.8,
    revengeWeight: 0.1,
    momentumCommit: 0.15,
    throttleAggression: 0.6,
    combatPersistence: 0.4,
  },

  Survivor: {
    targetRange: 22,
    chargeSpeed: 0.6,
    evadeThreshold: 0.55,
    powerupWeight: 0.9,
    abilityEagerness: 0.35,
    roamTime: 2.2,
    reactionDelay: 0.28,
    steerNoise: 0.03,
    mistakeChance: 0.003,
    retargetChance: 0.01,
    coastChance: 0.07,
    overcommit: 0.1,
    panicThreshold: 50,
    dodgeSkill: 0.8,
    flankBias: 0.4,
    revengeWeight: 0.05,
    momentumCommit: 0.2,
    throttleAggression: 0.45,
    combatPersistence: 0.2,
  },

  Hothead: {
    targetRange: 35,
    chargeSpeed: 1.15,
    evadeThreshold: 0.15,
    powerupWeight: 0.2,
    abilityEagerness: 0.95,
    roamTime: 0.5,
    reactionDelay: 0.1,
    steerNoise: 0.09,
    mistakeChance: 0.015,
    retargetChance: 0.07,
    coastChance: 0.02,
    overcommit: 1.0,
    panicThreshold: 15,
    dodgeSkill: 0.3,
    flankBias: 0.0,
    revengeWeight: 1.0,
    momentumCommit: 0.5,
    throttleAggression: 1.0,
    combatPersistence: 0.85,
  },
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

/** Pick a random personality. */
export function randomPersonality() {
  return PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
}
