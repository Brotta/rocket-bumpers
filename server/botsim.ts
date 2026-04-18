/**
 * Server-side bot simulator — owns bot AI + physics so pacing is decoupled
 * from any client's render loop (fixes BUG 0 jitter propagation).
 *
 * Since the human-feel refactor this file is a thin physics/orchestration
 * layer: the interesting AI decisions (state machine, personality, dodge,
 * flanking, stuck recovery) live in botbrain.ts. stepBot() runs three phases
 * per tick:
 *   1. sense()      — perception: hit, stuck, edge, dodge, threat.
 *   2. maybeThink() — FSM transitions + cached desiredYaw/desiredThrottle
 *                     (only every 150-260ms per bot, personality-scaled).
 *   3. act          — steering/throttle integration using cached intents
 *                     plus per-tick human-feel perturbations.
 *
 * Target selection mirrors the original client BotBrain:
 *   - Humans are preferred (large bonus).
 *   - Low-HP targets attract predators (+bonus).
 *   - Anti-gangup: targets already hunted by many bots are deprioritised.
 *   - Revenge: whoever last hit us is a strong pull (scaled by personality).
 *
 * Power-up use is situational, not timer-random: bots only fire a missile
 * when the target is actually in front of them and within range, only pop
 * SHIELD/HOLO_EVADE under threat, only heal when they took damage, etc.
 */

import {
  assignPersonality, sense, maybeThink, applyHumanFeel,
  type BotState, type PersonalityParams, type ThinkCtx,
} from './botbrain.js';

const ARENA_RADIUS = 60;
const ARENA_SIDES = 8;
const ARENA_APOTHEM = ARENA_RADIUS * Math.cos(Math.PI / ARENA_SIDES);

// Global tunables that don't vary per car. maxSpeed / accel / turnRate /
// maxAngularVel are PER-CAR (see CAR_PHYSICS) so a RHINO bot can't outrun
// a HORNET bot — the previous global MAX_SPEED=22 made every car identical
// and let slow-class bots sprint at hornet speeds.
const FRICTION = 0.985;
// Lateral friction — matches client CAR_FEEL.lateralFriction. Each tick we
// decompose velocity into longitudinal (aligned with bot.yaw) and lateral
// (perpendicular) and damp the lateral component. Without this the bot
// behaves like a hovercraft: the yaw rotates toward the target but the
// velocity vector stays pointed wherever inertia carries it, producing
// the "spinning on the spot while drifting sideways" look.
// 0.94 is the client's BASE grip; matched here so server bots feel like
// real cars.
const LATERAL_FRICTION = 0.94;
const RETARGET_MIN_MS = 900;
const RETARGET_MAX_MS = 2400;
const WANDER_JITTER = 0.25;

// ── Per-car physics table (must mirror client Config.js STAT_MAP) ──
//
// Client formula: STAT_MAP.speed[s]    = 35 * s / 10  (stat 2-8 → 7..28)
//                 STAT_MAP.handling[s] = 5.5 * s / 10 (stat 2-8 → 1.1..4.4)
// Cars carry { speed, mass, handling } stats — we derive the bot kinematic
// limits from those so a heavy slow class stays heavy and slow even when
// piloted by a server-side bot.
//
// accel uses a fixed time-to-max ratio (≈0.78s, matching the previous
// global tuning of MAX_SPEED=22 / ACCEL=28). Angular vel cap is a fraction
// of turn rate so tight steering doesn't cause oscillation.

const STAT_BASE_SPEED = 35;
const STAT_BASE_HANDLING = 5.5;
const TIME_TO_MAX_SPEED = 0.78;       // seconds — same feel as old ACCEL=28
const ANGULAR_VEL_RATIO = 0.85;       // bot.maxAngularVel = bot.turnRate * this

