import * as CANNON from 'cannon-es';
import { ARENA } from '../core/Config.js';

/**
 * BotBrain — per-bot AI with human-like behaviour and imperfections.
 *
 * States: ROAM → HUNT → CHARGE → EVADE → FLEE  (+ POWERUP_SEEK)
 *
 * Key design goals:
 * - Bots are ALWAYS moving — no standing still
 * - Mistakes are gradual and natural (overcorrection, hesitation, tunnel vision)
 * - Evasion is imperfect — sometimes they dodge wrong, sometimes they don't dodge at all
 * - Each personality feels distinctly different
 * - Revenge memory and threat awareness create emergent drama
 * - Momentum commitment prevents jittery, robotic direction changes
 */

const TWO_PI = Math.PI * 2;
const ARENA_RADIUS = ARENA.diameter / 2;
const LAVA_RADIUS = ARENA.lava.radius;
const SAFE_INNER = LAVA_RADIUS + 4;
// Octagon apothem (shortest distance from center to edge) = R * cos(π/8)
// This is where cars ACTUALLY fall off — not at the vertex radius
const ARENA_APOTHEM = ARENA_RADIUS * Math.cos(Math.PI / 8); // ~55.4 for R=60
const SAFE_OUTER = ARENA_APOTHEM - 6; // ~49.4 — comfortable margin from real edge
const DANGER_OUTER = ARENA_APOTHEM - 3; // ~52.4 — getting close to real edge

// Reusable raycast objects
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

// ── Utility ──────────────────────────────────────────────────────────
function normalizeAngle(a) {
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }

export class BotBrain {
  constructor(carBody, ability, personality, getOtherBodies, opts = {}) {
    this.carBody = carBody;
    this.ability = ability;
    this.p = personality;
    this.getOtherBodies = getOtherBodies;
    this.powerUpManager = opts.powerUpManager || null;
    this.world = opts.world || null;

    // ── State machine ──
    this.state = 'ROAM';
    this._stateTimer = 0;
    this._target = null;
    this._roamAngle = Math.random() * TWO_PI;
    this._roamWanderTimer = 0;        // periodic roam angle drift
    this._powerupTarget = null;

    // ── Input (persists between think ticks) ──
    this.input = { forward: false, backward: false, left: false, right: false };

    // ── Think rate (not every frame — human-like) ──
    this._thinkInterval = 0.15 + Math.random() * 0.1;
    this._thinkTimer = Math.random() * this._thinkInterval;

    // ── Steering commitment (prevents oscillation) ──
    this._steerCommitTimer = 0;
    this._momentumTimer = 0;           // direction commitment
    this._momentumAngle = 0;

    // ── Human imperfections ──
    this._reactionCooldown = 0;
    this._isMistaking = false;
    this._mistakeTimer = 0;
    this._mistakeDir = 0;
    this._isCoasting = false;
    this._coastTimer = 0;
    this._hesitationTimer = 0;         // brief freeze before committing to charge
    this._overcorrectTimer = 0;        // post-mistake overcorrection
    this._overcorrectDir = 0;
    this._panicSteering = false;       // wild steering when low HP / in danger

    // ── Combat awareness ──
    this._powerupUseDelay = 0;
    this._targetStickyTimer = 0;
    this._lastHitBy = null;            // revenge tracking (CarBody ref)
    this._lastHitTime = 0;
    this._revengeTimer = 0;            // how long revenge urge lasts
    this._threatLevel = 0;             // 0-1 perceived danger
    this._combatTimer = 0;             // time spent in combat states
    this._killStreak = 0;              // consecutive kills boost confidence

    // ── Hit recovery ──
    this._hitRecoveryTimer = 0;
    this._lastProcessedHitTime = 0;

    // ── Ground sensing ──
    this._groundAhead = true;
    this._groundLeft = true;
    this._groundRight = true;
    this._edgeDanger = false;
    this._lavaDanger = false;

    // ── Movement quality ──
    this._desiredSpeed = 1.0;          // 0-1 throttle intent (smoothed)
    this._actualThrottle = 1.0;
    this._driveTimer = 0;              // always-moving enforcement timer
  }

  reset() {
    this.state = 'ROAM';
    this._stateTimer = 1.0 + Math.random() * 1.0;
    this._thinkTimer = 0.3 + Math.random() * 0.3;
    this._steerCommitTimer = 0;
    this._momentumTimer = 0;
    this._reactionCooldown = 0.4;
    this._target = null;
    this._powerupTarget = null;
    this._isMistaking = false;
    this._isCoasting = false;
    this._hesitationTimer = 0;
    this._overcorrectTimer = 0;
    this._panicSteering = false;
    this._powerupUseDelay = 0;
    this._targetStickyTimer = 0;
    this._revengeTimer = Math.max(0, this._revengeTimer - 3); // partial revenge decay on respawn
    this._threatLevel = 0;
    this._combatTimer = 0;
    this._hitRecoveryTimer = 0;
    this._lastProcessedHitTime = 0;
    this._groundAhead = true;
    this._groundLeft = true;
    this._groundRight = true;
    this._edgeDanger = false;
    this._lavaDanger = false;
    this._desiredSpeed = 1.0;
    this._actualThrottle = 1.0;
    this._driveTimer = 0;
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
  }

