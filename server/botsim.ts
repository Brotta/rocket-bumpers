/**
 * Server-side bot simulator — owns bot AI + physics so pacing is decoupled
 * from any client's render loop (fixes BUG 0 jitter propagation).
 *
 * Physics is a simplified kinematic model (no wheel forces / suspension /
 * drift). Bots drive like smart hovers, not fully-simulated cars — acceptable
 * for arena combat since bot↔human physical collisions are detected both
 * server-side (here) and client-side (for human attacker), converging on the
 * same damage outcome via shared pair cooldowns.
 *
 * Target selection mirrors the original client BotBrain:
 *   - Humans are preferred (large bonus).
 *   - Low-HP targets attract predators (+bonus).
 *   - Anti-gangup: targets already hunted by many bots are deprioritised.
 *   - Bots DO attack each other when no humans are nearby or when a bot has
 *     already accumulated too many hunters — matches the original semantics.
 *
 * Power-up use is situational, not timer-random: bots only fire a missile
 * when the target is actually in front of them and within range, only pop
 * SHIELD/HOLO_EVADE under threat, only heal when they took damage, etc.
 */

const ARENA_RADIUS = 60;
const ARENA_SIDES = 8;
const ARENA_APOTHEM = ARENA_RADIUS * Math.cos(Math.PI / ARENA_SIDES);

const MAX_SPEED = 22;
const ACCEL = 28;
const FRICTION = 0.985;
const TURN_RATE = 3.2;
const MAX_ANGULAR_VEL = 2.6;
const RETARGET_MIN_MS = 900;
const RETARGET_MAX_MS = 2400;
const WANDER_JITTER = 0.25;

// Target-scoring weights (mirror client BotBrain proportions).
const SCORE_HUMAN_BONUS = 30;
const SCORE_LOW_HP_BONUS = 18;
const SCORE_LOW_HP_FRAC = 0.3; // <30% HP = predator bait
const SCORE_GANGUP_PENALTY = 12; // per extra hunter beyond 1
const SCORE_REVENGE_BONUS = 40; // strong pull toward whoever just hit us
const SCORE_MAX_RANGE = 55; // past this distance the bot effectively ignores you
const REVENGE_WINDOW_MS = 8000; // match client _revengeTimer (~6-10s spread)

export interface BotPhysicsState {
  botId: string;
  carType: string;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  yaw: number;
  speed: number;
  // AI target lock
  targetId: string | null;
  nextRetargetAt: number;
  wanderPhase: number;
  // Server-owned power-up inventory and reaction timing.
  heldPowerup: string | null;
  powerupUseEarliest: number;  // earliest time the bot will consider firing
  powerupReadyAt: number;      // when bot can pick up again (post-use cooldown)
  // GLITCH_BOMB disruption — when a bot catches a glitch, its inputs get
  // scrambled for 5s (matches client _applyGlitchDisruption). While glitched:
  //   • 40% chance per tick the steering is flipped,
  //   • 12% chance the bot freezes (no throttle),
  //   •  8% chance the bot briefly reverses,
  //   • power-up use is disabled,
  //   • target lock can drop randomly.
  glitchExpireAt: number;
  // Revenge memory (BotBrain-parity): bot prioritises whoever last hit it
  // for a short window so engagements feel like feuds, not random noise.
  lastHitById: string | null;
  revengeExpireAt: number;
  // Personality — tuned at spawn to create behavioral variety.
  aggression: number;   // 0..1 — higher = picks human + closes distance more
  caution: number;      // 0..1 — higher = uses defensives earlier
}

export interface PlayerSnapshot {
  id: string;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velZ: number;
  yaw: number;
  mass: number;
  hp: number;
  maxHp: number;
  isEliminated: boolean;
  isInvincible: boolean;
  // SHIELD halves damage (server applies reduction in _dealDamage).
  hasShield: boolean;
  // HOLO_EVADE gives incoming homing/turret projectiles a 50% chance to
  // lock onto a decoy instead of this car (see projectilesim.ts).
  holoEvadeActive: boolean;
  isBot: boolean;
}