interface CarStats { speed: number; handling: number; }
const CAR_STATS: Record<string, CarStats> = {
  FANG:    { speed: 6, handling: 4 },
  HORNET:  { speed: 7, handling: 6 },
  RHINO:   { speed: 3, handling: 4 },
  VIPER:   { speed: 8, handling: 4 },
  TOAD:    { speed: 4, handling: 5 },
  LYNX:    { speed: 5, handling: 6 },
  MAMMOTH: { speed: 4, handling: 4 },
  GHOST:   { speed: 6, handling: 6 },
};

interface CarPhysics {
  maxSpeed: number;
  accel: number;
  turnRate: number;
  maxAngularVel: number;
}
function _physicsFor(carType: string): CarPhysics {
  const s = CAR_STATS[carType] ?? CAR_STATS.FANG;
  const maxSpeed = STAT_BASE_SPEED * s.speed / 10;
  const turnRate = STAT_BASE_HANDLING * s.handling / 10;
  return {
    maxSpeed,
    accel: maxSpeed / TIME_TO_MAX_SPEED,
    turnRate,
    maxAngularVel: turnRate * ANGULAR_VEL_RATIO,
  };
}

// ── Static obstacles (must mirror client Config.js ARENA.rockObstacles) ──
//
// Bots used to phase straight through pillars and boulders because the
// server had no notion of them — only the octagonal arena boundary. Now
// every bot is collided against this list each tick: penetration is pushed
// out and any inward velocity component is reflected (with a slight loss).
//
// Obstacles can be destroyed by missiles/etc. The client broadcasts the
// position via OBSTACLE_DESTROYED; the server finds the matching entry by
// closest-point match and flips `destroyed = true` so subsequent bot ticks
// no longer collide with a rubble pile that visually no longer exists.

interface Obstacle {
  posX: number;
  posZ: number;
  radius: number;
  destroyed: boolean;
  // Barrier-only metadata. `isBarrier` gates respawn + bounds handling.
  isBarrier?: boolean;
  edgeIdx?: number;
  segIdx?: number;
}

// Mirror of client/src/core/Config.js ARENA.edgeBarriers. Kept inline
// so the server doesn't depend on client source at runtime.
const ARENA_R = 60;
const BARRIER_SEGMENTS_PER_EDGE = 3;
const BARRIER_WIDTH = 3.8;
const BARRIER_THICKNESS = 0.55;
const BARRIER_INSET = 0.25;
export const BARRIER_RESPAWN_DELAY_MS = 22_000;

