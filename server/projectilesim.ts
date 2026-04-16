/**
 * Server-side projectile simulator for bot-fired power-ups.
 *
 * Why this exists: the original design was client-authoritative — whoever
 * FIRED the missile simulated its flight locally and reported hits via
 * POWERUP_DAMAGE. When bots moved to the server (BUG 0) there was no
 * "firing client" for bot missiles, so a naive implementation would either
 * (a) hard-code an instant hit (which violates the game's dodge physics) or
 * (b) designate some human client as a relay (fragile, unfair).
 *
 * The solution is to run a lightweight sim of bot-fired projectiles on the
 * server using constants that match the client's PowerUpManager. The server
 * broadcasts POWERUP_USED for visuals; each client renders its own missile
 * for the bot, and the server authoritatively decides hit/miss. A target
 * that actually dodges on the wire IS dodged — the bot can and does miss.
 *
 * Only bot-fired projectiles live here. Human-fired projectiles stay on the
 * client-authoritative path (unchanged).
 *
 * Constants mirrored from client/src/core/PowerUpManager.js:
 *   MISSILE:   straight, speed=max(carSpeed*1.15, 20), accel=60, lifetime 4s,
 *              radius 1.5, damage 30.
 *   HOMING:    locks nearest within 80u, turns 2.8 rad/s, speed 28, lifetime 5s,
 *              radius 1.5, damage 30.
 *   TURRET:    stationary mount at fire point, fires every 0.8s for 6s,
 *              bullet speed 35, lifetime 1.5s, radius 0.4, damage 8.
 */

import { PlayerSnapshot } from './botsim.js';

export type ProjectileType = 'MISSILE' | 'HOMING_MISSILE' | 'TURRET_BULLET';

export interface ServerProjectile {
  id: number;
  type: ProjectileType;
  attackerId: string;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velZ: number;
  speed: number;          // current magnitude (used for MISSILE acceleration)
  birthTime: number;
  deathTime: number;
  radius: number;
  damage: number;
  // Homing-specific
  lockedTargetId?: string | null;
  lockLostAt?: number;
  // HOLO_EVADE decoy: when a homing missile acquires a target whose pilot
  // has HoloEvade active, 50% chance to latch onto a decoy that diverges
  // perpendicular to the target's heading. The projectile then chases a
  // phantom position that the real car is NOT at — matching client behavior
  // where homing locks onto one of the decoys instead of the real mesh.
  decoyPosX?: number;
  decoyPosZ?: number;
  decoyVelX?: number;
  decoyVelZ?: number;
  decoyExpireAt?: number;
  // Ignore this attacker in first few frames (avoids self-collision on spawn)
  selfIgnoreUntil: number;
}

export interface ServerTurret {
  id: number;
  attackerId: string;
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;              // turret head aim
  deathTime: number;
  nextFireAt: number;
  lockedTargetId?: string | null;
}

// Type-specific flight parameters — keep in sync with client defaults.
export const MISSILE = {
  speedMin: 20,
  speedScale: 1.15,       // multiplied by attacker speed at fire time
  accel: 60,
  lifetimeMs: 4000,
  radius: 1.5,
  damage: 30,
} as const;

export const HOMING = {
  speed: 28,
  turnRate: 2.8,          // rad/s
  seekRadius: 80,
  loseAngle: Math.PI * 0.6,
  lockRetryMs: 500,
  lifetimeMs: 5000,
  radius: 1.5,
  damage: 30,
} as const;

export const TURRET = {
  bulletSpeed: 35,
  bulletLifetimeMs: 1500,
  bulletRadius: 0.4,
  bulletDamage: 8,
  fireIntervalMs: 800,
  firstShotDelayMs: 200,
  durationMs: 6000,
  seekRadius: 25,
} as const;

let _projId = 1;
export function nextProjectileId(): number { return _projId++; }

/** Spawn a straight-line missile fired from (posX,posZ) with given yaw. */
export function spawnMissile(
  attackerId: string,
  posX: number, posY: number, posZ: number,
  yaw: number,
  attackerSpeed: number,
  now: number,
): ServerProjectile {
  const speed = Math.max(attackerSpeed * MISSILE.speedScale, MISSILE.speedMin);
  return {
    id: nextProjectileId(),
    type: 'MISSILE',
    attackerId,
    posX, posY, posZ,
    velX: Math.cos(yaw) * speed,
    velZ: Math.sin(yaw) * speed,
    speed,
    birthTime: now,
    deathTime: now + MISSILE.lifetimeMs,
    radius: MISSILE.radius,
    damage: MISSILE.damage,
    selfIgnoreUntil: now + 80,
  };
}