export function createBot(botId: string, carType: string, slotIndex: number): BotPhysicsState {
  const angle = (slotIndex / 8) * Math.PI * 2;
  const r = ARENA_APOTHEM * 0.7;
  return {
    botId,
    carType,
    posX: Math.cos(angle) * r,
    posY: 0.6,
    posZ: Math.sin(angle) * r,
    velX: 0,
    velY: 0,
    velZ: 0,
    yaw: Math.atan2(-Math.sin(angle), -Math.cos(angle)),
    speed: 0,
    targetId: null,
    nextRetargetAt: Date.now(),
    wanderPhase: Math.random() * Math.PI * 2,
    heldPowerup: null,
    powerupUseEarliest: 0,
    powerupReadyAt: Date.now(),
    glitchExpireAt: 0,
    lastHitById: null,
    revengeExpireAt: 0,
    // Personality spread ≈ [0.3..1] so every bot feels a bit different.
    aggression: 0.3 + Math.random() * 0.7,
    caution: 0.3 + Math.random() * 0.7,
  };
}

/**
 * One simulation step at fixed dt. Also refreshes the target lock if stale
 * or invalid. Mutates bot in place.
 */
export function stepBot(
  bot: BotPhysicsState,
  dt: number,
  players: PlayerSnapshot[],
  now: number,
  hunterCounts: Map<string, number>,
): void {
  // ── Target selection / refresh ──
  const targetValid = bot.targetId
    ? players.some(p => p.id === bot.targetId && !p.isEliminated)
    : false;
  if (!targetValid || now >= bot.nextRetargetAt) {
    bot.targetId = selectBestTarget(bot, players, hunterCounts, now);
    bot.nextRetargetAt = now + RETARGET_MIN_MS + Math.random() * (RETARGET_MAX_MS - RETARGET_MIN_MS);
  }
  if (bot.targetId) hunterCounts.set(bot.targetId, (hunterCounts.get(bot.targetId) || 0) + 1);

  const target = bot.targetId
    ? players.find(p => p.id === bot.targetId && !p.isEliminated)
    : undefined;

  // ── Glitch disruption ──
  // If the bot is glitched its inputs get scrambled. We compute normal
  // steering values first, then mutate them. Matches client BotBrain
  // _applyGlitchDisruption probability distribution.
  const glitched = now < bot.glitchExpireAt;

  // ── Steering ──
  let desiredYaw = bot.yaw;
  if (target) {
    const dx = target.posX - bot.posX;
    const dz = target.posZ - bot.posZ;
    desiredYaw = Math.atan2(dz, dx);
  } else {
    bot.wanderPhase += dt * 0.8;
    desiredYaw = bot.yaw + Math.sin(bot.wanderPhase) * WANDER_JITTER;
  }
  let yawDiff = desiredYaw - bot.yaw;
  while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
  while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;

  if (glitched && Math.random() < 0.4) yawDiff = -yawDiff; // steering flip

  // ~15% chance per step to lose target lock while glitched.
  if (glitched && bot.targetId && Math.random() < 0.15) bot.targetId = null;

  const angularVel = Math.max(-MAX_ANGULAR_VEL, Math.min(MAX_ANGULAR_VEL, yawDiff * TURN_RATE));
  bot.yaw += angularVel * dt;

  // Throttle — aggressive bots push harder; glitched bots occasionally
  // freeze (no throttle) or reverse briefly.
  let throttle = 0.8 + bot.aggression * 0.2;
  if (glitched) {
    const r = Math.random();
    if (r < 0.12) throttle = 0;            // freeze
    else if (r < 0.20) throttle = -0.5;    // reverse burst (0.12 + 0.08)
  }
  bot.velX += Math.cos(bot.yaw) * ACCEL * throttle * dt;
  bot.velZ += Math.sin(bot.yaw) * ACCEL * throttle * dt;
  bot.velX *= FRICTION;
  bot.velZ *= FRICTION;
  const sp = Math.hypot(bot.velX, bot.velZ);
  if (sp > MAX_SPEED) {
    const k = MAX_SPEED / sp;
    bot.velX *= k;
    bot.velZ *= k;
  }
  bot.speed = Math.min(sp, MAX_SPEED);

  // Integrate
  bot.posX += bot.velX * dt;
  bot.posZ += bot.velZ * dt;

  // Arena containment — octagon face-normal projection + reflection
  let maxProj = -Infinity;
  let maxNx = 0;
  let maxNz = 0;
  for (let i = 0; i < ARENA_SIDES; i++) {
    const a = ((i + 0.5) / ARENA_SIDES) * Math.PI * 2 - Math.PI / ARENA_SIDES;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    const proj = bot.posX * nx + bot.posZ * nz;
    if (proj > maxProj) { maxProj = proj; maxNx = nx; maxNz = nz; }
  }
  const limit = ARENA_APOTHEM - 1.2;
  if (maxProj > limit) {
    const excess = maxProj - limit;
    bot.posX -= maxNx * excess;
    bot.posZ -= maxNz * excess;
    const vn = bot.velX * maxNx + bot.velZ * maxNz;
    if (vn > 0) {
      bot.velX -= maxNx * vn * 1.6;
      bot.velZ -= maxNz * vn * 1.6;
    }
  }
}