  // ── Main update (called every frame) ───────────────────────────────

  update(dt) {
    this._stateTimer -= dt;
    this._reactionCooldown -= dt;
    this._thinkTimer -= dt;
    this._steerCommitTimer -= dt;
    this._momentumTimer -= dt;
    this._hitRecoveryTimer -= dt;
    this._revengeTimer -= dt;
    this._hesitationTimer -= dt;
    this._overcorrectTimer -= dt;
    this._driveTimer += dt;

    this._detectCollisionHit();
    this._updateThreatLevel(dt);

    // Hit recovery — stunned, but still show life (slight steering wobble)
    if (this._hitRecoveryTimer > 0) {
      this.input.forward = false;
      this.input.backward = Math.random() < 0.3; // sometimes tap reverse on hit
      if (Math.random() < 0.1) {
        this.input.left = Math.random() < 0.5;
        this.input.right = !this.input.left;
      }
      return this.input;
    }

    this._updateHumanFeel(dt);

    if (this._thinkTimer <= 0) {
      this._thinkTimer = this._thinkInterval;
      this._think();
    }

    this._applyHumanFeel(dt);
    this._applyThrottle(dt);
    this._tryUsePowerUp(dt);

    // ── Glitch Bomb disruption — scrambles controls when affected ──
    if (this.carBody.glitchBombActive) {
      this._applyGlitchDisruption(dt);
    }

    // NEVER be idle — if neither forward nor backward, drive forward
    if (!this.input.forward && !this.input.backward) {
      this.input.forward = true;
    }

    return this.input;
  }

  // ── Collision detection ────────────────────────────────────────────

  _detectCollisionHit() {
    if (this._hitRecoveryTimer > 0) return;

    // Trigger off ACTUAL damage taken, not raw velocity delta. The previous
    // delta-based check (>10 m/s in one frame) also fired when the bot LANDED
    // its own ramming attack — the bounce impulse + collision dampening drop
    // the attacker's velocity sharply. The bot then "stunned" itself on impact,
    // looking like it braked the instant before hitting the player.
    const hit = this.carBody.lastHitBy;
    if (!hit || !hit.source || hit.source === this.carBody) return;
    if (hit.time === this._lastProcessedHitTime) return;
    if (performance.now() - hit.time > 200) return; // stale
    this._lastProcessedHitTime = hit.time;

    // Recovery time scales with personality — Kamikaze shrugs it off, Defensive freezes longer
    const baseRecovery = 0.2 + Math.random() * 0.35;
    this._hitRecoveryTimer = baseRecovery * (1.0 + this.p.evadeThreshold);
    this._driveTimer = 0;

    this._lastHitBy = hit.source;
    this._lastHitTime = performance.now();
    this._revengeTimer = 6 + Math.random() * 4; // remember for 6-10s
  }

  // ── Threat assessment ──────────────────────────────────────────────

  _updateThreatLevel(dt) {
    const hpRatio = this.carBody.hp / this.carBody.maxHp;
    const pos = this.carBody.body.position;
    const distFromCenter = Math.sqrt(pos.x * pos.x + pos.z * pos.z);

    // Base threat from HP
    let threat = (1 - hpRatio) * 0.5;

    // Threat from position (near edge or lava)
    if (distFromCenter > DANGER_OUTER) threat += 0.4;
    else if (distFromCenter > SAFE_OUTER) threat += 0.2;
    if (distFromCenter < SAFE_INNER) threat += 0.2;

    // Threat from nearby enemies
    const nearbyCount = this._countNearby(12);
    threat += nearbyCount * 0.1;

    // Enemy charging at us
    if (this._enemyChargingUs()) threat += 0.25;

    this._threatLevel = Math.min(1, threat);
  }

  // ── Ground sensing ─────────────────────────────────────────────────

  _senseGround() {
    if (!this.world) {
      this._groundAhead = true;
      this._groundLeft = true;
      this._groundRight = true;
      this._edgeDanger = false;
      this._lavaDanger = false;
      return;
    }

    const pos = this.carBody.body.position;
    const yaw = this.carBody._yaw;
    const vel = this.carBody.body.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const lookDist = Math.max(5, speed * 0.6);
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);

    // Raycast ahead, left, and right
    this._groundAhead = this._raycastGround(pos.x + fwdX * lookDist, pos.z + fwdZ * lookDist);

    const sideProbe = lookDist * 0.7;
    const leftX = -Math.sin(yaw + 0.7);
    const leftZ = -Math.cos(yaw + 0.7);
    this._groundLeft = this._raycastGround(pos.x + leftX * sideProbe, pos.z + leftZ * sideProbe);

    const rightX = -Math.sin(yaw - 0.7);
    const rightZ = -Math.cos(yaw - 0.7);
    this._groundRight = this._raycastGround(pos.x + rightX * sideProbe, pos.z + rightZ * sideProbe);

    this._edgeDanger = !this._groundAhead;