function _buildObstacles(): Obstacle[] {
  const out: Obstacle[] = [];
  // Pillars (5)
  const pillars = [
    { angle: 0.4, dist: 16, baseRadius: 1.8 },
    { angle: 1.6, dist: 18, baseRadius: 2.0 },
    { angle: 2.8, dist: 15, baseRadius: 1.6 },
    { angle: 4.2, dist: 17, baseRadius: 1.9 },
    { angle: 5.5, dist: 19, baseRadius: 1.7 },
  ];
  for (const p of pillars) {
    out.push({
      posX: Math.cos(p.angle) * p.dist,
      posZ: Math.sin(p.angle) * p.dist,
      radius: p.baseRadius,
      destroyed: false,
    });
  }
  // Boulders (12)
  const boulders = [
    { angle: 0.9, dist: 28, radius: 2.0 },
    { angle: 1.2, dist: 40, radius: 1.5 },
    { angle: 2.1, dist: 35, radius: 2.5 },
    { angle: 2.6, dist: 22, radius: 1.8 },
    { angle: 3.3, dist: 45, radius: 1.4 },
    { angle: 3.8, dist: 30, radius: 2.2 },
    { angle: 4.5, dist: 38, radius: 1.6 },
    { angle: 5.0, dist: 25, radius: 2.0 },
    { angle: 5.8, dist: 42, radius: 1.3 },
    { angle: 0.1, dist: 50, radius: 1.7 },
    { angle: 1.8, dist: 48, radius: 1.9 },
    { angle: 3.0, dist: 52, radius: 1.5 },
  ];
  for (const b of boulders) {
    out.push({
      posX: Math.cos(b.angle) * b.dist,
      posZ: Math.sin(b.angle) * b.dist,
      radius: b.radius,
      destroyed: false,
    });
  }
  // Edge barriers — 8 sides × 3 segments. Approximated as circles
  // for bot collision since the server doesn't need pixel-perfect
  // rotated-box tests (bots are already fence-clamped a bit inside
  // the arena apothem).
  const sides = 8;
  for (let edgeIdx = 0; edgeIdx < sides; edgeIdx++) {
    const a0 = (edgeIdx / sides) * Math.PI * 2 - Math.PI / 8;
    const a1 = ((edgeIdx + 1) / sides) * Math.PI * 2 - Math.PI / 8;
    const p1x = Math.cos(a0) * ARENA_R, p1z = Math.sin(a0) * ARENA_R;
    const p2x = Math.cos(a1) * ARENA_R, p2z = Math.sin(a1) * ARENA_R;
    const mx = (p1x + p2x) / 2, mz = (p1z + p2z) / 2;
    const ex = p2x - p1x, ez = p2z - p1z;
    const elen = Math.hypot(ex, ez);
    const tx = ex / elen, tz = ez / elen;
    const mR = Math.hypot(mx, mz);
    const nx = -mx / mR, nz = -mz / mR;
    const barrierRadius = Math.max(BARRIER_WIDTH / 2, BARRIER_THICKNESS / 2) + 0.3;
    for (let segIdx = 0; segIdx < BARRIER_SEGMENTS_PER_EDGE; segIdx++) {
      const frac = (segIdx + 0.5) / BARRIER_SEGMENTS_PER_EDGE - 0.5;
      const cx = mx + tx * elen * frac + nx * BARRIER_INSET;
      const cz = mz + tz * elen * frac + nz * BARRIER_INSET;
      out.push({
        posX: cx,
        posZ: cz,
        radius: barrierRadius,
        destroyed: false,
        isBarrier: true,
        edgeIdx,
        segIdx,
      });
    }
  }
  return out;
}

const OBSTACLES: Obstacle[] = _buildObstacles();
// Approximate car XZ half-extent — matches sweepProjectileHit's carR=1.4 and
// the client's CarBody box (1.0, 0.6, 0.6) horizontal footprint.
const BOT_OBSTACLE_RADIUS = 1.4;

/**
 * Mark the obstacle nearest to (x, z) as destroyed, so bots stop colliding
 * with it. Called from party.ts when ANY client reports OBSTACLE_DESTROYED
 * — we authoritatively reconcile against the static layout. Barriers use
 * a tighter match (2.5u) because adjacent-edge segments cluster near the
 * octagon vertices; pillars/boulders keep the looser 4u radius.
 *
 * Returns the matched entry metadata so the caller can schedule a
 * respawn for barriers, or null if no match was found.
 */
