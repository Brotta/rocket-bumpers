import * as CANNON from 'cannon-es';
import { ARENA } from '../core/Config.js';

/**
 * BotBrain — per-bot AI state machine with human-like imperfections.
 *
 * States: ROAM → TARGET → CHARGE → EVADE → ROAM  (+ POWERUP_SEEK)
 *
 * Flat volcano arena awareness:
 * - Avoids outer edge (fall off)
 * - Avoids central lava pool
 * - Reacts to rock arms and geysers
 */

const TWO_PI = Math.PI * 2;
const ARENA_RADIUS = ARENA.diameter / 2;
const LAVA_RADIUS = ARENA.lava.radius;

// Raycast down from points ahead to detect ground
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

export class BotBrain {
  constructor(carBody, ability, personality, getOtherBodies, opts = {}) {
    this.carBody = carBody;
    this.ability = ability;
    this.p = personality;
    this.getOtherBodies = getOtherBodies;
    this.powerUpManager = opts.powerUpManager || null;
    this.world = opts.world || null;

    this.state = 'ROAM';
    this._stateTimer = 0;
    this._target = null;
    this._roamAngle = Math.random() * TWO_PI;
    this._powerupTarget = null;

    this.input = { forward: false, backward: false, left: false, right: false };

    this._thinkInterval = 0.2 + Math.random() * 0.15;
    this._thinkTimer = Math.random() * this._thinkInterval;
    this._steerCommitTimer = 0;

    this._reactionCooldown = 0;
    this._isMistaking = false;
    this._mistakeTimer = 0;
    this._mistakeDir = 0;
    this._isCoasting = false;
    this._coastTimer = 0;
    this._powerupUseDelay = 0;
    this._targetStickyTimer = 0;

    this._hitRecoveryTimer = 0;
    this._lastVelocityMag = 0;

    this._groundAhead = true;
    this._groundLeft = true;
    this._groundRight = true;
    this._edgeDanger = false;
  }

  reset() {
    this.state = 'ROAM';
    this._stateTimer = 1.5 + Math.random() * 1.0;
    this._thinkTimer = 0.5 + Math.random() * 0.5;
    this._steerCommitTimer = 0;
    this._reactionCooldown = 0.6;
    this._target = null;
    this._powerupTarget = null;
    this._isMistaking = false;
    this._isCoasting = false;
    this._powerupUseDelay = 0;
    this._targetStickyTimer = 0;
    this._hitRecoveryTimer = 0;
    this._lastVelocityMag = 0;
    this._groundAhead = true;
    this._groundLeft = true;
    this._groundRight = true;
    this._edgeDanger = false;
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
  }

  update(dt) {
    this._stateTimer -= dt;
    this._reactionCooldown -= dt;
    this._thinkTimer -= dt;
    this._steerCommitTimer -= dt;
    this._hitRecoveryTimer -= dt;

    this._detectCollisionHit();

    if (this._hitRecoveryTimer > 0) {
      this.input.forward = false;
      this.input.backward = false;
      return this.input;
    }

    this._updateHumanFeel(dt);

    if (this._thinkTimer <= 0) {
      this._thinkTimer = this._thinkInterval;
      this._think();
    }

    this._applyHumanFeel();
    this._tryUsePowerUp(dt);

    return this.input;
  }

  _detectCollisionHit() {
    const vel = this.carBody.body.velocity;
    const curMag = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const delta = Math.abs(curMag - this._lastVelocityMag);
    this._lastVelocityMag = curMag;

    if (delta > 12 && this._hitRecoveryTimer <= 0) {
      this._hitRecoveryTimer = 0.3 + Math.random() * 0.4;
      this.carBody._currentSpeed = curMag * 0.5;
    }
  }

  // ── Ground sensing + hazard detection ──────────────────────────────────

  _senseGround() {
    if (!this.world) {
      this._groundAhead = true;
      this._groundLeft = true;
      this._groundRight = true;
      this._edgeDanger = false;
      return;
    }

    const pos = this.carBody.body.position;
    const yaw = this.carBody._yaw;
    const vel = this.carBody.body.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const lookDist = Math.max(4, speed * 0.4);
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);