/**
 * Score every live candidate and pick the best one. Mirrors client BotBrain:
 * humans preferred, low-HP targets become prey, anti-gangup spreads the
 * bots across multiple victims. Bots ARE allowed as targets so the arena
 * still feels alive when few humans are around.
 */
function selectBestTarget(
  bot: BotPhysicsState,
  players: PlayerSnapshot[],
  hunterCounts: Map<string, number>,
  now: number,
): string | null {
  const revengeActive = bot.lastHitById && now < bot.revengeExpireAt;
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const p of players) {
    if (p.id === bot.botId || p.isEliminated) continue;
    const dx = p.posX - bot.posX;
    const dz = p.posZ - bot.posZ;
    const dist = Math.hypot(dx, dz);
    if (dist > SCORE_MAX_RANGE) continue;
    let score = (SCORE_MAX_RANGE - dist);
    if (!p.isBot) score += SCORE_HUMAN_BONUS * (0.6 + bot.aggression * 0.4);
    if (p.hp <= p.maxHp * SCORE_LOW_HP_FRAC) score += SCORE_LOW_HP_BONUS;
    const hunters = hunterCounts.get(p.id) || 0;
    if (hunters > 0) score -= hunters * SCORE_GANGUP_PENALTY;
    if (revengeActive && p.id === bot.lastHitById) score += SCORE_REVENGE_BONUS;
    if (score > bestScore) { bestScore = score; bestId = p.id; }
  }
  return bestId;
}

// ── Binary encoding: produce a 20+N byte entry matching the client's
//    encodePlayerState layout (minus the leading 0x01 msgType byte). ──

const CAR_ORDER = ['FANG', 'HORNET', 'RHINO', 'VIPER', 'TOAD', 'LYNX', 'MAMMOTH', 'GHOST'];
const _carTypeIndex = new Map<string, number>(CAR_ORDER.map((k, i) => [k, i]));

export function encodeBotEntry(bot: BotPhysicsState, hp: number, flags = 0): ArrayBuffer {
  const enc = new TextEncoder();
  const idBytes = enc.encode(bot.botId);
  const buf = new ArrayBuffer(1 + idBytes.length + 1 + 16 + 1 + 1);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);

  view.setUint8(0, idBytes.length);
  arr.set(idBytes, 1);
  const s = 1 + idBytes.length;
  view.setUint8(s, _carTypeIndex.get(bot.carType) ?? 0);
  _writeFloat16(view, s + 1, bot.posX);
  _writeFloat16(view, s + 3, bot.posY);
  _writeFloat16(view, s + 5, bot.posZ);
  _writeFloat16(view, s + 7, bot.velX);
  _writeFloat16(view, s + 9, bot.velY);
  _writeFloat16(view, s + 11, bot.velZ);
  _writeFloat16(view, s + 13, bot.yaw);
  _writeFloat16(view, s + 15, bot.speed);
  view.setUint8(s + 17, flags & 0xff);
  view.setUint8(s + 18, Math.max(0, Math.min(255, Math.round(hp))));
  return buf;
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function _writeFloat16(view: DataView, offset: number, value: number): void {
  _f32[0] = value;
  const bits = _u32[0];
  const sign = (bits >> 16) & 0x8000;
  let exp = ((bits >> 23) & 0xff) - 127 + 15;
  const frac = (bits >> 13) & 0x03ff;
  let half: number;
  if (exp <= 0) half = sign;
  else if (exp >= 31) half = sign | 0x7c00;
  else half = sign | (exp << 10) | frac;
  view.setUint16(offset, half, true);
}