    // ── Position-based edge awareness (independent of facing direction) ──
    const distFromCenter = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
    if (distFromCenter > DANGER_OUTER) {
      // Past the danger line — always evade
      this._edgeDanger = true;
    } else if (distFromCenter > SAFE_OUTER) {
      // In the caution zone — evade if facing or moving outward
      const facingOutward = (fwdX * pos.x + fwdZ * pos.z) > 0;
      if (facingOutward) {
        this._edgeDanger = true;
      }
    }

    // Lava check — heading toward lava center
    const aheadX = pos.x + fwdX * lookDist;
    const aheadZ = pos.z + fwdZ * lookDist;
    const aheadDist = Math.sqrt(aheadX * aheadX + aheadZ * aheadZ);
    this._lavaDanger = aheadDist < LAVA_RADIUS + 3;
    if (this._lavaDanger) this._edgeDanger = true;
  }

  _raycastGround(x, z) {
    const carY = this.carBody.body.position.y;
    _rayFrom.set(x, carY + 2, z);
    _rayTo.set(x, carY - 3, z);
    _rayResult.reset();
    return this.world.raycastClosest(_rayFrom, _rayTo, { collisionFilterMask: 1 }, _rayResult);
  }

  // ── Core decision making ───────────────────────────────────────────

  _think() {
    this._senseGround();

    // Edge danger — ALWAYS react (falling off = death, non-negotiable)
    // dodgeSkill affects evasion quality inside _thinkEvade, not whether we notice
    if (this.state !== 'EVADE' && this._edgeDanger) {
      this._enterState('EVADE');
      this._reactionCooldown = this.p.reactionDelay;
    }

    // Low HP → consider fleeing (personality dependent)
    const hpPercent = (this.carBody.hp / this.carBody.maxHp) * 100;
    if (hpPercent <= this.p.panicThreshold && this.state !== 'EVADE' && this.state !== 'FLEE') {
      if (Math.random() < this.p.evadeThreshold) {
        this._enterState('FLEE');
        return;
      }
    }

    switch (this.state) {
      case 'ROAM':         this._thinkRoam(); break;
      case 'HUNT':         this._thinkHunt(); break;
      case 'CHARGE':       this._thinkCharge(); break;
      case 'EVADE':        this._thinkEvade(); break;
      case 'FLEE':         this._thinkFlee(); break;
      case 'POWERUP_SEEK': this._thinkPowerupSeek(); break;
    }
  }

  // ── State transitions ──────────────────────────────────────────────

  _enterState(state) {
    this.state = state;
    this._driveTimer = 0;

    switch (state) {
      case 'ROAM':
        this._stateTimer = this.p.roamTime + randRange(0.5, 2.0);
        this._roamAngle = this._pickRoamAngle();
        this._roamWanderTimer = randRange(0.8, 2.0);
        this._target = null;
        this._targetStickyTimer = 0;
        this._combatTimer = 0;
        break;
      case 'HUNT':
        this._stateTimer = 2.5 + randRange(0, 2.5);
        this._hesitationTimer = this.p.reactionDelay * randRange(0.5, 1.5);
        break;
      case 'CHARGE':
        this._stateTimer = 1.5 + randRange(0, 2.0) + this.p.overcommit;
        break;
      case 'EVADE':
        this._stateTimer = 0.8 + randRange(0, 1.0);
        this.input.forward = false;
        this.input.backward = true;
        this._steerCommitTimer = 0;
        break;
      case 'FLEE':
        this._stateTimer = 2.0 + randRange(0, 2.0);
        break;
      case 'POWERUP_SEEK':
        this._stateTimer = 2.0 + randRange(0, 2.5);
        break;
    }
  }

  _pickRoamAngle() {
    const pos = this.carBody.body.position;
    const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);

    // Too close to outer edge — strong bias inward
    if (dist > SAFE_OUTER) {
      const toCenterAngle = Math.atan2(pos.x, pos.z);
      return toCenterAngle + randRange(-0.4, 0.4);
    }

    // Too close to lava center — bias outward (AWAY from center)
    if (dist < SAFE_INNER) {
      const awayAngle = Math.atan2(-pos.x, -pos.z);
      return awayAngle + randRange(-0.5, 0.5);
    }

    // In safe zone — pick interesting angle (toward other cars most of the time)
    if (Math.random() < 0.6) {
      const others = this.getOtherBodies();
      const alive = others.filter(o => o !== this.carBody && !o.isEliminated && o.mesh.visible);
      if (alive.length > 0) {
        const pick = alive[Math.floor(Math.random() * alive.length)];
        const angle = this._angleTo(pick);
        return angle + randRange(-0.5, 0.5);
      }
    }

    return Math.random() * TWO_PI;
  }

  // ── ROAM — always moving, looking for action ──────────────────────

  _thinkRoam() {
    // Wander angle drifts over time (like a real person would)
    this._roamWanderTimer -= this._thinkInterval;
    if (this._roamWanderTimer <= 0) {
      this._roamAngle += randRange(-0.6, 0.6);
      this._roamWanderTimer = randRange(0.6, 1.5);
    }

    this._steerToward(this._roamAngle);
    this._desiredSpeed = 0.7 + this.p.throttleAggression * 0.3;

    const angleDiff = this._angleDiffTo(this._roamAngle);
    this.input.forward = true;
    this.input.backward = false;
    if (angleDiff > 1.5 && Math.abs(this.carBody._currentSpeed) < 1.5) {
      // Very wrong direction at low speed → brief reverse to reposition
      this.input.forward = false;
      this.input.backward = true;
    }

    // Time to find something to do?
    if (this._stateTimer <= 0 && this._reactionCooldown <= 0) {
      this._reactionCooldown = this.p.reactionDelay;
      this._pickNextAction();
    }
  }

  _pickNextAction() {
    // Revenge target takes priority (if personality wants it)
    if (this._revengeTimer > 0 && this._lastHitBy && Math.random() < this.p.revengeWeight) {
      if (!this._lastHitBy.isEliminated && this._lastHitBy.mesh.visible) {
        const dist = this._distTo(this._lastHitBy);
        if (dist < this.p.targetRange * 1.3) {
          this._target = this._lastHitBy;
          this._enterState('HUNT');
          return;
        }
      }
    }

    // Power-up seek (personality weighted)
    if (this.powerUpManager && !this.powerUpManager.getHeld(this.carBody)
        && Math.random() < this.p.powerupWeight) {
      const pickup = this._findNearestPowerup();
      if (pickup) {
        this._powerupTarget = pickup;
        this._enterState('POWERUP_SEEK');
        return;
      }
    }

    // Find a combat target
    const target = this._findTarget();
    if (target) {
      this._target = target;
      this._enterState('HUNT');
    } else {
      this._enterState('ROAM');
    }
  }

  // ── HUNT — approaching target, sizing them up ─────────────────────

  _thinkHunt() {
    if (!this._target || !this._targetAlive()) { this._enterState('ROAM'); return; }

    this._targetStickyTimer += this._thinkInterval;
    this._combatTimer += this._thinkInterval;
    const dist = this._distTo(this._target);
    let angleToTarget = this._angleTo(this._target);

    // Flanking — approach from the side instead of head-on
    if (this.p.flankBias > 0 && dist > 10) {
      const flankOffset = (Math.random() < 0.5 ? 1 : -1) * this.p.flankBias * 0.8;
      angleToTarget += flankOffset;
    }

    this._steerToward(angleToTarget);

    // Hesitation — brief pause before committing (human-like)
    if (this._hesitationTimer > 0) {
      this._desiredSpeed = 0.3;
      this.input.forward = true;
      this.input.backward = false;
      return;
    }

    const angleDiff = this._angleDiffTo(angleToTarget);
    const botSpeed = Math.abs(this.carBody._currentSpeed);

    // Drive forward, modulate speed for turns
    this.input.forward = true;
    this.input.backward = false;
    if (angleDiff > 1.0) {
      this._desiredSpeed = 0.4;
      // Stuck at low speed facing wrong way → brief reverse
      if (botSpeed < 1.5 && angleDiff > 1.8) {
        this.input.forward = false;
        this.input.backward = true;
      }
    } else if (angleDiff > 0.4) {
      this._desiredSpeed = 0.6;
    } else {
      this._desiredSpeed = 0.85;
    }

    // Retarget (some personalities switch targets more)
    if (Math.random() < this.p.retargetChance && this._targetStickyTimer > 2.5) {
      const newTarget = this._findTarget();
      if (newTarget && newTarget !== this._target) {
        this._target = newTarget;
        this._targetStickyTimer = 0;
        this._reactionCooldown = this.p.reactionDelay * 1.5;
      }
    }

    // Close enough to charge!
    if (dist < 14 && angleDiff < 0.8 && this._reactionCooldown <= 0) {
      this._enterState('CHARGE');
      return;
    }

    // Lost interest — target too far or timer expired
    if (this._stateTimer <= 0 || dist > this.p.targetRange * 1.4) {
      // Combat persistence — some bots chase longer
      if (Math.random() < this.p.combatPersistence && dist < this.p.targetRange) {
        this._stateTimer = 1.5; // keep going
      } else {
        this._enterState('ROAM');
      }
    }
  }

  // ── CHARGE — full speed at target ─────────────────────────────────

  _thinkCharge() {
    if (!this._target || !this._targetAlive()) { this._enterState('ROAM'); return; }

    this._targetStickyTimer += this._thinkInterval;
    this._combatTimer += this._thinkInterval;
    const angleToTarget = this._angleTo(this._target);
    const dist = this._distTo(this._target);

    this._steerToward(angleToTarget);

    const angleDiff = this._angleDiffTo(angleToTarget);
    const chargeSpeed = Math.abs(this.carBody._currentSpeed);

    // Always drive forward — modulate speed based on angle
    this.input.forward = true;
    this.input.backward = false;
    if (angleDiff > 0.8) {
      this._desiredSpeed = 0.4;
    } else {
      // FULL SEND
      this._desiredSpeed = this.p.chargeSpeed;
    }

    this._tryAbilityOnCharge(dist, angleToTarget);

    // Disengage conditions
    if (dist > this.p.targetRange * 1.2 || this._stateTimer <= 0) {
      if (this.p.combatPersistence > 0.7 && dist < this.p.targetRange && Math.random() < 0.5) {
        this._stateTimer = 1.0; // overcommit
      } else {
        this._enterState('ROAM');
      }
    }
  }

  // ── EVADE — danger avoidance (imperfect) ──────────────────────────

  _thinkEvade() {
    const pos = this.carBody.body.position;
    const distFromCenter = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
    const yaw = this.carBody._yaw;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const facingOutward = distFromCenter > 1 && (fwdX * pos.x + fwdZ * pos.z) > 0;

    // Target: always toward center when near the edge
    let targetAngle;
    if (distFromCenter > SAFE_OUTER || facingOutward) {
      targetAngle = Math.atan2(pos.x, pos.z);
      const maxError = (1 - this.p.dodgeSkill) * 0.2;
      targetAngle += randRange(-maxError, maxError);
    } else if (this._groundLeft && !this._groundRight) {
      targetAngle = yaw + 1.0;
    } else if (this._groundRight && !this._groundLeft) {
      targetAngle = yaw - 1.0;
    } else if (this._lavaDanger) {
      // Away from center (lava is at center)
      targetAngle = Math.atan2(-pos.x, -pos.z) + randRange(-0.3, 0.3);
    } else {
      const idealDist = (SAFE_INNER + SAFE_OUTER) / 2;
      const currentAngle = Math.atan2(pos.x, pos.z);
      const targetX = Math.sin(currentAngle) * idealDist;
      const targetZ = Math.cos(currentAngle) * idealDist;
      targetAngle = Math.atan2(-(targetX - pos.x), -(targetZ - pos.z));
    }

    // How far off are we from target heading?
    const angleDiff = normalizeAngle(targetAngle - yaw);
    const absDiff = Math.abs(angleDiff);

    // STRATEGY (same logic as emergency check):
    // If roughly facing center (< 90° off) → drive forward toward it
    // If facing away (> 90° off) → reverse toward center, with FLIPPED steering
    if (absDiff < Math.PI / 2) {
      // Facing roughly toward safety — drive forward
      this._steerToward(targetAngle);
      this.input.forward = true;
      this.input.backward = false;
      this._desiredSpeed = 0.6;
    } else {
      // Facing away from safety — reverse + flip steering
      this.input.forward = false;
      this.input.backward = true;
      this._desiredSpeed = 0;
      // Flip left/right because CarBody inverts steering in reverse
      this._steerCommitTimer = 0;
      this.input.left = angleDiff < -0.1;  // swapped
      this.input.right = angleDiff > 0.1;  // swapped
    }

    this._tryAbilityOnEvade();

    // Only exit evade when we're back in a safe position
    const isSafe = this._groundAhead && distFromCenter < SAFE_OUTER && distFromCenter > SAFE_INNER && !facingOutward;
    if (isSafe && this._stateTimer <= 0) this._enterState('ROAM');
    if (this._stateTimer < -3.0) this._enterState('ROAM');
  }

  // ── FLEE — low HP, try to survive ─────────────────────────────────

  _thinkFlee() {
    const pos = this.carBody.body.position;

    // Run toward safe zone, away from nearest enemy
    let fleeAngle;
    const nearestEnemy = this._findNearestEnemy();
    if (nearestEnemy) {
      // Run AWAY from them
      const angleToEnemy = this._angleTo(nearestEnemy);
      fleeAngle = angleToEnemy + Math.PI + randRange(-0.4, 0.4);
    } else {
      // Just head to safe zone center
      const idealDist = (SAFE_INNER + SAFE_OUTER) / 2;
      const currentAngle = Math.atan2(pos.x, pos.z);
      fleeAngle = Math.atan2(
        -(Math.sin(currentAngle) * idealDist - pos.x),
        -(Math.cos(currentAngle) * idealDist - pos.z)
      );
    }

    // Panic steering — jittery when scared
    if (Math.random() < 0.15) {
      fleeAngle += randRange(-0.2, 0.2);
    }

    this._steerToward(fleeAngle);
    this.input.forward = true;
    this.input.backward = false;
    this._desiredSpeed = 0.85;

    // Grab a power-up if nearby (even while fleeing)
    if (this.powerUpManager && !this.powerUpManager.getHeld(this.carBody)) {
      const pickup = this._findNearestPowerup();
      if (pickup) {
        const dx = pickup.x - pos.x, dz = pickup.z - pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 10) {
          const pickupAngle = Math.atan2(-(pickup.x - pos.x), -(pickup.z - pos.z));
          this._steerToward(pickupAngle);
        }
      }
    }

    this._tryAbilityOnEvade(); // defensive abilities in flee too

    // Recover composure if HP went up or enough time passed
    const hpPercent = (this.carBody.hp / this.carBody.maxHp) * 100;
    if (hpPercent > this.p.panicThreshold + 15 || this._stateTimer <= 0) {
      this._enterState('ROAM');
    }
  }

  // ── POWERUP_SEEK ───────────────────────────────────────────────────

  _thinkPowerupSeek() {
    if (this.powerUpManager && this.powerUpManager.getHeld(this.carBody)) {
      this._enterState('ROAM'); return;
    }
    const pickup = this._powerupTarget;
    if (!pickup || !pickup.active) { this._enterState('ROAM'); return; }

    const pos = this.carBody.body.position;
    const angle = Math.atan2(-(pickup.x - pos.x), -(pickup.z - pos.z));
    this._steerToward(angle);

    const angleDiff = this._angleDiffTo(angle);
    // Always drive forward — steering handles direction, car curves naturally
    this.input.forward = true;
    this.input.backward = false;
    this._desiredSpeed = 0.75;

    // If there's trouble, react to nearby enemies
    const nearestEnemy = this._findNearestEnemy();
    if (nearestEnemy && this._distTo(nearestEnemy) < 6) {
      if (Math.random() < 0.2) {
        // Sometimes ignore the power-up and fight
        this._target = nearestEnemy;
        this._enterState('CHARGE');
        return;
      }
    }

    if (this._stateTimer <= 0) this._enterState('ROAM');
  }

  // ── Human-feel systems ─────────────────────────────────────────────

  _updateHumanFeel(dt) {
    // Mistakes — brief wrong turns
    if (!this._isMistaking && Math.random() < this.p.mistakeChance) {
      this._isMistaking = true;
      this._mistakeTimer = 0.15 + Math.random() * 0.35;
      this._mistakeDir = Math.random() < 0.5 ? -1 : 1;

      // After mistake, overcorrect (like a real person)
      if (Math.random() < 0.5) {
        this._overcorrectTimer = this._mistakeTimer + 0.1;
        this._overcorrectDir = -this._mistakeDir;
      }
    }
    if (this._isMistaking) {
      this._mistakeTimer -= dt;
      if (this._mistakeTimer <= 0) this._isMistaking = false;
    }

    // Coasting — brief throttle release
    if (!this._isCoasting && Math.random() < this.p.coastChance * 0.15) {
      this._isCoasting = true;
      this._coastTimer = 0.1 + Math.random() * 0.2;
    }
    if (this._isCoasting) {
      this._coastTimer -= dt;
      if (this._coastTimer <= 0) this._isCoasting = false;
    }

    // Panic steering when threat is high
    this._panicSteering = this._threatLevel > 0.7 && Math.random() < 0.3;
  }

  _applyHumanFeel(dt) {
    // Mistake — wrong turn
    if (this._isMistaking) {
      this.input.left = this._mistakeDir > 0;
      this.input.right = this._mistakeDir < 0;
    }

    // Overcorrection after mistake
    if (this._overcorrectTimer > 0 && !this._isMistaking) {
      this._overcorrectTimer -= dt;
      this.input.left = this._overcorrectDir > 0;
      this.input.right = this._overcorrectDir < 0;
    }

    // Coasting (except during evade/flee)
    if (this._isCoasting && this.state !== 'EVADE' && this.state !== 'FLEE') {
      this.input.forward = false;
    }

    // Panic jitter
    if (this._panicSteering) {
      if (Math.random() < 0.3) {
        this.input.left = !this.input.left;
        this.input.right = !this.input.right;
      }
    }

    // Steering noise — subtle wobble (higher when panicking)
    if (this.p.steerNoise > 0 && Math.random() < 0.1) {
      const noise = this.p.steerNoise * (this._panicSteering ? 2.5 : 1.0);
      if (Math.random() < noise) {
        this.input.left = !this.input.left;
        this.input.right = !this.input.right;
      }
    }
  }

  _applyThrottle(dt) {
    // Smooth throttle transitions (no instant on/off)
    const target = this.input.forward ? this._desiredSpeed : 0;
    this._actualThrottle += (target - this._actualThrottle) * Math.min(1, dt * 5);

    // Throttle aggression — some bots are always full throttle, some modulate
    if (this.input.forward && this._actualThrottle < this.p.throttleAggression) {
      // Keep forward but the carBody speed will handle the modulation
      // This just prevents releasing forward too eagerly
    }
  }

  // ── Glitch Bomb disruption ─────────────────────────────────────────

  _applyGlitchDisruption(dt) {
    // Simulate "corrupted controls" — the bot's input gets scrambled
    // like a player struggling with a glitched screen

    // Random steering flips (frequent — ~40% of frames)
    if (Math.random() < 0.4) {
      this.input.left = !this.input.left;
      this.input.right = !this.input.right;
    }

    // Occasional full input freeze (brief moments of confusion)
    if (Math.random() < 0.12) {
      this.input.forward = false;
      this.input.backward = false;
      this.input.left = false;
      this.input.right = false;
    }

    // Random backward bursts (panic)
    if (Math.random() < 0.08) {
      this.input.forward = false;
      this.input.backward = true;
    }

    // Can't use abilities or power-ups while glitched
    // (handled by not calling _tryUsePowerUp — but let's also block it here)
    this._powerupUseDelay = 0;

    // Reduced target acquisition — lose track of enemies
    if (Math.random() < 0.15 && this._target) {
      this._target = null;
      this._enterState('ROAM');
    }
  }

  // ── Power-up usage ─────────────────────────────────────────────────

  _tryUsePowerUp(dt) {
    if (!this.powerUpManager) return;
    const held = this.powerUpManager.getHeld(this.carBody);
    if (!held) { this._powerupUseDelay = 0; return; }

    this._powerupUseDelay += dt;
    // Human-like delay before using — varies by personality
    const minDelay = 0.6 + (1 - this.p.abilityEagerness) * 1.5;
    if (this._powerupUseDelay < minDelay + Math.random() * 0.5) return;

    switch (held) {
      case 'MISSILE':
        if ((this.state === 'CHARGE' || this.state === 'HUNT') && this._target) {
          const angleDiff = this._angleDiffTo(this._angleTo(this._target));
          if (angleDiff < 0.4) this.powerUpManager.use(this.carBody);
        }
        break;
      case 'HOMING_MISSILE':
        if (this._countNearby(35) >= 1) this.powerUpManager.use(this.carBody);
        break;
      case 'SHIELD':
        if (this._enemyChargingUs() || this._edgeDanger
            || this.carBody.hp < 40 || this._threatLevel > 0.6) {
          this.powerUpManager.use(this.carBody);
        }
        break;
      case 'REPAIR_KIT':
        if (this.carBody.hp <= this.carBody.maxHp - 20) this.powerUpManager.use(this.carBody);
        break;
      case 'HOLO_EVADE':
        if (this._enemyChargingUs() || this.carBody.hp < 50 || this.state === 'FLEE') {
          this.powerUpManager.use(this.carBody);
        }
        break;
      case 'AUTO_TURRET':
        if (this._countNearby(25) >= 1) this.powerUpManager.use(this.carBody);
        break;
      case 'GLITCH_BOMB':
        // Best value when multiple enemies are alive — chaos weapon
        if (this._countNearby(20) >= 2 || (this._countNearby(30) >= 3 && this._threatLevel > 0.4)) {
          this.powerUpManager.use(this.carBody);
        }
        break;
      default:
        if (this._powerupUseDelay > 4.0) this.powerUpManager.use(this.carBody);
    }
  }

  // ── Ability usage ──────────────────────────────────────────────────

  /** Would using a movement ability (DASH, NITRO, TRAIL) send us off the edge? */
  _wouldAbilitySendOffEdge() {
    const pos = this.carBody.body.position;
    const yaw = this.carBody._yaw;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    // Project where we'd end up after a boost (roughly 15 units ahead)
    const destX = pos.x + fwdX * 15;
    const destZ = pos.z + fwdZ * 15;
    const destDist = Math.sqrt(destX * destX + destZ * destZ);
    return destDist > SAFE_OUTER;
  }

  _tryAbilityOnCharge(distToTarget, angleToTarget) {
    if (!this.ability || this.ability.state !== 'ready') return;
    if (this._reactionCooldown > 0) return;
    if (Math.random() > this.p.abilityEagerness) return;

    const name = this.ability.abilityDef.name;

    // Block movement abilities if they'd send us off the edge
    if (['NITRO', 'TRAIL', 'DASH', 'LEAP'].includes(name) && this._wouldAbilitySendOffEdge()) {
      return;
    }

    switch (name) {
      case 'NITRO': case 'TRAIL':
        if (distToTarget < 18 && distToTarget > 5 && this._angleDiffTo(angleToTarget) < 0.4) {
          this.ability.use();
        }
        break;
      case 'RAM':
        if (distToTarget < 6) this.ability.use(); break;
      case 'PULSE':
        if (this._countNearby(10) >= 2 || distToTarget < 5) this.ability.use(); break;
      case 'DRIFT':
        if (this._angleDiffTo(angleToTarget) > 0.5 && Math.abs(this.carBody._currentSpeed) > 8) {
          this.ability.use();
        }
        break;
      case 'LEAP':
        if (distToTarget < 6) this.ability.use(); break;
      case 'PHASE':
        if (this._enemyChargingUs() || this._threatLevel > 0.6) this.ability.use(); break;
      case 'DASH':
        if (distToTarget < 12 && distToTarget > 3 && this._angleDiffTo(angleToTarget) < 0.3) {
          this.ability.use();
        }
        break;
    }
  }

  _tryAbilityOnEvade() {
    if (!this.ability || this.ability.state !== 'ready' || this._reactionCooldown > 0) return;
    const name = this.ability.abilityDef.name;
    // Only use non-movement abilities during evade (PHASE for intangibility)
    // NEVER use DASH/NITRO/TRAIL/LEAP during evade — they'd launch us off the edge
    if (name === 'PHASE') {
      if (Math.random() < this.p.abilityEagerness) this.ability.use();
    }
  }

  // ── Target selection ───────────────────────────────────────────────

  _isHuman(carBody) {
    return carBody.playerId && !carBody.playerId.startsWith('bot_');
  }

  _findTarget() {
    const others = this.getOtherBodies();
    let best = null;
    let bestScore = -Infinity;
    const myPos = this.carBody.body.position;

    // Count how many bots are already targeting each human player (anti-gangup)
    let humansTargetedCount = 0;
    if (this._otherBrains) {
      for (const brain of this._otherBrains) {
        if (brain === this) continue;
        if (brain._target && this._isHuman(brain._target)
            && (brain.state === 'HUNT' || brain.state === 'CHARGE')) {
          humansTargetedCount++;
        }
      }
    }
    // Allow 2-3 bots on a human at once, not all 6
    const maxBotsOnHuman = 2 + Math.floor(Math.random() * 2); // 2 or 3
    const humanSlotsFull = humansTargetedCount >= maxBotsOnHuman;

    for (const other of others) {
      if (other === this.carBody) continue;
      if (other.isEliminated) continue;
      if (!other.mesh.visible || other.body.position.y < -2) continue;

      const d = this._distTo(other);
      if (d > this.p.targetRange) continue;

      // Base score: proximity
      let score = (this.p.targetRange - d) * 0.5;

      const isHuman = this._isHuman(other);

      // ── Human player bias ──
      // Bots prefer human players as targets — they're the real challenge.
      // But not all bots pile on: if enough are already chasing a human, others
      // will pick bot targets or low-HP stragglers instead.
      if (isHuman) {
        if (!humanSlotsFull) {
          score += 10 + this.p.combatPersistence * 5; // significant preference
        }
        // Even when "slots full", still a mild preference (humans are more fun)
        score += 3;
      }

      // ── Low-HP predator instinct (<30 HP = easy kill, go finish them) ──
      const otherHpPercent = (other.hp / (other.maxHp || 100)) * 100;
      if (otherHpPercent <= 30) {
        // Strong "finish them off" drive — overrides most other scoring
        score += 18 + (30 - otherHpPercent) * 0.4; // up to +30 at 0 HP
      } else if (other.hp < this.carBody.hp) {
        // General weakness bonus (less extreme)
        score += (1 - other.hp / this.carBody.maxHp) * 6;
      }

      // Revenge targeting
      if (other === this._lastHitBy && this._revengeTimer > 0) {
        score += this.p.revengeWeight * 15;
      }

      // Variety randomness (prevents perfectly deterministic picks)
      score += randRange(0, 5);

      // Tricksters prefer targets that aren't looking at them
      if (this.p.flankBias > 0.3) {
        const otherYaw = other._yaw || 0;
        const angleFromTarget = Math.atan2(-(myPos.x - other.body.position.x), -(myPos.z - other.body.position.z));
        const facingDiff = Math.abs(normalizeAngle(otherYaw - angleFromTarget));
        if (facingDiff > 1.5) score += 5; // bonus for attacking from behind
      }

      if (score > bestScore) { bestScore = score; best = other; }
    }
    return best;
  }

  _findNearestEnemy() {
    const others = this.getOtherBodies();
    let best = null;
    let bestDist = Infinity;
    for (const other of others) {
      if (other === this.carBody || other.isEliminated || !other.mesh.visible) continue;
      const d = this._distTo(other);
      if (d < bestDist) { bestDist = d; best = other; }
    }
    return best;
  }

  _findNearestPowerup() {
    if (!this.powerUpManager || this.powerUpManager.getHeld(this.carBody)) return null;
    const pedestals = this.powerUpManager._pedestals;
    if (!pedestals) return null;

    const pos = this.carBody.body.position;
    let best = null, bestDist = 30;

    for (const p of pedestals) {
      if (!p.active) continue;
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _targetAlive() {
    return this._target && !this._target.isEliminated
        && this._target.mesh.visible && this._target.body.position.y > -2;
  }

  _distTo(other) {
    const a = this.carBody.body.position, b = other.body.position;
    const dx = b.x - a.x, dz = b.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  _angleTo(other) {
    const a = this.carBody.body.position, b = other.body.position;
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  _angleDiffTo(targetAngle) {
    return Math.abs(normalizeAngle(targetAngle - this.carBody._yaw));
  }

  _steerToward(targetAngle) {
    if (this._steerCommitTimer > 0) return;

    if (this._momentumTimer > 0) {
      targetAngle = this._momentumAngle * 0.6 + targetAngle * 0.4;
    }

    const diff = normalizeAngle(targetAngle - this.carBody._yaw);
    const deadzone = 0.12;
    const newLeft = diff > deadzone;
    const newRight = diff < -deadzone;

    if (newLeft !== this.input.left || newRight !== this.input.right) {
      this._steerCommitTimer = 0.08 + Math.random() * 0.1;
      this._momentumTimer = this.p.momentumCommit;
      this._momentumAngle = targetAngle;
    }
    this.input.left = newLeft;
    this.input.right = newRight;
  }

  _countNearby(radius) {
    let count = 0;
    for (const other of this.getOtherBodies()) {
      if (other !== this.carBody && !other.isEliminated && this._distTo(other) < radius) count++;
    }
    return count;
  }

  _enemyChargingUs() {
    const pos = this.carBody.body.position;
    for (const other of this.getOtherBodies()) {
      if (other === this.carBody || other.isEliminated) continue;
      if (this._distTo(other) > 12) continue;
      const vel = other.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      if (speed < 6) continue;
      const vAngle = Math.atan2(-vel.x, -vel.z);
      const angleToUs = Math.atan2(-(pos.x - other.body.position.x), -(pos.z - other.body.position.z));
      if (Math.abs(normalizeAngle(vAngle - angleToUs)) < 0.6) return true;
    }
    return false;
  }
}
