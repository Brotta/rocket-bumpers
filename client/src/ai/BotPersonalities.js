/**
 * BotPersonalities — weight presets that tune BotBrain decisions.
 *
 * Each personality adjusts how aggressively a bot seeks targets,
 * how readily it evades danger, and how it prioritises power-ups.
 * Also includes human-imperfection parameters: reaction delay,
 * steering noise, throttle habits, and mistake frequency.
 */

export const PERSONALITIES = {
  Aggressive: {
    targetRange: 30,
    chargeSpeed: 1.0,
    evadeThreshold: 0.25,
    powerupWeight: 0.3,
    abilityEagerness: 0.85,
    roamTime: 1.0,
    // Human-feel
    reactionDelay: 0.12,    // seconds before responding to new info
    steerNoise: 0.06,       // radians of random wobble added to steering
    throttleRelease: 0.08,  // chance per tick of briefly letting off gas
    mistakeChance: 0.003,   // chance per tick of a brief wrong turn
    retargetChance: 0.02,   // chance per tick of switching targets mid-chase
    coastChance: 0.05,      // chance of coasting instead of full throttle
  },
  Defensive: {
    targetRange: 18,
    chargeSpeed: 0.7,
    evadeThreshold: 0.45,
    powerupWeight: 0.7,
    abilityEagerness: 0.5,
    roamTime: 2.0,
    reactionDelay: 0.2,
    steerNoise: 0.04,
    throttleRelease: 0.12,
    mistakeChance: 0.004,
    retargetChance: 0.01,
    coastChance: 0.10,
  },
  Kamikaze: {
    targetRange: 40,
    chargeSpeed: 1.3,
    evadeThreshold: 0.1,
    powerupWeight: 0.1,
    abilityEagerness: 1.0,
    roamTime: 0.5,
    reactionDelay: 0.08,
    steerNoise: 0.08,
    throttleRelease: 0.03,
    mistakeChance: 0.005,
    retargetChance: 0.03,
    coastChance: 0.02,
  },
  Hunter: {
    targetRange: 35,
    chargeSpeed: 0.9,
    evadeThreshold: 0.3,
    powerupWeight: 0.5,
    abilityEagerness: 0.75,
    roamTime: 1.2,
    reactionDelay: 0.15,
    steerNoise: 0.05,
    throttleRelease: 0.06,
    mistakeChance: 0.002,
    retargetChance: 0.015,
    coastChance: 0.06,
  },
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

/** Pick a random personality. */
export function randomPersonality() {
  return PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
}