export function markObstacleDestroyed(x: number, z: number):
  { isBarrier: boolean; edgeIdx?: number; segIdx?: number; x: number; z: number } | null {
  let bestIdx = -1;
  let bestD2 = 16; // 4u squared — default match
  for (let i = 0; i < OBSTACLES.length; i++) {
    const o = OBSTACLES[i];
    if (o.destroyed) continue;
    const maxD2 = o.isBarrier ? 6.25 : 16; // barriers: 2.5u, others: 4u
    const dx = o.posX - x;
    const dz = o.posZ - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < maxD2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  const o = OBSTACLES[bestIdx];
  o.destroyed = true;
  return {
    isBarrier: !!o.isBarrier,
    edgeIdx: o.edgeIdx,
    segIdx: o.segIdx,
    x: o.posX,
    z: o.posZ,
  };
}

/** Flip a barrier back to alive after its respawn timer elapses. */
export function markBarrierRespawned(edgeIdx: number, segIdx: number): boolean {
  for (const o of OBSTACLES) {
    if (o.isBarrier && o.edgeIdx === edgeIdx && o.segIdx === segIdx && o.destroyed) {
      o.destroyed = false;
      return true;
    }
  }
  return false;
}

/** Snapshot of currently-destroyed obstacles (for ROOM_STATE to late-joiners). */
export function getDestroyedObstacles(): Array<{ x: number; z: number; isBarrier: boolean; edgeIdx?: number; segIdx?: number }> {
  const out: Array<{ x: number; z: number; isBarrier: boolean; edgeIdx?: number; segIdx?: number }> = [];
  for (const o of OBSTACLES) {
    if (!o.destroyed) continue;
    out.push({
      x: o.posX, z: o.posZ,
      isBarrier: !!o.isBarrier,
      edgeIdx: o.edgeIdx,
      segIdx: o.segIdx,
    });
  }
  return out;
}

function _resolveObstacleCollisions(bot: BotPhysicsState): void {
  for (const o of OBSTACLES) {
    if (o.destroyed) continue;
    const dx = bot.posX - o.posX;
    const dz = bot.posZ - o.posZ;
    const r = BOT_OBSTACLE_RADIUS + o.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    const d = Math.sqrt(d2) || 0.0001;
    const nx = dx / d;
    const nz = dz / d;
    const pen = r - d;
    bot.posX += nx * pen;
    bot.posZ += nz * pen;
    // Reflect any inward velocity component with mild restitution. We damp
    // (×0.6) so a bot that hits a pillar at speed slows down rather than
    // bouncing back at full energy — matches the stunned/scuffed feel a
    // real player car gets from cannon-es contact resolution.
    const vn = bot.velX * nx + bot.velZ * nz;
    if (vn < 0) {
      const k = -vn * 1.6;
      bot.velX += nx * k;
      bot.velZ += nz * k;
    }
  }
}

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
  // Per-car kinematic limits (resolved at spawn from CAR_STATS table).
  // RHINO bots stay slow, HORNET bots stay zippy, etc.
  maxSpeed: number;
  accel: number;
  turnRate: number;
  maxAngularVel: number;
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

  // ── Personality (replaces legacy random aggression/caution) ────────────
  personalityKey: string;             // 'Aggressive' | 'Hunter' | …
  p: PersonalityParams;               // full tuning bundle (from botbrain.ts)
  // Legacy scalars still read by shouldUsePowerup and _stepBotPowerups —
  // kept in sync with personality on assign.
  aggression: number;
  caution: number;

  // ── Finite state machine ──────────────────────────────────────────────
  state: BotState;
  stateEnterAt: number;
  stateMinUntil: number;              // isteresi anti-flapping

  // ── Think-rate separation from 60Hz physics ───────────────────────────
  thinkIntervalMs: number;            // derived from reactionDelay
  nextThinkAt: number;
  desiredYaw: number;                 // cached between think ticks
  desiredThrottle: number;            // −1..1 (negative = reverse)
  steerBiasRad: number;               // flanking perpendicular bias
  steerBiasRerollAt: number;          // next ms to re-pick flank direction

  // ── Human imperfections ───────────────────────────────────────────────
  hesitationUntil: number;
  coastUntil: number;
  mistakeUntil: number; mistakeDir: number;      // −1 | 0 | 1
  overcorrectUntil: number; overcorrectDir: number;
  panicActive: boolean;
  hitRecoveryUntil: number; lastSpeedSample: number;

  // ── Environment awareness ─────────────────────────────────────────────
  threatLevel: number;                // 0..1
  stuckSince: number;                 // 0 when not stuck, else timestamp of first stall
  lastPosSampleX: number; lastPosSampleZ: number; lastPosSampleAt: number;
  dodgeUntil: number; dodgeDir: number;
  edgeDanger: boolean; predictedExitT: number;

  // ── Powerup navigation ────────────────────────────────────────────────
  pickupTargetId: string | null;
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
  const phys = _physicsFor(carType);
  const now = Date.now();
  const bot: BotPhysicsState = {
    botId,
    carType,
    maxSpeed: phys.maxSpeed,
    accel: phys.accel,
    turnRate: phys.turnRate,
    maxAngularVel: phys.maxAngularVel,
    posX: Math.cos(angle) * r,
    posY: 0.6,
    posZ: Math.sin(angle) * r,
    velX: 0,
    velY: 0,
    velZ: 0,
    yaw: Math.atan2(-Math.sin(angle), -Math.cos(angle)),
    speed: 0,
    targetId: null,
    nextRetargetAt: now,
    wanderPhase: Math.random() * Math.PI * 2,
    heldPowerup: null,
    powerupUseEarliest: 0,
    powerupReadyAt: now,
    glitchExpireAt: 0,
    lastHitById: null,
    revengeExpireAt: 0,
    // Personality assigned below by assignPersonality.
    personalityKey: '',
    p: null as unknown as PersonalityParams,
    aggression: 0.5,
    caution: 0.5,
    // FSM + think-rate
    state: 'ROAM',
    stateEnterAt: now,
    stateMinUntil: now + 400,
    thinkIntervalMs: 200,
    nextThinkAt: now + Math.floor(Math.random() * 200),
    desiredYaw: Math.atan2(-Math.sin(angle), -Math.cos(angle)),
    desiredThrottle: 0.7,
    steerBiasRad: 0,
    steerBiasRerollAt: 0,
    // Human feel
    hesitationUntil: 0,
    coastUntil: 0,
    mistakeUntil: 0, mistakeDir: 0,
    overcorrectUntil: 0, overcorrectDir: 0,
    panicActive: false,
    hitRecoveryUntil: 0, lastSpeedSample: 0,
    // Environment
    threatLevel: 0,
    stuckSince: 0,
    lastPosSampleX: Math.cos(angle) * r,
    lastPosSampleZ: Math.sin(angle) * r,
    // Delay first stuck sample to avoid spawn-invincibility false positives.
    lastPosSampleAt: now + 1000,
    dodgeUntil: 0, dodgeDir: 0,
    edgeDanger: false, predictedExitT: 0,
    // Powerup nav
    pickupTargetId: null,
  };
  assignPersonality(bot);
  return bot;
}