// ── Power-up decision: should this bot use its held power-up NOW? ──
//
// Mirrors the client BotBrain thresholds so bots behave consistently whether
// they were originally host-simulated or server-simulated.

export function shouldUsePowerup(
  bot: BotPhysicsState,
  botHp: number,
  botMaxHp: number,
  type: string,
  players: PlayerSnapshot[],
  now: number,
): boolean {
  if (now < bot.powerupUseEarliest) return false;
  // Glitched bots can't reliably activate power-ups (matches client behaviour:
  // _applyGlitchDisruption prevents ability/power-up use while active).
  if (now < bot.glitchExpireAt) return false;

  // Find nearest live non-self enemy — used by both offensive checks
  // and threat assessments for defensives. Bucket counts align with client
  // BotBrain thresholds (20u for AOE sweet spot, 25u for turret range).
  let nearestDist = Infinity;
  let nearestInFront: PlayerSnapshot | null = null;
  let nearestInFrontDist = Infinity;
  let enemiesAoe = 0;         // within 20u (GLITCH_BOMB sweet spot)
  let enemiesMid = 0;         // within 25u (turret range)
  let enemiesFar = 0;         // within 30u (chained AoE check)
  let charger: PlayerSnapshot | null = null;
  let chargerDist = Infinity;

  for (const p of players) {
    if (p.id === bot.botId || p.isEliminated || p.isInvincible) continue;
    const dx = p.posX - bot.posX;
    const dz = p.posZ - bot.posZ;
    const dist = Math.hypot(dx, dz);
    if (dist < nearestDist) nearestDist = dist;
    if (dist <= 20) enemiesAoe++;
    if (dist <= 25) enemiesMid++;
    if (dist <= 30) enemiesFar++;

    // Front cone (same definition the client's BotBrain uses: <~0.4 rad)
    const targetYaw = Math.atan2(dz, dx);
    let angDiff = targetYaw - bot.yaw;
    while (angDiff > Math.PI) angDiff -= Math.PI * 2;
    while (angDiff < -Math.PI) angDiff += Math.PI * 2;
    if (Math.abs(angDiff) < 0.4 && dist < nearestInFrontDist) {
      nearestInFrontDist = dist;
      nearestInFront = p;
    }

    // Approaching threat: moving toward us fast, within 12u
    if (dist < 12) {
      const n2x = -dx / dist;
      const n2z = -dz / dist;
      const closing = p.velX * (-n2x) + p.velZ * (-n2z);
      if (closing > 6 && dist < chargerDist) {
        charger = p;
        chargerDist = dist;
      }
    }
  }

  switch (type) {
    case 'MISSILE':
      // Fires straight from the nose — only worth it when a target is in
      // the bot's forward cone at sensible range.
      return !!nearestInFront && nearestInFrontDist <= 40;

    case 'HOMING_MISSILE':
      // Client BotBrain fires homing when an enemy is within ~35u — tighter
      // than the missile's 80u seek radius so bots don't waste the pickup
      // on distant targets that might escape the lock.
      return nearestDist <= 35;

    case 'AUTO_TURRET':
      // Turret auto-aims; drop it when at least one enemy is in its range.
      return enemiesMid >= 1;

    case 'GLITCH_BOMB':
      // Client BotBrain: fire when 2+ enemies within 20u OR 3+ within 30u
      // with high threat (approximated here by any enemyClose charger).
      return enemiesAoe >= 2 || (enemiesFar >= 3 && bot.caution < 0.6);

    case 'SHIELD': {
      // Low HP OR incoming charger OR generally cautious bots in threat
      const lowHp = botHp < botMaxHp * 0.4;
      return lowHp || !!charger || (bot.caution > 0.6 && enemiesAoe >= 1);
    }

    case 'REPAIR_KIT':
      // Only heal when we've actually taken meaningful damage.
      return botHp <= botMaxHp - 25;

    case 'HOLO_EVADE': {
      const lowHp = botHp < botMaxHp * 0.5;
      return lowHp || !!charger;
    }

    default:
      return false;
  }
}