    this._groundAhead = this._raycastGround(pos.x + fwdX * lookDist, pos.z + fwdZ * lookDist);

    const leftX = -Math.sin(yaw + 0.7);
    const leftZ = -Math.cos(yaw + 0.7);
    this._groundLeft = this._raycastGround(pos.x + leftX * lookDist * 0.7, pos.z + leftZ * lookDist * 0.7);

    const rightX = -Math.sin(yaw - 0.7);
    const rightZ = -Math.cos(yaw - 0.7);
    this._groundRight = this._raycastGround(pos.x + rightX * lookDist * 0.7, pos.z + rightZ * lookDist * 0.7);

    this._edgeDanger = !this._groundAhead;

    // Also check: heading toward lava center?
    const aheadX = pos.x + fwdX * lookDist;
    const aheadZ = pos.z + fwdZ * lookDist;
    const aheadDist = Math.sqrt(aheadX * aheadX + aheadZ * aheadZ);
    if (aheadDist < LAVA_RADIUS + 2) {
      this._edgeDanger = true;
    }
  }

  _raycastGround(x, z) {
    const carY = this.carBody.body.position.y;
    _rayFrom.set(x, carY + 2, z);
    _rayTo.set(x, carY - 3, z);
    _rayResult.reset();
    return this.world.raycastClosest(_rayFrom, _rayTo, { collisionFilterMask: 1 }, _rayResult);
  }

  // ── Core decision ──────────────────────────────────────────────────────

  _think() {
    this._senseGround();

    if (this.state !== 'EVADE' && this._edgeDanger && this._reactionCooldown <= 0) {
      this._enterState('EVADE');
      this._reactionCooldown = this.p.reactionDelay;
    }

    switch (this.state) {
      case 'ROAM':         this._thinkRoam(); break;
      case 'TARGET':       this._thinkTarget(); break;
      case 'CHARGE':       this._thinkCharge(); break;
      case 'EVADE':        this._thinkEvade(); break;
      case 'POWERUP_SEEK': this._thinkPowerupSeek(); break;
    }
  }

  _updateHumanFeel(dt) {
    if (!this._isMistaking && Math.random() < this.p.mistakeChance) {
      this._isMistaking = true;
      this._mistakeTimer = 0.2 + Math.random() * 0.4;
      this._mistakeDir = Math.random() < 0.5 ? -1 : 1;
    }
    if (this._isMistaking) {
      this._mistakeTimer -= dt;
      if (this._mistakeTimer <= 0) this._isMistaking = false;
    }

    if (!this._isCoasting && Math.random() < this.p.coastChance * 0.3) {
      this._isCoasting = true;
      this._coastTimer = 0.15 + Math.random() * 0.3;
    }
    if (this._isCoasting) {
      this._coastTimer -= dt;
      if (this._coastTimer <= 0) this._isCoasting = false;
    }
  }

  _applyHumanFeel() {
    if (this._isMistaking) {
      this.input.left = this._mistakeDir > 0;
      this.input.right = this._mistakeDir < 0;
    }
    if (this._isCoasting && this.state !== 'EVADE') {
      this.input.forward = false;
    }
  }

  // ── State transitions ──────────────────────────────────────────────────

  _enterState(state) {
    this.state = state;
    switch (state) {
      case 'ROAM':
        this._stateTimer = this.p.roamTime + Math.random() * 1.5;
        this._roamAngle = this._pickRoamAngle();
        this._target = null;
        this._targetStickyTimer = 0;
        break;
      case 'TARGET':
        this._stateTimer = 2.0 + Math.random() * 2.0;
        break;
      case 'CHARGE':
        this._stateTimer = 2.0 + Math.random() * 2.5;
        break;
      case 'EVADE':
        this._stateTimer = 1.2 + Math.random() * 0.8;
        this.input.forward = false;
        this.input.backward = true;
        this._steerCommitTimer = 0;
        break;
      case 'POWERUP_SEEK':
        this._stateTimer = 2.5 + Math.random() * 2.0;
        break;
    }
  }

  _pickRoamAngle() {
    const pos = this.carBody.body.position;
    const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);

    // Too close to outer edge — bias inward
    if (dist > ARENA_RADIUS * 0.75) {
      const toCenterAngle = Math.atan2(-pos.x, -pos.z);
      return toCenterAngle + (Math.random() - 0.5) * 1.2;
    }

    // Too close to lava center — bias outward
    if (dist < LAVA_RADIUS + 5) {
      const awayAngle = Math.atan2(pos.x, pos.z);
      return awayAngle + (Math.random() - 0.5) * 1.0;
    }

    return Math.random() * TWO_PI;
  }

  // ── ROAM ───────────────────────────────────────────────────────────────

  _thinkRoam() {
    this._steerToward(this._roamAngle);
    this.input.forward = true;
    this.input.backward = false;

    const angleDiff = this._angleDiffTo(this._roamAngle);
    if (angleDiff > 0.6) this.input.forward = false;

    if (this._stateTimer <= 0 && this._reactionCooldown <= 0) {
      this._reactionCooldown = this.p.reactionDelay;

      if (this.powerUpManager && !this.powerUpManager.getHeld(this.carBody)
          && Math.random() < this.p.powerupWeight) {
        const pickup = this._findNearestPowerup();
        if (pickup) {
          this._powerupTarget = pickup;
          this._enterState('POWERUP_SEEK');
          return;
        }
      }

      const target = this._findTarget();
      if (target) {
        this._target = target;
        this._enterState('TARGET');
      } else {
        this._enterState('ROAM');
      }
    }
  }

  // ── TARGET ─────────────────────────────────────────────────────────────

  _thinkTarget() {
    if (!this._target || !this._targetAlive()) { this._enterState('ROAM'); return; }

    this._targetStickyTimer += this._thinkInterval;
    const dist = this._distTo(this._target);
    const angleToTarget = this._angleTo(this._target);

    this._steerToward(angleToTarget);

    const angleDiff = this._angleDiffTo(angleToTarget);
    const botSpeed = Math.abs(this.carBody._currentSpeed);
    // Need some speed to turn (bicycle model) — creep forward if too slow
    if (botSpeed < 3) {
      this.input.forward = true; this.input.backward = false;
    } else if (angleDiff > 1.0) { this.input.forward = false; this.input.backward = true; }
    else if (angleDiff > 0.5) { this.input.forward = false; this.input.backward = false; }
    else { this.input.forward = true; this.input.backward = false; }

    if (Math.random() < this.p.retargetChance && this._targetStickyTimer > 2.0) {
      const newTarget = this._findTarget();
      if (newTarget && newTarget !== this._target) {
        this._target = newTarget;
        this._targetStickyTimer = 0;
        this._reactionCooldown = this.p.reactionDelay * 2;
      }
    }

    if (dist < 15 && this._reactionCooldown <= 0) { this._enterState('CHARGE'); return; }
    if (this._stateTimer <= 0 || dist > this.p.targetRange * 1.3) this._enterState('ROAM');
  }

  // ── CHARGE ─────────────────────────────────────────────────────────────

  _thinkCharge() {
    if (!this._target || !this._targetAlive()) { this._enterState('ROAM'); return; }

    this._targetStickyTimer += this._thinkInterval;
    const angleToTarget = this._angleTo(this._target);
    const dist = this._distTo(this._target);

    this._steerToward(angleToTarget);

    const angleDiff = this._angleDiffTo(angleToTarget);
    const chargeSpeed = Math.abs(this.carBody._currentSpeed);
    // Need some speed to turn (bicycle model) — creep forward if too slow
    if (chargeSpeed < 3) {
      this.input.forward = true; this.input.backward = false;
    } else if (angleDiff > 0.7) { this.input.forward = false; this.input.backward = false; }
    else { this.input.forward = true; this.input.backward = false; }

    this._tryAbilityOnCharge(dist, angleToTarget);
    if (dist > this.p.targetRange || this._stateTimer <= 0) this._enterState('ROAM');
  }

  // ── EVADE ──────────────────────────────────────────────────────────────

  _thinkEvade() {
    const pos = this.carBody.body.position;
    const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
    let targetAngle;

    if (this._groundLeft && !this._groundRight) {
      targetAngle = this.carBody._yaw + 1.2;
    } else if (this._groundRight && !this._groundLeft) {
      targetAngle = this.carBody._yaw - 1.2;
    } else {
      // Steer toward safe zone (midway between lava and edge)
      const idealDist = (LAVA_RADIUS + 5 + ARENA_RADIUS * 0.7) / 2;
      const currentAngle = Math.atan2(pos.x, pos.z);
      const targetX = Math.sin(currentAngle) * idealDist;
      const targetZ = Math.cos(currentAngle) * idealDist;
      targetAngle = Math.atan2(-(targetX - pos.x), -(targetZ - pos.z));
    }

    this._steerToward(targetAngle);

    const vel = this.carBody.body.velocity;
    const yaw = this.carBody._yaw;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const velDotFwd = vel.x * fwdX + vel.z * fwdZ;

    if (!this._groundAhead && velDotFwd > 5) {
      this.input.forward = false;
      this.input.backward = true;
    } else {
      this.input.forward = true;
      this.input.backward = false;
    }

    this._tryAbilityOnEvade();

    if (this._groundAhead && this._stateTimer <= 0) this._enterState('ROAM');
    if (this._stateTimer < -2.0) this._enterState('ROAM');
  }

  // ── POWERUP_SEEK ───────────────────────────────────────────────────────

  _thinkPowerupSeek() {
    if (this.powerUpManager && this.powerUpManager.getHeld(this.carBody)) {
      this._enterState('ROAM'); return;
    }
    const pickup = this._powerupTarget;
    if (!pickup || !pickup.active) { this._enterState('ROAM'); return; }

    const pos = this.carBody.body.position;
    const angle = Math.atan2(-(pickup.x - pos.x), -(pickup.z - pos.z));
    this._steerToward(angle);
    this.input.forward = this._angleDiffTo(angle) < 0.6;
    this.input.backward = false;

    const nearestEnemy = this._findTarget();
    if (nearestEnemy && this._distTo(nearestEnemy) < 6 && Math.random() < 0.15) {
      this._target = nearestEnemy;
      this._enterState('CHARGE');
      return;
    }
    if (this._stateTimer <= 0) this._enterState('ROAM');
  }

  // ── Power-up usage ─────────────────────────────────────────────────────

  _tryUsePowerUp(dt) {
    if (!this.powerUpManager) return;
    const held = this.powerUpManager.getHeld(this.carBody);
    if (!held) { this._powerupUseDelay = 0; return; }

    this._powerupUseDelay += dt;
    if (this._powerupUseDelay < 1.0 + Math.random() * 0.5) return;

    switch (held) {
      case 'MISSILE':
        // Fire when charging at a target or target is ahead
        if (this.state === 'CHARGE' || this.state === 'TARGET') this.powerUpManager.use(this.carBody);
        break;
      case 'HOMING_MISSILE':
        // Fire when any enemy is within range
        if (this._countNearby(40) >= 1) this.powerUpManager.use(this.carBody);
        break;
      case 'SHIELD':
        // Activate defensively when under threat or low HP
        if (this._enemyChargingUs() || this._edgeDanger || this.carBody.hp < 40) this.powerUpManager.use(this.carBody);
        break;
      case 'REPAIR_KIT':
        // Use when damaged enough to benefit (don't waste at full HP)
        if (this.carBody.hp <= this.carBody.maxHp - 20) this.powerUpManager.use(this.carBody);
        break;
      case 'HOLO_EVADE':
        // Use when being chased by enemy or homing missile, or low HP under threat
        if (this._enemyChargingUs() || this.carBody.hp < 50) this.powerUpManager.use(this.carBody);
        break;
      case 'AUTO_TURRET':
        // Always beneficial — deploy ASAP (small human-like delay already in _powerupUseDelay)
        this.powerUpManager.use(this.carBody);
        break;
      default:
        if (this._powerupUseDelay > 3.0) this.powerUpManager.use(this.carBody);
    }
  }

  // ── Ability usage ──────────────────────────────────────────────────────

  _tryAbilityOnCharge(distToTarget, angleToTarget) {
    if (!this.ability || this.ability.state !== 'ready') return;
    if (this._reactionCooldown > 0 || Math.random() > this.p.abilityEagerness) return;

    const name = this.ability.abilityDef.name;
    switch (name) {
      case 'NITRO': case 'TRAIL':
        if (distToTarget < 15 && distToTarget > 6) this.ability.use(); break;
      case 'RAM':
        if (distToTarget < 5) this.ability.use(); break;
      case 'PULSE':
        if (this._countNearby(10) >= 2 || distToTarget < 4) this.ability.use(); break;
      case 'DRIFT':
        if (this._angleDiffTo(angleToTarget) > 0.5) this.ability.use(); break;
      case 'LEAP':
        if (distToTarget < 5) this.ability.use(); break;
      case 'PHASE':
        if (this._enemyChargingUs()) this.ability.use(); break;
      case 'DASH':
        if (distToTarget < 10 && distToTarget > 4) this.ability.use(); break;
    }
  }

  _tryAbilityOnEvade() {
    if (!this.ability || this.ability.state !== 'ready' || this._reactionCooldown > 0) return;
    const name = this.ability.abilityDef.name;
    if (['DASH', 'LEAP', 'PHASE', 'NITRO', 'TRAIL'].includes(name)) this.ability.use();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _findTarget() {
    const others = this.getOtherBodies();
    let best = null;
    let bestScore = -Infinity;

    for (const other of others) {
      if (other === this.carBody) continue;
      if (other.isEliminated) continue;
      if (!other.mesh.visible || other.body.position.y < -2) continue;

      const d = this._distTo(other);
      if (d > this.p.targetRange) continue;

      let score = (this.p.targetRange - d) + Math.random() * 10;
      if (other.hp < this.carBody.hp) score += 3;

      if (score > bestScore) { bestScore = score; best = other; }
    }
    return best;
  }

  _findNearestPowerup() {
    if (!this.powerUpManager || this.powerUpManager.getHeld(this.carBody)) return null;
    const pedestals = this.powerUpManager._pedestals;
    if (!pedestals) return null;

    const pos = this.carBody.body.position;
    let best = null, bestDist = 25;

    for (const p of pedestals) {
      if (!p.active) continue;
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  _targetAlive() {
    return this._target && this._target.mesh.visible && this._target.body.position.y > -2;
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
    let diff = targetAngle - this.carBody._yaw;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;
    return Math.abs(diff);
  }

  _steerToward(targetAngle) {
    if (this._steerCommitTimer > 0) return;
    let diff = targetAngle - this.carBody._yaw;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;

    const deadzone = 0.15;
    const newLeft = diff > deadzone, newRight = diff < -deadzone;
    if (newLeft !== this.input.left || newRight !== this.input.right) {
      this._steerCommitTimer = 0.12 + Math.random() * 0.1;
    }
    this.input.left = newLeft;
    this.input.right = newRight;
  }

  _countNearby(radius) {
    let count = 0;
    for (const other of this.getOtherBodies()) {
      if (other !== this.carBody && this._distTo(other) < radius) count++;
    }
    return count;
  }

  _enemyChargingUs() {
    const pos = this.carBody.body.position;
    for (const other of this.getOtherBodies()) {
      if (other === this.carBody) continue;
      if (this._distTo(other) > 10) continue;
      const vel = other.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      if (speed < 8) continue;
      const vAngle = Math.atan2(-vel.x, -vel.z);
      const angleToUs = Math.atan2(-(pos.x - other.body.position.x), -(pos.z - other.body.position.z));
      let diff = vAngle - angleToUs;
      while (diff > Math.PI) diff -= TWO_PI;
      while (diff < -Math.PI) diff += TWO_PI;
      if (Math.abs(diff) < 0.5) return true;
    }
    return false;
  }
}
