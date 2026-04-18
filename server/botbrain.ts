/**
 * server/botbrain.ts — pure, side-effect-free helpers that give server bots
 * a human-like "brain". stepBot() in botsim.ts is now a thin orchestrator:
 *
 *   sense()      — perception (hit, stuck, edge, projectile dodge, threat)
 *   maybeThink() — FSM + desired-yaw/throttle cache, only every ~200ms
 *   applyHumanFeel() — noise, mistake, overcorrect, coast, panic, dodge bias
 *   leadAimYaw() — intercept solver for MISSILE aiming
 *
 * All functions mutate `BotPhysicsState` fields only — no module-level state.
 * This keeps the sim per-room, serialisable, and race-free across PartyKit
 * rooms.
 *
 * Personality presets mirror client/src/ai/BotPersonalities.js so server and
 * offline bots feel consistent.
 */

import type { BotPhysicsState, PlayerSnapshot } from './botsim.js';
import { MISSILE as MISSILE_PROJ } from './projectilesim.js';

const TWO_PI = Math.PI * 2;

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

// ── FSM states ────────────────────────────────────────────────────────────

export type BotState =
  | 'ROAM'
  | 'HUNT'
  | 'CHARGE'
  | 'EVADE'
  | 'FLEE'
  | 'POWERUP_SEEK'
  | 'STUCK';

// ── Personality table (mirrors client BotPersonalities.js) ────────────────

export interface PersonalityParams {
  targetRange: number;
  chargeSpeed: number;        // 0..1.3 max throttle during charge
  evadeThreshold: number;     // threat level that triggers EVADE
  powerupWeight: number;      // how strongly bot seeks pickups
  abilityEagerness: number;   // scales shouldUsePowerup permissiveness
  roamTime: number;
  reactionDelay: number;      // seconds before new input registers
  steerNoise: number;         // radians of wobble per tick
  mistakeChance: number;      // per-think probability of brief wrong turn
  coastChance: number;        // per-think probability of releasing throttle
  overcommit: number;         // how long bot keeps charging when it should bail
  panicThreshold: number;     // hp FRACTION (0..1) below which FLEE + panic
  dodgeSkill: number;         // 0..1 probability of reacting to incoming proj
  flankBias: number;          // 0..1 perpendicular bias during HUNT
  revengeWeight: number;      // 0..1 scales revenge score bonus
  momentumCommit: number;     // seconds to stick with a direction
  throttleAggression: number; // 0..1 base throttle
  combatPersistence: number;  // scales CHARGE dwell time
  // Derived scalars used by legacy code paths in botsim/party.
  aggression: number;
  caution: number;
}