/**
 * Reset all transient AI state on a bot respawn. Call from party's
 * _scheduleBotRespawn so we don't carry stuck timers, dodge commits, or
 * mistake windows across deaths.
 */
export function resetBotAiState(bot: BotPhysicsState, now: number): void {
  bot.state = 'ROAM';
  bot.stateEnterAt = now;
  bot.stateMinUntil = now + 400;
  bot.nextThinkAt = now + Math.floor(Math.random() * 200);
  // Point the bot toward the arena centre on respawn so its first motion
  // isn't a stale heading from the previous life.
  bot.desiredYaw = Math.atan2(-bot.posZ, -bot.posX);
  bot.desiredThrottle = 0.7;
  bot.steerBiasRad = 0;
  bot.steerBiasRerollAt = 0;
  bot.hesitationUntil = 0;
  bot.coastUntil = 0;
  bot.mistakeUntil = 0; bot.mistakeDir = 0;
  bot.overcorrectUntil = 0; bot.overcorrectDir = 0;
  bot.panicActive = false;
  bot.hitRecoveryUntil = 0; bot.lastSpeedSample = 0;
  bot.threatLevel = 0;
  bot.stuckSince = 0;
  bot.lastPosSampleX = bot.posX;
  bot.lastPosSampleZ = bot.posZ;
  bot.lastPosSampleAt = now + 1000; // skip first sample while invincible
  bot.dodgeUntil = 0; bot.dodgeDir = 0;
  bot.edgeDanger = false; bot.predictedExitT = 0;
  bot.pickupTargetId = null;
  // Revenge/pickup inventory reset is handled by the caller (party.ts).
  // Keep personality assignment — it's a "pilot" trait, not a status effect.
}

/**
 * Backup drive behaviour when stepBot is called without a ThinkCtx (unit
 * tests, legacy callers). Produces the pre-refactor "always charge the
 * nearest target" look so nothing hangs.
 */
function _fallbackDrive(bot: BotPhysicsState, players: PlayerSnapshot[], dt: number): void {
  const target = bot.targetId
    ? players.find(p => p.id === bot.targetId && !p.isEliminated)
    : undefined;
  if (target) {
    bot.desiredYaw = Math.atan2(target.posZ - bot.posZ, target.posX - bot.posX);
    bot.desiredThrottle = 0.9;
  } else {
    bot.wanderPhase += dt * 0.8;
    bot.desiredYaw = bot.yaw + Math.sin(bot.wanderPhase) * WANDER_JITTER;
    bot.desiredThrottle = 0.5;
  }
}