export function spawnHomingMissile(
  attackerId: string,
  posX: number, posY: number, posZ: number,
  yaw: number,
  now: number,
): ServerProjectile {
  return {
    id: nextProjectileId(),
    type: 'HOMING_MISSILE',
    attackerId,
    posX, posY, posZ,
    velX: Math.cos(yaw) * HOMING.speed,
    velZ: Math.sin(yaw) * HOMING.speed,
    speed: HOMING.speed,
    birthTime: now,
    deathTime: now + HOMING.lifetimeMs,
    radius: HOMING.radius,
    damage: HOMING.damage,
    lockedTargetId: null,
    lockLostAt: 0,
    selfIgnoreUntil: now + 100,
  };
}

export function spawnTurret(
  attackerId: string,
  posX: number, posY: number, posZ: number,
  yaw: number,
  now: number,
): ServerTurret {
  return {
    id: nextProjectileId(),
    attackerId,
    posX, posY, posZ,
    yaw,
    deathTime: now + TURRET.durationMs,
    nextFireAt: now + TURRET.firstShotDelayMs,
    lockedTargetId: null,
  };
}

export function spawnTurretBullet(
  attackerId: string,
  posX: number, posY: number, posZ: number,
  yaw: number,
  now: number,
): ServerProjectile {
  return {
    id: nextProjectileId(),
    type: 'TURRET_BULLET',
    attackerId,
    posX, posY, posZ,
    velX: Math.cos(yaw) * TURRET.bulletSpeed,
    velZ: Math.sin(yaw) * TURRET.bulletSpeed,
    speed: TURRET.bulletSpeed,
    birthTime: now,
    deathTime: now + TURRET.bulletLifetimeMs,
    radius: TURRET.bulletRadius,
    damage: TURRET.bulletDamage,
    selfIgnoreUntil: now + 50,
  };
}

/**
 * Integrate a projectile one step. Returns true if the projectile is still
 * alive after the step (hasn't exceeded deathTime).
 */
export function stepProjectile(
  proj: ServerProjectile,
  dt: number,
  players: PlayerSnapshot[],
  now: number,
): boolean {
  if (now >= proj.deathTime) return false;

  // Homing steering (done in velocity space, then reintegrated).
  if (proj.type === 'HOMING_MISSILE') {
    // Advance decoy (if any) with its own velocity. When the decoy window
    // expires, drop it and fall back to normal re-acquisition.
    if (proj.decoyExpireAt !== undefined && now >= proj.decoyExpireAt) {
      proj.decoyPosX = proj.decoyPosZ = undefined;
      proj.decoyVelX = proj.decoyVelZ = undefined;
      proj.decoyExpireAt = undefined;
      proj.lockedTargetId = null;
      proj.lockLostAt = now;
    } else if (proj.decoyPosX !== undefined && proj.decoyPosZ !== undefined) {
      proj.decoyPosX += (proj.decoyVelX ?? 0) * dt;
      proj.decoyPosZ += (proj.decoyVelZ ?? 0) * dt;
    }

    // Pick steering reference: live decoy first, else lock a real target.
    let steerX: number | null = null;
    let steerZ: number | null = null;
    if (proj.decoyPosX !== undefined && proj.decoyPosZ !== undefined) {
      steerX = proj.decoyPosX;
      steerZ = proj.decoyPosZ;
    } else if (_updateHomingLock(proj, players, now) && proj.lockedTargetId) {
      const t = players.find(p => p.id === proj.lockedTargetId);
      if (t) { steerX = t.posX; steerZ = t.posZ; }
    }

    if (steerX !== null && steerZ !== null) {
      const desired = Math.atan2(steerZ - proj.posZ, steerX - proj.posX);
      const curYaw = Math.atan2(proj.velZ, proj.velX);
      let diff = desired - curYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const applied = Math.max(-HOMING.turnRate * dt, Math.min(HOMING.turnRate * dt, diff));
      const newYaw = curYaw + applied;
      proj.velX = Math.cos(newYaw) * HOMING.speed;
      proj.velZ = Math.sin(newYaw) * HOMING.speed;
    }
  } else if (proj.type === 'MISSILE') {
    // Accelerate along current velocity direction.
    const dir = Math.atan2(proj.velZ, proj.velX);
    proj.speed += MISSILE.accel * dt;
    proj.velX = Math.cos(dir) * proj.speed;
    proj.velZ = Math.sin(dir) * proj.speed;
  }

  proj.posX += proj.velX * dt;
  proj.posZ += proj.velZ * dt;
  return true;
}