function derived(base: Omit<PersonalityParams, 'aggression' | 'caution'>): PersonalityParams {
  const aggression = clamp01(
    0.35 * base.throttleAggression + 0.4 * Math.min(1, base.chargeSpeed) + 0.25 * base.combatPersistence,
  );
  const caution = clamp01(
    0.5 * base.powerupWeight + 0.3 * base.dodgeSkill + 0.2 * (1 - base.throttleAggression),
  );
  return { ...base, aggression, caution };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export const PERSONALITIES: Record<string, PersonalityParams> = {
  Aggressive: derived({
    targetRange: 32, chargeSpeed: 1.0, evadeThreshold: 0.25, powerupWeight: 0.25,
    abilityEagerness: 0.85, roamTime: 0.8,
    reactionDelay: 0.18, steerNoise: 0.07, mistakeChance: 0.008, coastChance: 0.03,
    overcommit: 0.6, panicThreshold: 0.25, dodgeSkill: 0.55, flankBias: 0.1,
    revengeWeight: 0.6, momentumCommit: 0.3, throttleAggression: 0.9, combatPersistence: 0.8,
  }),
  Defensive: derived({
    targetRange: 20, chargeSpeed: 0.7, evadeThreshold: 0.5, powerupWeight: 0.8,
    abilityEagerness: 0.4, roamTime: 1.8,
    reactionDelay: 0.25, steerNoise: 0.03, mistakeChance: 0.005, coastChance: 0.06,
    overcommit: 0.15, panicThreshold: 0.4, dodgeSkill: 0.7, flankBias: 0.3,
    revengeWeight: 0.2, momentumCommit: 0.25, throttleAggression: 0.5, combatPersistence: 0.35,
  }),
  Kamikaze: derived({
    targetRange: 45, chargeSpeed: 1.3, evadeThreshold: 0.08, powerupWeight: 0.05,
    abilityEagerness: 1.0, roamTime: 0.4,
    reactionDelay: 0.12, steerNoise: 0.1, mistakeChance: 0.012, coastChance: 0.01,
    overcommit: 1.2, panicThreshold: 0.1, dodgeSkill: 0.2, flankBias: 0.0,
    revengeWeight: 0.3, momentumCommit: 0.5, throttleAggression: 1.0, combatPersistence: 0.95,
  }),
  Hunter: derived({
    targetRange: 38, chargeSpeed: 0.85, evadeThreshold: 0.3, powerupWeight: 0.5,
    abilityEagerness: 0.7, roamTime: 1.0,
    reactionDelay: 0.2, steerNoise: 0.04, mistakeChance: 0.004, coastChance: 0.04,
    overcommit: 0.3, panicThreshold: 0.3, dodgeSkill: 0.65, flankBias: 0.5,
    revengeWeight: 0.15, momentumCommit: 0.35, throttleAggression: 0.7, combatPersistence: 0.6,
  }),
  Brawler: derived({
    targetRange: 25, chargeSpeed: 1.1, evadeThreshold: 0.2, powerupWeight: 0.35,
    abilityEagerness: 0.9, roamTime: 0.6,
    reactionDelay: 0.15, steerNoise: 0.08, mistakeChance: 0.01, coastChance: 0.02,
    overcommit: 0.8, panicThreshold: 0.2, dodgeSkill: 0.35, flankBias: 0.05,
    revengeWeight: 0.8, momentumCommit: 0.4, throttleAggression: 0.95, combatPersistence: 0.9,
  }),
  Trickster: derived({
    targetRange: 28, chargeSpeed: 0.9, evadeThreshold: 0.35, powerupWeight: 0.6,
    abilityEagerness: 0.8, roamTime: 1.2,
    reactionDelay: 0.22, steerNoise: 0.12, mistakeChance: 0.006, coastChance: 0.08,
    overcommit: 0.2, panicThreshold: 0.35, dodgeSkill: 0.75, flankBias: 0.8,
    revengeWeight: 0.1, momentumCommit: 0.15, throttleAggression: 0.6, combatPersistence: 0.4,
  }),
  Survivor: derived({
    targetRange: 22, chargeSpeed: 0.6, evadeThreshold: 0.55, powerupWeight: 0.9,
    abilityEagerness: 0.35, roamTime: 2.2,
    reactionDelay: 0.28, steerNoise: 0.03, mistakeChance: 0.003, coastChance: 0.07,
    overcommit: 0.1, panicThreshold: 0.5, dodgeSkill: 0.8, flankBias: 0.4,
    revengeWeight: 0.05, momentumCommit: 0.2, throttleAggression: 0.45, combatPersistence: 0.2,
  }),
  Hothead: derived({
    targetRange: 35, chargeSpeed: 1.15, evadeThreshold: 0.15, powerupWeight: 0.2,
    abilityEagerness: 0.95, roamTime: 0.5,
    reactionDelay: 0.1, steerNoise: 0.09, mistakeChance: 0.015, coastChance: 0.02,
    overcommit: 1.0, panicThreshold: 0.15, dodgeSkill: 0.3, flankBias: 0.0,
    revengeWeight: 1.0, momentumCommit: 0.5, throttleAggression: 1.0, combatPersistence: 0.85,
  }),
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

export function randomPersonalityKey(): string {
  return PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
}

export function assignPersonality(bot: BotPhysicsState, key?: string): void {
  const k = key && PERSONALITIES[key] ? key : randomPersonalityKey();
  bot.personalityKey = k;
  bot.p = PERSONALITIES[k];
  bot.thinkIntervalMs = 150 + bot.p.reactionDelay * 400; // ~190..262ms
  // Do NOT touch bot.nextThinkAt here — createBot stagggers it per-bot so the
  // whole swarm doesn't think on the same tick (thundering herd).
  // Keep legacy scalar fields in sync (still read by shouldUsePowerup / party).
  bot.aggression = bot.p.aggression;
  bot.caution = bot.p.caution;
}

// ── Context types (structurally compatible with ServerProjectile) ─────────

export interface IncomingProjectile {
  attackerId: string;
  posX: number;
  posZ: number;
  velX: number;
  velZ: number;
}

export interface PedestalSample {
  id: string;
  type: string;
  posX: number;
  posZ: number;
}

export interface ThinkCtx {
  players: PlayerSnapshot[];
  hpLookup: (id: string) => number;
  maxHp: number;
  hunterCounts: Map<string, number>;
  projectiles: IncomingProjectile[];
  pedestals: PedestalSample[];
  now: number;
}

// Arena constants — must agree with botsim.ts octagon clamp.
const ARENA_APOTHEM = 60 * Math.cos(Math.PI / 8);
const SAFE_OUTER = ARENA_APOTHEM - 6;

/**
 * Returns a yaw that steers along the edge (tangent) in the direction the bot
 * is already moving, blended 70/30 with "toward center" as a safety bleed so a
 * slow bot doesn't just graze the wall indefinitely. Replaces the naive
 * `atan2(-posZ, -posX)` which could turn the bot directly THROUGH the wall.
 */
function edgeTangentYaw(bot: BotPhysicsState): number {
  // Outward normal approximated by unit vector from center.
  const r = Math.hypot(bot.posX, bot.posZ) || 1;
  const nx = bot.posX / r;
  const nz = bot.posZ / r;
  // Two tangent candidates: (-nz, nx) and (nz, -nx). Pick the one that
  // aligns with current motion — but require a meaningful speed threshold
  // so sub-threshold velZ/velX sign noise doesn't flip the choice every
  // tick (observed: zig-zag near +x axis when velZ ≈ 0).
  const tAx = -nz, tAz = nx;
  const speed2 = bot.velX * bot.velX + bot.velZ * bot.velZ;
  let tx: number, tz: number;
  if (speed2 > 1) {
    const dotA = bot.velX * tAx + bot.velZ * tAz;
    const pick = dotA >= 0;
    tx = pick ? tAx : -tAx;
    tz = pick ? tAz : -tAz;
  } else {
    // Below 1 u/s: use the bot's current yaw to choose the tangent so the
    // decision is stable while crawling / stuck near the edge.
    const fwdX = Math.cos(bot.yaw);
    const fwdZ = Math.sin(bot.yaw);
    const dotA = fwdX * tAx + fwdZ * tAz;
    const pick = dotA >= 0;
    tx = pick ? tAx : -tAx;
    tz = pick ? tAz : -tAz;
  }
  const tangentYaw = Math.atan2(tz, tx);
  const centerYaw = Math.atan2(-bot.posZ, -bot.posX);
  // Spherical blend (slerp-ish): preserve unit length so angles within the
  // full ±π range blend correctly, not just <90°.
  const w = 0.3; // pull inward weight
  const bx = (1 - w) * Math.cos(tangentYaw) + w * Math.cos(centerYaw);
  const bz = (1 - w) * Math.sin(tangentYaw) + w * Math.sin(centerYaw);
  return Math.atan2(bz, bx);
}

// ── Sensing ───────────────────────────────────────────────────────────────

/**
 * Per-tick perception: decays timers implicitly, flags stuck/edge/dodge, and
 * recomputes threatLevel. Cheap — this runs every physics tick (60Hz).
 */
export function sense(bot: BotPhysicsState, ctx: ThinkCtx): void {
  if (!bot.p) return; // Defensive: personality not yet assigned.
  const now = ctx.now;

  // Hit detection: sharp speed drop while the bot was actively driving.
  // We require desiredThrottle > 0.5 so a voluntary coast (throttleMul=0.2,
  // up to 220ms) isn't mistaken for a crash, and lastSpeedSample > 10 so
  // tail-end FRICTION decay at low speed doesn't trigger. The 0.55 ratio
  // still catches wall/obstacle impacts (typically kill 60%+ of speed).
  if (
    bot.lastSpeedSample > 10 &&
    bot.speed < bot.lastSpeedSample * 0.55 &&
    bot.hitRecoveryUntil < now &&
    now >= bot.coastUntil &&
    bot.desiredThrottle > 0.5
  ) {
    bot.hitRecoveryUntil = now + 200 + Math.random() * 150;
  }
  bot.lastSpeedSample = bot.speed;

  // Stuck sampler (every ~500ms). We skip during hit-recovery because the Act
  // phase zeroes throttle → velocity decays independently of a real wedge.
  if (bot.lastPosSampleAt === 0 || now - bot.lastPosSampleAt >= 500) {
    if (bot.lastPosSampleAt !== 0 && now >= bot.hitRecoveryUntil) {
      const moved = Math.hypot(bot.posX - bot.lastPosSampleX, bot.posZ - bot.lastPosSampleZ);
      if (moved < 0.6 && bot.desiredThrottle > 0.3 && bot.state !== 'STUCK') {
        bot.stuckSince = bot.stuckSince || now;
      } else {
        bot.stuckSince = 0;
      }
    }
    bot.lastPosSampleX = bot.posX;
    bot.lastPosSampleZ = bot.posZ;
    bot.lastPosSampleAt = now;
  }

  // Edge prediction — octagon projection ~0.6s lookahead.
  const lookahead = 0.6;
  const futureX = bot.posX + bot.velX * lookahead;
  const futureZ = bot.posZ + bot.velZ * lookahead;
  let maxProj = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2 - Math.PI / 8;
    const proj = futureX * Math.cos(a) + futureZ * Math.sin(a);
    if (proj > maxProj) maxProj = proj;
  }
  bot.edgeDanger = maxProj > SAFE_OUTER - 1;
  bot.predictedExitT = maxProj - SAFE_OUTER;

  // Projectile dodge — only commit one dodge at a time.
  //
  // dodgeDir must be expressed in the bot's STEER frame (+1 = turn left, −1 =
  // turn right) because applyHumanFeel adds `0.8 * dodgeDir` directly to
  // desiredYaw. The previous formulation used only the side of the projectile
  // heading, which produced "dodge into the missile" when the projectile came
  // from behind the bot.
  //
  // Derivation: let `cross = projVel × (bot − proj)`. Its sign picks which
  // side of the projectile path the bot is on ("away" strafe direction).
  // Whether that strafe is on the bot's LEFT or RIGHT in steer-space comes
  // from the sign of `projVel · fwd(bot.yaw)` — positive when the projectile
  // is travelling in roughly the same direction the bot faces, negative when
  // it's coming head-on. Product of the two signs gives the turn direction.
  if (ctx.projectiles.length > 0 && bot.p.dodgeSkill > 0 && bot.dodgeUntil < now) {
    const inc = detectIncomingProjectile(bot, ctx.projectiles);
    if (inc && Math.random() < bot.p.dodgeSkill) {
      const cross = inc.velX * (bot.posZ - inc.posZ) - inc.velZ * (bot.posX - inc.posX);
      const vDotFwd = inc.velX * Math.cos(bot.yaw) + inc.velZ * Math.sin(bot.yaw);
      bot.dodgeDir = cross * vDotFwd >= 0 ? 1 : -1;
      bot.dodgeUntil = now + 450;
    }
  }

  // Threat level.
  let threat = 0;
  const hp = ctx.hpLookup(bot.botId);
  const hpFrac = hp / ctx.maxHp;
  if (hpFrac < bot.p.panicThreshold) threat += 0.45;
  if (bot.edgeDanger) threat += 0.2;
  if (bot.dodgeUntil > now) threat += 0.25;
  let nearCount = 0;
  for (const p of ctx.players) {
    if (p.id === bot.botId || p.isEliminated) continue;
    const dx = p.posX - bot.posX;
    const dz = p.posZ - bot.posZ;
    if (dx * dx + dz * dz < 144) nearCount++; // 12u radius
  }
  if (nearCount >= 2) threat += 0.15 * (nearCount - 1);
  bot.threatLevel = threat > 1 ? 1 : threat;
}

// ── Think (FSM + desired state) ───────────────────────────────────────────

/** Runs think() at most every `thinkIntervalMs`. Returns whether it fired. */
export function maybeThink(bot: BotPhysicsState, ctx: ThinkCtx): boolean {
  const now = ctx.now;
  if (now < bot.nextThinkAt) return false;
  // Preserve inter-bot stagger: advance from whichever is later (now or the
  // scheduled nextThinkAt), plus exactly one interval. Previous form
  // `max(now+i, next+i)` compressed the stagger distribution toward the top
  // of the random range over time.
  bot.nextThinkAt = Math.max(now, bot.nextThinkAt) + bot.thinkIntervalMs;
  think(bot, ctx);
  return true;
}

export function think(bot: BotPhysicsState, ctx: ThinkCtx): void {
  const now = ctx.now;
  const hp = ctx.hpLookup(bot.botId);
  const hpFrac = hp / ctx.maxHp;
  const p = bot.p;
  const canSwitch = now >= bot.stateMinUntil;

  // STUCK is mandatory (triggered by sense()).
  if (bot.stuckSince && now - bot.stuckSince > 1500 && bot.state !== 'STUCK') {
    setState(bot, 'STUCK', now, 800);
    bot.stuckSince = 0;
  }
  if (bot.state === 'STUCK') {
    // Just reverse — don't try to flip yaw, or the target keeps receding
    // as the bot rotates and we spin in place forever. Reversing along
    // current heading pushes the bot off whatever it's wedged against.
    bot.desiredYaw = bot.yaw;
    bot.desiredThrottle = -0.6;
    if (now >= bot.stateMinUntil) {
      bot.targetId = null;
      // Return to FLEE if HP is still panic-threshold low, otherwise ROAM.
      // Previously a wedged FLEE-bot always exited to ROAM and then took
      // another 400ms to re-enter FLEE (brief low-HP charge outward).
      const nextState: BotState = hpFrac < p.panicThreshold ? 'FLEE' : 'ROAM';
      setState(bot, nextState, now, nextState === 'FLEE' ? 600 : 400);
    }
    return;
  }

  // FLEE entry (low HP). Hysteresis on exit.
  if (canSwitch && hpFrac < p.panicThreshold && bot.state !== 'FLEE') {
    setState(bot, 'FLEE', now, 600);
  } else if (bot.state === 'FLEE' && hpFrac > p.panicThreshold + 0.15) {
    setState(bot, 'HUNT', now, 400);
  }

  // POWERUP_SEEK entry — unarmed, calm, pedestal in range.
  if (
    canSwitch &&
    !bot.heldPowerup &&
    bot.state !== 'FLEE' &&
    bot.state !== 'EVADE' &&
    bot.threatLevel < 0.5
  ) {
    if (bot.state === 'ROAM' || bot.state === 'HUNT') {
      const best = pickBestPedestal(bot, ctx);
      if (best) {
        bot.pickupTargetId = best.id;
        setState(bot, 'POWERUP_SEEK', now, 400);
      }
    }
  }
  // Preempt if threat spikes, pickup acquired, or dwelling too long (stalled
  // on the pedestal, blocked by pillar/other bot, etc.).
  if (
    bot.state === 'POWERUP_SEEK' &&
    (bot.threatLevel > 0.6 || bot.heldPowerup || now - bot.stateEnterAt > 5000)
  ) {
    bot.pickupTargetId = null;
    setState(bot, 'HUNT', now, 300);
  }

  // EVADE escalation mid-combat.
  if (
    canSwitch &&
    bot.state !== 'FLEE' &&
    bot.state !== 'EVADE' &&
    bot.threatLevel > p.evadeThreshold &&
    hpFrac < 0.6
  ) {
    setState(bot, 'EVADE', now, 500);
  }

  // Dispatch
  switch (bot.state) {
    case 'FLEE':         thinkFlee(bot, ctx); break;
    case 'EVADE':        thinkEvade(bot, ctx); break;
    case 'POWERUP_SEEK': thinkPowerupSeek(bot, ctx); break;
    case 'CHARGE':       thinkCharge(bot, ctx); break;
    case 'HUNT':         thinkHunt(bot, ctx); break;
    case 'ROAM':
    default:             thinkRoam(bot, ctx); break;
  }

  // Occasional imperfections scheduled per think.
  if (Math.random() < p.mistakeChance && bot.mistakeUntil < now) {
    bot.mistakeUntil = now + 150 + Math.random() * 200;
    bot.mistakeDir = Math.random() < 0.5 ? -1 : 1;
    bot.overcorrectUntil = bot.mistakeUntil + 200;
    bot.overcorrectDir = -bot.mistakeDir;
  }
  if (Math.random() < p.coastChance && bot.coastUntil < now) {
    bot.coastUntil = now + 100 + Math.random() * 120;
  }
  bot.panicActive = hpFrac < p.panicThreshold;
}

function setState(bot: BotPhysicsState, s: BotState, now: number, minMs: number): void {
  bot.state = s;
  bot.stateEnterAt = now;
  bot.stateMinUntil = now + minMs;
  if (s === 'CHARGE') {
    // brief hesitation pre-commit — humans don't instantly floor it into contact.
    bot.hesitationUntil = now + 150 + Math.random() * 200;
  }
  if (s === 'HUNT') {
    // Drop stale flank bias — leaving it set would make a bot returning from
    // CHARGE keep last engagement's perpendicular offset and orbit the new
    // target until the momentumCommit timer expired.
    bot.steerBiasRad = 0;
    bot.steerBiasRerollAt = 0;
  }
}

// ── Per-state intents ─────────────────────────────────────────────────────

function thinkRoam(bot: BotPhysicsState, ctx: ThinkCtx): void {
  // Previous wander used desired = bot.yaw + sin(phase)*amp which caused a
  // drift loop (the "anchor" rotated with the bot → bots spiralled). Anchor
  // on an absolute direction (toward arena center) and wobble around it.
  bot.wanderPhase += 0.15;
  const roamAnchor = Math.atan2(-bot.posZ, -bot.posX);
  let desired = roamAnchor + Math.sin(bot.wanderPhase) * 0.35;
  if (bot.edgeDanger) desired = edgeTangentYaw(bot);
  bot.desiredYaw = desired;
  // Bump ROAM throttle floor so bots don't crawl while exploring.
  bot.desiredThrottle = 0.65 + bot.p.throttleAggression * 0.25;
  bot.steerBiasRad = 0;

  // Promote to HUNT whenever we have a selected target — selectBestTarget
  // already filters to within SCORE_MAX_RANGE (55u), so any live target is
  // worth pursuing. The previous `dist < p.targetRange` gate kept Defensive
  // (targetRange=20) bots stuck in ROAM whenever enemies were just slightly
  // further than 20u away — lots of aimless driving.
  //
  // roamTime is the personality's MINIMUM roam dwell. We block early HUNT
  // transitions until `stateEnterAt + roamTime*1000` so Survivor (2.2s)
  // actually explores while Kamikaze (0.4s) engages immediately.
  const minDwelled = ctx.now - bot.stateEnterAt >= bot.p.roamTime * 1000;
  if (minDwelled && (bot.targetId || findNearestEnemy(bot, ctx))) {
    setState(bot, 'HUNT', ctx.now, 300);
  }
}

function thinkHunt(bot: BotPhysicsState, ctx: ThinkCtx): void {
  const target = findTarget(bot, ctx);
  if (!target) {
    setState(bot, 'ROAM', ctx.now, 200);
    thinkRoam(bot, ctx);
    return;
  }
  const baseYaw = Math.atan2(target.p.posZ - bot.posZ, target.p.posX - bot.posX);
  // Flanking commit: reroll direction only every `momentumCommit` seconds so
  // the bot doesn't zig-zag. First entry also triggers a reroll (bias==0).
  if (bot.steerBiasRad === 0 || ctx.now >= bot.steerBiasRerollAt) {
    // Max 18° (π/10) instead of 36° — previously bots orbited the target.
    bot.steerBiasRad = (Math.random() < 0.5 ? 1 : -1) * bot.p.flankBias * (Math.PI / 10);
    bot.steerBiasRerollAt = ctx.now + bot.p.momentumCommit * 1000;
  }
  // Fade the lateral bias to ZERO at the CHARGE handoff (0.6×targetRange).
  // Previous `dist/targetRange` floored at 0.6 in HUNT, which left Trickster
  // with ~8° residual curve even at close range — enough to orbit.
  const chargeAt = bot.p.targetRange * 0.6;
  const huntBand = bot.p.targetRange - chargeAt; // 0.4× range
  const closeFrac = Math.max(0, Math.min(1, (target.dist - chargeAt) / huntBand));
  bot.desiredYaw = baseYaw + bot.steerBiasRad * closeFrac;
  // HUNT throttle — bumped so the bot actually travels at something close to
  // maxSpeed. Previously = p.throttleAggression (0.45..1.0), which meant
  // Survivor drove at 45% of its stat max and felt artificially slow.
  bot.desiredThrottle = 0.75 + bot.p.throttleAggression * 0.25;
  if (bot.edgeDanger) bot.desiredYaw = edgeTangentYaw(bot);
  if (target.dist < bot.p.targetRange * 0.6) {
    // CHARGE dwell scaled by combatPersistence (kamikaze sticks, survivor bails).
    const dwellMs = 350 + bot.p.combatPersistence * 800;
    setState(bot, 'CHARGE', ctx.now, dwellMs);
  } else if (target.dist > bot.p.targetRange * 1.5) {
    setState(bot, 'ROAM', ctx.now, 400);
  }
}

function thinkCharge(bot: BotPhysicsState, ctx: ThinkCtx): void {
  const target = findTarget(bot, ctx);
  if (!target) {
    setState(bot, 'ROAM', ctx.now, 200);
    thinkRoam(bot, ctx);
    return;
  }
  const dx = target.p.posX - bot.posX;
  const dz = target.p.posZ - bot.posZ;
  let desired: number;
  if (bot.heldPowerup === 'MISSILE') {
    const projSpeed = Math.max(bot.speed * MISSILE_PROJ.speedScale, MISSILE_PROJ.speedMin);
    desired = leadAimYaw(
      bot.posX, bot.posZ,
      target.p.posX, target.p.posZ,
      target.p.velX, target.p.velZ,
      projSpeed,
    );
  } else {
    desired = Math.atan2(dz, dx);
  }
  bot.desiredYaw = desired;
  const yawDiff = Math.abs(normalizeAngle(desired - bot.yaw));
  const turnSlow = Math.max(0.4, 1 - yawDiff / Math.PI); // slow into tight turns
  bot.desiredThrottle = Math.min(1, bot.p.chargeSpeed) * turnSlow;
  if (ctx.now < bot.hesitationUntil) bot.desiredThrottle = 0;
  if (bot.edgeDanger) bot.desiredYaw = edgeTangentYaw(bot);

  const hpFrac = ctx.hpLookup(bot.botId) / ctx.maxHp;
  // Overcommit: stubborn bots (Kamikaze 1.2s) keep charging under threat;
  // cautious bots (Survivor 0.1s) bail almost immediately.
  const dwelled = ctx.now - bot.stateEnterAt;
  const overcommitMs = bot.p.overcommit * 1000;
  if (bot.threatLevel > 0.7 && hpFrac < 0.4 && dwelled >= overcommitMs) {
    setState(bot, 'EVADE', ctx.now, 400);
  } else if (target.dist > bot.p.targetRange * 0.8) {
    setState(bot, 'HUNT', ctx.now, 300);
  }
}

function thinkEvade(bot: BotPhysicsState, ctx: ThinkCtx): void {
  const nearest = findNearestEnemy(bot, ctx);
  if (!nearest) {
    setState(bot, 'ROAM', ctx.now, 200);
    thinkRoam(bot, ctx);
    return;
  }
  const awayYaw = Math.atan2(bot.posZ - nearest.p.posZ, bot.posX - nearest.p.posX);
  const dodgeBias = bot.dodgeUntil > ctx.now ? bot.dodgeDir * 0.6 : 0;
  bot.desiredYaw = awayYaw + dodgeBias;
  bot.desiredThrottle = 1.0;
  if (bot.edgeDanger) bot.desiredYaw = edgeTangentYaw(bot);
  if (bot.threatLevel < 0.3) setState(bot, 'HUNT', ctx.now, 250);
}

function thinkFlee(bot: BotPhysicsState, ctx: ThinkCtx): void {
  // Prefer to run toward REPAIR_KIT; fall back to away-from-crowd + edge avoid.
  const repair = ctx.pedestals.find(q => q.type === 'REPAIR_KIT');
  const ped = repair || pickBestPedestal(bot, ctx);
  if (ped) {
    bot.desiredYaw = Math.atan2(ped.posZ - bot.posZ, ped.posX - bot.posX);
  } else {
    const nearest = findNearestEnemy(bot, ctx);
    bot.desiredYaw = nearest
      ? Math.atan2(bot.posZ - nearest.p.posZ, bot.posX - nearest.p.posX)
      : bot.yaw;
  }
  bot.desiredThrottle = 1.0;
  if (bot.edgeDanger) bot.desiredYaw = edgeTangentYaw(bot);
}

function thinkPowerupSeek(bot: BotPhysicsState, ctx: ThinkCtx): void {
  const ped = ctx.pedestals.find(q => q.id === bot.pickupTargetId);
  if (!ped) {
    bot.pickupTargetId = null;
    setState(bot, 'ROAM', ctx.now, 200);
    thinkRoam(bot, ctx);
    return;
  }
  bot.desiredYaw = Math.atan2(ped.posZ - bot.posZ, ped.posX - bot.posX);
  bot.desiredThrottle = 0.95;
  if (bot.edgeDanger) bot.desiredYaw = edgeTangentYaw(bot);
}

// ── Target helpers ────────────────────────────────────────────────────────

function findNearestEnemy(
  bot: BotPhysicsState,
  ctx: ThinkCtx,
): { p: PlayerSnapshot; dist: number } | null {
  let best: PlayerSnapshot | null = null;
  let bestD = Infinity;
  for (const p of ctx.players) {
    if (p.id === bot.botId || p.isEliminated || p.isInvincible) continue;
    const dx = p.posX - bot.posX;
    const dz = p.posZ - bot.posZ;
    const d = Math.hypot(dx, dz);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { p: best, dist: bestD } : null;
}

function findTarget(
  bot: BotPhysicsState,
  ctx: ThinkCtx,
): { p: PlayerSnapshot; dist: number } | null {
  if (bot.targetId) {
    const t = ctx.players.find(p => p.id === bot.targetId && !p.isEliminated && !p.isInvincible);
    if (t) {
      const d = Math.hypot(t.posX - bot.posX, t.posZ - bot.posZ);
      return { p: t, dist: d };
    }
    // Target went invincible (respawn) or vanished — drop and re-pick.
    bot.targetId = null;
  }
  return findNearestEnemy(bot, ctx);
}

function pickBestPedestal(bot: BotPhysicsState, ctx: ThinkCtx): PedestalSample | null {
  if (ctx.pedestals.length === 0) return null;
  let best: PedestalSample | null = null;
  let bestScore = -Infinity;
  for (const q of ctx.pedestals) {
    const d = Math.hypot(q.posX - bot.posX, q.posZ - bot.posZ);
    if (d > 35) continue;
    const score = bot.p.powerupWeight * (35 - d);
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

// ── Human-feel modifiers (applied during Act phase each tick) ─────────────

/**
 * Returns yaw/throttle perturbations for this tick. The caller adds yawAdj
 * to desiredYaw when computing steering, and multiplies throttle by throttleMul.
 */
export function applyHumanFeel(
  bot: BotPhysicsState,
  now: number,
): { yawAdj: number; throttleMul: number } {
  let yawAdj = (Math.random() - 0.5) * bot.p.steerNoise;
  let throttleMul = 1;

  if (now < bot.mistakeUntil) {
    yawAdj += 0.7 * bot.mistakeDir;
  } else if (now < bot.overcorrectUntil) {
    yawAdj += 0.35 * bot.overcorrectDir;
  }
  if (now < bot.coastUntil) throttleMul *= 0.2;
  if (bot.panicActive) yawAdj += (Math.random() - 0.5) * 0.3;
  if (now < bot.dodgeUntil) yawAdj += 0.8 * bot.dodgeDir;
  if (now < bot.hitRecoveryUntil) throttleMul = 0;

  return { yawAdj, throttleMul };
}

// ── Target leading ────────────────────────────────────────────────────────

/**
 * Iterative intercept solver (3 Newton iterations). Returns the yaw angle
 * the shooter should aim to intersect a target moving at (tgtVX, tgtVZ) with
 * a straight-line projectile of constant speed `projSpeed`. Falls back to
 * direct aim if the solution diverges (target faster than projectile or
 * unreachable).
 */
export function leadAimYaw(
  fromX: number, fromZ: number,
  tgtX: number, tgtZ: number,
  tgtVX: number, tgtVZ: number,
  projSpeed: number,
): number {
  if (projSpeed <= 0) return Math.atan2(tgtZ - fromZ, tgtX - fromX);
  let t = 0;
  for (let i = 0; i < 3; i++) {
    const predX = tgtX + tgtVX * t;
    const predZ = tgtZ + tgtVZ * t;
    const dist = Math.hypot(predX - fromX, predZ - fromZ);
    const newT = dist / projSpeed;
    if (!Number.isFinite(newT) || newT > 3) {
      return Math.atan2(tgtZ - fromZ, tgtX - fromX);
    }
    t = newT;
  }
  return Math.atan2(tgtZ + tgtVZ * t - fromZ, tgtX + tgtVX * t - fromX);
}

// ── Projectile dodge sensor ───────────────────────────────────────────────

/**
 * Returns the earliest-to-impact projectile that will pass within a 2m bubble
 * around the bot within 0.8s, or null. Filters self-fired projectiles.
 */
export function detectIncomingProjectile(
  bot: BotPhysicsState,
  projs: IncomingProjectile[],
): IncomingProjectile | null {
  const HORIZON = 0.8;
  const BUBBLE = 2.0;
  let best: IncomingProjectile | null = null;
  let bestT = Infinity;
  for (const pr of projs) {
    if (pr.attackerId === bot.botId) continue;
    const rx = pr.posX - bot.posX;
    const rz = pr.posZ - bot.posZ;
    const vx = pr.velX;
    const vz = pr.velZ;
    const v2 = vx * vx + vz * vz;
    if (v2 < 1) continue;
    // Time to closest approach on the infinite line.
    const tApproach = -(rx * vx + rz * vz) / v2;
    if (tApproach <= 0 || tApproach > HORIZON) continue;
    const cx = rx + vx * tApproach;
    const cz = rz + vz * tApproach;
    const dMin = Math.hypot(cx, cz);
    if (dMin > BUBBLE) continue;
    if (tApproach < bestT) { bestT = tApproach; best = pr; }
  }
  return best;
}