/**
 * One simulation step at fixed dt. Orchestrates sense → think → act and
 * integrates physics. Mutates bot in place.
 *
 * `ctx` carries per-tick world information (projectiles, pedestals, HP
 * lookup) that higher-level AI needs. It's built once per tick in
 * party.ts#_stepBots and shared across bots — no per-bot allocation.
 */
export function stepBot(
  bot: BotPhysicsState,
  dt: number,
  players: PlayerSnapshot[],
  now: number,
  hunterCounts: Map<string, number>,
  ctx?: ThinkCtx,
): void {
  // ── Target selection / refresh (kept here because hunterCounts anti-gangup
  //    penalty + revenge scoring still live on this side). The FSM's
  //    findTarget/findNearestEnemy work with bot.targetId set by us.
  const targetValid = bot.targetId
    ? players.some(p => p.id === bot.targetId && !p.isEliminated)
    : false;
  if (!targetValid || now >= bot.nextRetargetAt) {
    bot.targetId = selectBestTarget(bot, players, hunterCounts, now);
    bot.nextRetargetAt = now + RETARGET_MIN_MS + Math.random() * (RETARGET_MAX_MS - RETARGET_MIN_MS);
  }
  if (bot.targetId) hunterCounts.set(bot.targetId, (hunterCounts.get(bot.targetId) || 0) + 1);

  const glitched = now < bot.glitchExpireAt;

  // ── AI pipeline ── Sense + maybeThink update desiredYaw/desiredThrottle on
  // the bot. Without ctx (legacy callers / tests) we fall back to a
  // simplified straight-to-target drive so the server never hangs.
  if (ctx) {
    sense(bot, ctx);
    maybeThink(bot, ctx);
  } else {
    _fallbackDrive(bot, players, dt);
  }

  // ── Act ── compute effective steering/throttle for this tick.
  const feel = ctx ? applyHumanFeel(bot, now) : { yawAdj: 0, throttleMul: 1 };

  let yawDiff = bot.desiredYaw + feel.yawAdj - bot.yaw;
  while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
  while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;

  if (glitched && Math.random() < 0.4) yawDiff = -yawDiff; // steering flip
  if (glitched && bot.targetId && Math.random() < 0.15) bot.targetId = null;

  // Speed-proportional steering — cars can't pivot in place.
  const speedFactor = Math.min(1, bot.speed / bot.maxSpeed);
  const angularVel = Math.max(-bot.maxAngularVel, Math.min(bot.maxAngularVel, yawDiff * bot.turnRate)) * speedFactor;
  bot.yaw += angularVel * dt;

  let throttle = bot.desiredThrottle * feel.throttleMul;
  if (glitched) {
    const r = Math.random();
    if (r < 0.12) throttle = 0;            // freeze
    else if (r < 0.20) throttle = -0.5;    // reverse burst
  }
  // Hit-stun: applyHumanFeel already zeroes throttle when hitRecoveryUntil > now.

  bot.velX += Math.cos(bot.yaw) * bot.accel * throttle * dt;
  bot.velZ += Math.sin(bot.yaw) * bot.accel * throttle * dt;
  bot.velX *= FRICTION;
  bot.velZ *= FRICTION;

  // Lateral friction (drift model — must mirror client CAR_FEEL behaviour).
  // Project velocity onto the heading; preserve the longitudinal component
  // and aggressively damp the lateral. This is what makes the velocity
  // vector follow the car's facing instead of drifting sideways. The
  // longitudinal component still loses energy to FRICTION above; this
  // step ONLY kills sideways slip.
  const headingX = Math.cos(bot.yaw);
  const headingZ = Math.sin(bot.yaw);
  const longComp = bot.velX * headingX + bot.velZ * headingZ;
  const longVelX = headingX * longComp;
  const longVelZ = headingZ * longComp;
  const latVelX = bot.velX - longVelX;
  const latVelZ = bot.velZ - longVelZ;
  const lf = Math.pow(LATERAL_FRICTION, dt * 60);
  bot.velX = longVelX + latVelX * lf;
  bot.velZ = longVelZ + latVelZ * lf;

  const sp = Math.hypot(bot.velX, bot.velZ);
  if (sp > bot.maxSpeed) {
    const k = bot.maxSpeed / sp;
    bot.velX *= k;
    bot.velZ *= k;
  }
  bot.speed = Math.min(sp, bot.maxSpeed);

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

  // Pillars + boulders. Run AFTER arena clamp so we never push the bot back
  // out through the perimeter wall when an obstacle sits flush against it.
  _resolveObstacleCollisions(bot);
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
    if (p.id === bot.botId || p.isEliminated || p.isInvincible) continue;
    const dx = p.posX - bot.posX;
    const dz = p.posZ - bot.posZ;
    const dist = Math.hypot(dx, dz);
    if (dist > SCORE_MAX_RANGE) continue;
    let score = (SCORE_MAX_RANGE - dist);
    if (!p.isBot) score += SCORE_HUMAN_BONUS * (0.6 + bot.aggression * 0.4);
    if (p.hp <= p.maxHp * SCORE_LOW_HP_FRAC) score += SCORE_LOW_HP_BONUS;
    const hunters = hunterCounts.get(p.id) || 0;
    if (hunters > 0) score -= hunters * SCORE_GANGUP_PENALTY;
    if (revengeActive && p.id === bot.lastHitById) {
      score += SCORE_REVENGE_BONUS * bot.p.revengeWeight;
    }
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
  // Yaw convention bridge: server bots use atan2-style heading where
  //   facing = (cos(yaw), sin(yaw))     [yaw=0 → +X]
  // Client CarBody (and therefore the remote-mesh renderer) uses
  //   forward = (-sin(yaw), -cos(yaw))  [yaw=0 → -Z]
  // Encoding bot.yaw raw made the mesh point 90°+ off from the actual
  // motion direction (visually: car appears to drive sideways or
  // backwards depending on heading). Solve (cos(S), sin(S)) =
  // (-sin(C), -cos(C)) → C = -S - π/2, applied on the wire.
  _writeFloat16(view, s + 13, -bot.yaw - Math.PI / 2);
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

  // abilityEagerness scales the effective engagement range for offensive
  // powerups. Hothead (0.95) nearly doubles ranges → fires from further away;
  // Survivor (0.35) shrinks them → only fires at point-blank.
  const eager = bot.p.abilityEagerness;
  const rangeScale = 0.7 + eager * 0.6;

  switch (type) {
    case 'MISSILE':
      // Fires straight from the nose — only worth it when a target is in
      // the bot's forward cone at sensible range AND we're in a committed
      // attack state so we don't fire while swerving for a powerup.
      if (!nearestInFront || nearestInFrontDist > 40 * rangeScale) return false;
      return bot.state === 'CHARGE' || bot.state === 'HUNT' || bot.state === 'EVADE';

    case 'HOMING_MISSILE':
      // Client BotBrain fires homing when an enemy is within ~35u — tighter
      // than the missile's 80u seek radius so bots don't waste the pickup
      // on distant targets that might escape the lock.
      return nearestDist <= 35 * rangeScale;

    case 'AUTO_TURRET':
      // Turret auto-aims; drop it when at least one enemy is in its range.
      // Eager bots deploy proactively even when no one's inside the tight ring.
      return enemiesMid >= 1 || (enemiesFar >= 1 && eager > 0.7);

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
      // Fire holo during active panic (EVADE/FLEE, or an incoming projectile
      // dodge commit) — matches "use when threatened" BotBrain behaviour.
      const panicking = bot.state === 'EVADE' || bot.state === 'FLEE' || now < bot.dodgeUntil;
      return lowHp || !!charger || panicking;
    }

    default:
      return false;
  }
}