function _updateHomingLock(proj: ServerProjectile, players: PlayerSnapshot[], now: number): boolean {
  const curLocked = proj.lockedTargetId
    ? players.find(p => p.id === proj.lockedTargetId && !p.isEliminated)
    : undefined;

  // Drop lock if target became invincible/eliminated or strayed outside the
  // seeker cone. Then re-acquire after the retry window elapses.
  if (curLocked) {
    const dx = curLocked.posX - proj.posX;
    const dz = curLocked.posZ - proj.posZ;
    const dist = Math.hypot(dx, dz);
    const targetYaw = Math.atan2(dz, dx);
    const curYaw = Math.atan2(proj.velZ, proj.velX);
    let diff = targetYaw - curYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (dist > HOMING.seekRadius || Math.abs(diff) > HOMING.loseAngle || curLocked.isInvincible) {
      proj.lockedTargetId = null;
      proj.lockLostAt = now;
    } else {
      return true;
    }
  }

  if (proj.lockLostAt && (now - proj.lockLostAt) < HOMING.lockRetryMs) return false;

  // Re-acquire: nearest live, non-attacker, non-invincible within seekRadius.
  let bestTarget: PlayerSnapshot | null = null;
  let bestD2 = HOMING.seekRadius * HOMING.seekRadius;
  for (const p of players) {
    if (p.id === proj.attackerId || p.isEliminated || p.isInvincible) continue;
    const dx = p.posX - proj.posX;
    const dz = p.posZ - proj.posZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestTarget = p; }
  }

  if (!bestTarget) {
    proj.lockedTargetId = null;
    proj.lockLostAt = 0;
    return false;
  }

  // HOLO_EVADE: 50% chance the seeker latches onto a decoy diverging
  // perpendicular (±90°) from the target's heading at matched speed. The
  // decoy moves independently for the HoloEvade window (1.3s) so the real
  // car can steer away while the missile chases a ghost.
  if (bestTarget.holoEvadeActive && Math.random() < 0.5) {
    const targetSpeed = Math.max(Math.hypot(bestTarget.velX, bestTarget.velZ), 12);
    const sign = Math.random() < 0.5 ? 1 : -1;
    const decoyYaw = bestTarget.yaw + sign * (Math.PI / 2);
    proj.decoyPosX = bestTarget.posX;
    proj.decoyPosZ = bestTarget.posZ;
    proj.decoyVelX = Math.cos(decoyYaw) * targetSpeed;
    proj.decoyVelZ = Math.sin(decoyYaw) * targetSpeed;
    proj.decoyExpireAt = now + 1300;
    // No real lock while chasing a decoy — if the decoy times out we'll
    // re-enter re-acquisition from _updateHomingLock naturally.
    proj.lockedTargetId = null;
    proj.lockLostAt = 0;
    return true;
  }

  proj.lockedTargetId = bestTarget.id;
  proj.lockLostAt = 0;
  return true;
}

/**
 * Sweep the projectile's movement over the last dt against every player.
 * Returns the first victim hit this tick, or null.
 *
 * Uses capsule-vs-point: treat the projectile as a swept sphere over its
 * last segment. Cheap but prevents tunneling at 60 Hz even for fast missiles.
 */
