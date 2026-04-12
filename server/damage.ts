import { GAME } from './protocol.js';

/**
 * Server-side damage calculation — mirrors CollisionHandler._calcDamage.
 *
 * @param approachSpeed — attacker's speed toward victim (u/s)
 * @param attackerMass — attacker's cannon-es body mass
 * @param victimMass — victim's cannon-es body mass
 * @param angleFactor — impact angle factor (0.3–1.0)
 * @returns clamped final damage
 */
export function calcDamage(
  approachSpeed: number,
  attackerMass: number,
  victimMass: number,
  angleFactor: number = 1.0,
): number {
  if (approachSpeed < GAME.MIN_SPEED) return 0;

  const velocityFactor = approachSpeed / GAME.REF_SPEED;
  const massFactor = Math.sqrt(attackerMass);
  const raw = GAME.BASE_DAMAGE * velocityFactor * massFactor * angleFactor;

  // Victim armor: heavier cars resist damage better
  const armor = 1 + victimMass * GAME.ARMOR_FACTOR;
  const final = raw / armor;

  return Math.min(Math.max(final, GAME.MIN_DAMAGE), GAME.MAX_DAMAGE);
}

/**
 * Get streak multiplier for scoring.
 */
export function getStreakMultiplier(streak: number): number {
  if (streak >= GAME.SCORE_STREAK_3X) return 3;
  if (streak >= GAME.SCORE_STREAK_2X) return 2;
  return 1;
}