export function sweepProjectileHit(
  proj: ServerProjectile,
  dt: number,
  players: PlayerSnapshot[],
  now: number,
): PlayerSnapshot | null {
  if (now < proj.selfIgnoreUntil) {
    // During the ignore window only skip the attacker. Other targets are
    // fair game (a missile fired into a crowd should still hit them).
  }
  // Endpoint positions of this tick's segment.
  const endX = proj.posX;
  const endZ = proj.posZ;
  const startX = endX - proj.velX * dt;
  const startZ = endZ - proj.velZ * dt;
  const segX = endX - startX;
  const segZ = endZ - startZ;
  const segLen2 = segX * segX + segZ * segZ;
  const carR = 1.4; // approximate car half-extent in XZ
  const r = proj.radius + carR;
  const r2 = r * r;

  let bestVictim: PlayerSnapshot | null = null;
  let bestT = 1.1; // any value > 1 so we only keep earliest hit on segment

  for (const p of players) {
    if (p.id === proj.attackerId && now < proj.selfIgnoreUntil) continue;
    if (p.isEliminated) continue;
    // Intentionally NOT skipping invincible — shield absorbs damage reduction
    // but the projectile still collides visually. Let the damage path decide.

    // Project (p - start) onto segment
    const px = p.posX - startX;
    const pz = p.posZ - startZ;
    let t = segLen2 > 1e-6 ? (px * segX + pz * segZ) / segLen2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = startX + segX * t;
    const cz = startZ + segZ * t;
    const dx = p.posX - cx;
    const dz = p.posZ - cz;
    if (dx * dx + dz * dz <= r2 && t <= bestT) {
      bestT = t;
      bestVictim = p;
    }
  }
  return bestVictim;
}

/** Integrate a turret one step. Returns true if still alive. */
export function stepTurret(
  t: ServerTurret,
  dt: number,
  players: PlayerSnapshot[],
  now: number,
): { alive: boolean; emit: ServerProjectile | null } {
  if (now >= t.deathTime) return { alive: false, emit: null };

  // Turret is mounted on the casting car: follow the owner's current position
  // each tick so visuals (client renders turret on the car mesh) match
  // server-side hit detection. If the owner has been despawned, the turret
  // stays where it was last seen until its lifetime runs out.
  const owner = players.find(p => p.id === t.attackerId);
  if (owner && !owner.isEliminated) {
    t.posX = owner.posX;
    t.posY = owner.posY;
    t.posZ = owner.posZ;
  }

  // Re-acquire target every tick: simple nearest within seekRadius.
  let bestTarget: PlayerSnapshot | null = null;
  let bestD2 = TURRET.seekRadius * TURRET.seekRadius;
  for (const p of players) {
    if (p.id === t.attackerId || p.isEliminated || p.isInvincible) continue;
    const dx = p.posX - t.posX;
    const dz = p.posZ - t.posZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestTarget = p; }
  }
  t.lockedTargetId = bestTarget ? bestTarget.id : null;

  // HOLO_EVADE: if target has it active, 50% chance each tick the turret
  // aims at a decoy direction instead (±90° from target heading). The bullet
  // fired on that tick flies off-target and misses. This matches the client
  // "50% chance to aim at a decoy" behaviour for AUTO_TURRET.
  let aimPosX: number | null = null;
  let aimPosZ: number | null = null;
  if (bestTarget) {
    if (bestTarget.holoEvadeActive && Math.random() < 0.5) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      const decoyYaw = bestTarget.yaw + sign * (Math.PI / 2);
      // Fake a point ~15u off the target's side — close enough the turret
      // actually slews there and actually fires.
      aimPosX = bestTarget.posX + Math.cos(decoyYaw) * 15;
      aimPosZ = bestTarget.posZ + Math.sin(decoyYaw) * 15;
    } else {
      aimPosX = bestTarget.posX;
      aimPosZ = bestTarget.posZ;
    }
  }

  if (aimPosX !== null && aimPosZ !== null) {
    const desired = Math.atan2(aimPosZ - t.posZ, aimPosX - t.posX);
    let diff = desired - t.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.max(-4.0 * dt, Math.min(4.0 * dt, diff));
    t.yaw += step;
  }

  // Fire if it's time AND there's an aim point AND the head is on-target.
  let emitted: ServerProjectile | null = null;
  if (aimPosX !== null && aimPosZ !== null && now >= t.nextFireAt) {
    const desired = Math.atan2(aimPosZ - t.posZ, aimPosX - t.posX);
    let diff = desired - t.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < 0.2) {
      emitted = spawnTurretBullet(t.attackerId, t.posX, t.posY + 0.6, t.posZ, t.yaw, now);
      t.nextFireAt = now + TURRET.fireIntervalMs;
    }
  }

  return { alive: true, emit: emitted };
}
