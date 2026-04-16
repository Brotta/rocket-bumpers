import {
  DAMAGE,
  COLLISION_GROUPS,
  PHYSICS,
  RESPAWN,
  KO_ATTRIBUTION,
  SHIELD_VS_RAM,
  OBSTACLE_STUN,
} from '../core/Config.js';
import { AbilitySystem } from './AbilitySystem.js';

/**
 * CollisionHandler — detects car-car collisions, trail-fire hits, and
 * fall-offs. Calculates physics-based damage using mass, velocity, and
 * impact angle. Manages lastHitBy attribution and the global velocity cap.
 *
 * Constructor:
 *   world          – CANNON.World
 *   getCarBodies() – returns CarBody[] of ALL active cars
 *
 * Call update() once per frame AFTER physics step.
 *
 * Listen to events via on(eventName, callback):
 *   'damage'     { target: CarBody, amount, source: CarBody|null, tier, wasAbility }
 *   'eliminated' { victim: CarBody, killer: CarBody|null, wasAbility }
 *   'trail-hit'  { attacker: CarBody, victim: CarBody, damage }
 *   'fell'       { victim: CarBody }
 */
export class CollisionHandler {
  constructor(world, getCarBodies, floorBody) {
    this.world = world;
    this.getCarBodies = getCarBodies;
    this._floorBody = floorBody || null;

    // Deduplicate contacts per step (by sorted body ids)
    this._processedPairs = new Set();

    // Event listeners
    this._listeners = {};

    // Track bodies we've registered listeners on
    this._registeredBodies = new Set();

    // O(1) lookup: physics body id → CarBody (rebuilt each frame in update())
    this._bodyToCarMap = new Map();

    // Per-pair damage cooldown: "idA-idB" → timestamp when cooldown expires
    this._pairCooldowns = new Map();

    // Multiplayer: reference to NetworkManager (set by Game.connectMultiplayer)
    this._networkManager = null;

    // World post-step: enforce velocity cap on all cars
    this.world.addEventListener('postStep', () => this._postStep());
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
  }

  off(event, fn) {
    const arr = this._listeners[event];
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }

  _emit(event, data) {
    const arr = this._listeners[event];
    if (arr) for (const fn of arr) fn(data);
  }

  // ── Per-frame update (call after physicsWorld.step) ───────────────────

  update() {
    this._processedPairs.clear();

    const carBodies = this.getCarBodies();

    // Rebuild body→CarBody map once per frame for O(1) lookups in _onCollide
    this._bodyToCarMap.clear();
    for (const cb of carBodies) {
      this._bodyToCarMap.set(cb.body.id, cb);
    }

    // Register collide listeners on new bodies
    for (const cb of carBodies) {
      if (!this._registeredBodies.has(cb.body.id)) {
        this._registeredBodies.add(cb.body.id);
        cb.body.addEventListener('collide', (e) => this._onCollide(cb, e));
      }
    }

    // Check falls (only once per fall — guard with _isFalling flag)
    for (const cb of carBodies) {
      if (cb.body.position.y < RESPAWN.fallOffY && !cb._isFalling && !cb.isEliminated) {
        cb._isFalling = true;
        this._handleFall(cb);
      }
    }

    // Check trail-fire proximity (trail bodies are triggers — use distance)
    this._checkTrailHits(carBodies);
  }

  // ── Damage formula (approach-velocity model) ──────────────────────────
  //
  // Only cars moving TOWARD the other deal damage.
  // damage = BASE × (approachSpeed / REF_SPEED) × sqrt(attackerMass) × angleFactor
  // finalDamage = rawDamage / (1 + victimMass × ARMOR_FACTOR)

  /**
   * Calculate approach speed: how fast `car` is moving toward `other`.
   * Returns 0 if car is moving away or stationary relative to other.
   *
   * Known limitation: For remote players, body.velocity is set from the
   * latest network state which may be 50ms+ stale. This is inherent to
   * networked games. The velocity used here comes from the physics body
   * which is updated each frame from network interpolation, so it is the
   * best available approximation.
   */
  _approachSpeed(car, other) {
    // Axis from car toward other
    const dx = other.body.position.x - car.body.position.x;
    const dz = other.body.position.z - car.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return 0;

    const axisX = dx / dist;
    const axisZ = dz / dist;

    // Project car's velocity onto that axis
    const dot = car.body.velocity.x * axisX + car.body.velocity.z * axisZ;
    return Math.max(0, dot); // only positive = moving toward
  }

  /**
   * Calculate angle factor based on impact direction vs victim facing.
   */
  _angleFactor(attacker, victim) {
    const dx = victim.body.position.x - attacker.body.position.x;
    const dz = victim.body.position.z - attacker.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.1) return DAMAGE.ANGLE_MAX;

    const impDirX = dx / dist;
    const impDirZ = dz / dist;

    const victimFwdX = -Math.sin(victim._yaw);
    const victimFwdZ = -Math.cos(victim._yaw);

    const dot = Math.abs(impDirX * victimFwdX + impDirZ * victimFwdZ);
    return DAMAGE.ANGLE_MIN + (DAMAGE.ANGLE_MAX - DAMAGE.ANGLE_MIN) * dot;
  }

  /**
   * Calculate damage that `attacker` deals to `victim` based on approach speed.
   * @param {number} approachSpeed — attacker's speed toward victim
   * @returns {number} clamped final damage
   */
  _calcDamage(attacker, victim, approachSpeed) {
    if (approachSpeed < DAMAGE.MIN_SPEED) return 0;

    const velocityFactor = approachSpeed / DAMAGE.REF_SPEED;
    const massFactor = Math.sqrt(attacker.body.mass);
    const angleFactor = this._angleFactor(attacker, victim);

    const raw = DAMAGE.BASE_DAMAGE * velocityFactor * massFactor * angleFactor;

    // Victim armor: heavier cars resist damage better
    const armor = 1 + victim.body.mass * DAMAGE.ARMOR_FACTOR;
    const final = raw / armor;

    return Math.min(Math.max(final, DAMAGE.MIN_DAMAGE), DAMAGE.MAX_DAMAGE);
  }

  /**
   * Determine hit tier for VFX feedback based on damage dealt.
   */
  _hitTier(damage) {
    if (damage >= 30) return 'devastating';
    if (damage >= 15) return 'heavy';
    return 'light';
  }

  // ── Cannon-es collide callback ────────────────────────────────────────

  _onCollide(carBody, event) {
    const otherPhysBody = event.body;

    // O(1) lookup for the CarBody that owns the other physics body
    const otherCar = this._bodyToCarMap.get(otherPhysBody.id) || null;

    // Car-obstacle collision: static arena bodies (pillars, boulders)
    // NOTE: Remote players skip damage (server handles it) but VFX still plays locally.
    if (!otherCar && otherPhysBody.mass === 0
        && (otherPhysBody.collisionFilterGroup & COLLISION_GROUPS.ARENA)
        && !otherPhysBody._isLava && otherPhysBody !== this._floorBody) {
      const contact = event.contact;
      if (!contact) return;

      // Remote players: emit VFX only (sparks, stun animation), no local damage
      if (carBody._isRemote) {
        const dx2 = carBody.body.position.x - otherPhysBody.position.x;
        const dz2 = carBody.body.position.z - otherPhysBody.position.z;
        const d2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
        const speed = Math.sqrt(
          carBody.body.velocity.x * carBody.body.velocity.x +
          carBody.body.velocity.z * carBody.body.velocity.z,
        );
        if (speed >= OBSTACLE_STUN.minStunSpeed) {
          const hitX = (carBody.body.position.x + otherPhysBody.position.x) * 0.5;
          const hitZ = (carBody.body.position.z + otherPhysBody.position.z) * 0.5;
          const hitY = carBody.body.position.y;
          this._emit('obstacle-hit', {
            carBody, speed, stunDuration: 0,
            hitX, hitY, hitZ,
            normalX: dx2 / d2, normalZ: dz2 / d2,
          });
        }
        return;
      }

      // Skip if already stunned or in stun immunity window
      if (carBody._isStunned || carBody._stunImmunityTimer > 0) {
        const dx2 = carBody.body.position.x - otherPhysBody.position.x;
        const dz2 = carBody.body.position.z - otherPhysBody.position.z;
        const d2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
        carBody.body.position.x += (dx2 / d2) * 0.2;
        carBody.body.position.z += (dz2 / d2) * 0.2;
        return;
      }

      // Normal pointing from obstacle toward car
      const nx = contact.ni.x;
      const nz = contact.ni.z;
      const ddx = carBody.body.position.x - otherPhysBody.position.x;
      const ddz = carBody.body.position.z - otherPhysBody.position.z;
      const dot = ddx * nx + ddz * nz;
      const sign = dot >= 0 ? 1 : -1;
      const nnx = nx * sign;
      const nnz = nz * sign;

      // Impact speed
      const speed = Math.sqrt(
        carBody.body.velocity.x * carBody.body.velocity.x +
        carBody.body.velocity.z * carBody.body.velocity.z,
      );

      // ── Below stun threshold: soft bounce only (no damage, no stun) ──
      if (speed < OBSTACLE_STUN.minStunSpeed) {
        carBody.body.velocity.x = nnx * OBSTACLE_STUN.bounceForce;
        carBody.body.velocity.z = nnz * OBSTACLE_STUN.bounceForce;
        carBody.body.position.x += nnx * OBSTACLE_STUN.pushOut;
        carBody.body.position.z += nnz * OBSTACLE_STUN.pushOut;
        carBody._currentSpeed *= 0.5;
        carBody._internalVelX = carBody.body.velocity.x;
        carBody._internalVelZ = carBody.body.velocity.z;
        carBody._lastSetVelX = carBody.body.velocity.x;
        carBody._lastSetVelZ = carBody.body.velocity.z;
        return;
      }

      // ── Above threshold: full stun + damage ──

      // Obstacle damage (proportional to speed, capped)
      const obsDmg = Math.min(DAMAGE.OBSTACLE_DAMAGE * (speed / 20), DAMAGE.OBSTACLE_DAMAGE);
      if (obsDmg > 0) {
        const isMultiplayer = this._networkManager?.isMultiplayer;
        if (isMultiplayer) {
          // In multiplayer, report obstacle damage to server — server applies HP
          this._networkManager.sendObstacleDamage(obsDmg);
          this._emit('damage', {
            target: carBody, amount: obsDmg, source: null,
            tier: 'light', wasAbility: false,
            _vfxOnly: true,
          });
        } else {
          const actual = carBody.takeDamage(obsDmg);
          if (actual > 0) {
            this._emit('damage', {
              target: carBody, amount: actual, source: null,
              tier: 'light', wasAbility: false,
            });
            this._checkEliminated(carBody, null, false);
          }
        }
      }

      // Gentle push-away (capped, not speed-proportional)
      carBody.body.velocity.x = nnx * OBSTACLE_STUN.bounceForce;
      carBody.body.velocity.z = nnz * OBSTACLE_STUN.bounceForce;

      // Push position out to prevent sticking
      carBody.body.position.x += nnx * OBSTACLE_STUN.pushOut;
      carBody.body.position.z += nnz * OBSTACLE_STUN.pushOut;

      // Kill car speed
      carBody._currentSpeed *= (1 - OBSTACLE_STUN.speedKill);
      carBody._internalVelX = carBody.body.velocity.x;
      carBody._internalVelZ = carBody.body.velocity.z;
      carBody._lastSetVelX = carBody.body.velocity.x;
      carBody._lastSetVelZ = carBody.body.velocity.z;

      // Stun duration scales with impact speed
      const speedT = Math.min(speed / OBSTACLE_STUN.speedForMaxStun, 1);
      const stunDuration = OBSTACLE_STUN.minDuration
        + speedT * (OBSTACLE_STUN.maxDuration - OBSTACLE_STUN.minDuration);

      carBody._isStunned = true;
      carBody._stunTimer = stunDuration;
      carBody._stunSpinRate = (Math.random() > 0.5 ? 1 : -1) * OBSTACLE_STUN.spinRate;

      const hitX = (carBody.body.position.x + otherPhysBody.position.x) * 0.5;
      const hitZ = (carBody.body.position.z + otherPhysBody.position.z) * 0.5;
      const hitY = carBody.body.position.y;
      this._emit('obstacle-hit', {
        carBody, speed, stunDuration,
        hitX, hitY, hitZ,
        normalX: nnx, normalZ: nnz,
      });
      return;
    }

    // Only process car-car collisions
    if (!otherCar) return;

    // Deduplicate: process each pair once per frame
    const idA = Math.min(carBody.body.id, otherCar.body.id);
    const idB = Math.max(carBody.body.id, otherCar.body.id);
    const pairKey = `${idA}-${idB}`;
    if (this._processedPairs.has(pairKey)) return;
    this._processedPairs.add(pairKey);

    // Skip if either car is invincible or eliminated
    if (carBody.isInvincible || otherCar.isInvincible) return;
    if (carBody.isEliminated || otherCar.isEliminated) return;

    // ── Per-pair damage cooldown: skip if this pair already hit recently ──
    const now = Date.now();
    const cooldownExpiry = this._pairCooldowns.get(pairKey) || 0;
    if (now < cooldownExpiry) return;

    // ── Approach velocity: each car's speed toward the other ──
    const approachA = this._approachSpeed(carBody, otherCar);
    const approachB = this._approachSpeed(otherCar, carBody);

    // No damage if neither is approaching fast enough
    if (approachA < DAMAGE.MIN_SPEED && approachB < DAMAGE.MIN_SPEED) return;

    // ── Set cooldown for this pair ──
    this._pairCooldowns.set(pairKey, now + DAMAGE.PAIR_COOLDOWN * 1000);

    // ── Shield vs RAM resolution ──
    this._resolveShieldRam(carBody, otherCar);

    // ── Approach-based damage: only cars moving toward the other deal damage ──
    const wasAbilityA = carBody.hasRam;
    const wasAbilityB = otherCar.hasRam;

    // A attacks B (only if A is approaching B)
    const dmgAtoB = this._calcDamage(carBody, otherCar, approachA);
    // B attacks A (only if B is approaching A)
    const dmgBtoA = this._calcDamage(otherCar, carBody, approachB);

    const tierAtoB = this._hitTier(dmgAtoB);
    const tierBtoA = this._hitTier(dmgBtoA);

    const isMultiplayer = this._networkManager?.isMultiplayer;

    if (isMultiplayer) {
      // ── Multiplayer: report collision to server, let server apply damage ──
      // Only the locally-simulated attacker reports, to avoid double-counting.
      //
      // Dedup rules:
      //  - Both local (host + own bot, offline-style): send both directions.
      //  - One side is a SERVER-OWNED BOT (id starts with 'bot_'): always
      //    send. The bot has no client to send on its behalf, so dropping
      //    the message means the server only ever sees this collision via
      //    its own _detectBotCollisions sweep — fine in theory but the
      //    server pass costs a tick of latency and used to silently drop
      //    via the sign-bug. Safer to always report.
      //  - Otherwise (local human vs remote human): the lower playerId sends
      //    so exactly one of the two clients reports per pair.
      const bothLocal = !carBody._isRemote && !otherCar._isRemote;
      const otherIsBot = otherCar._isRemote && typeof otherCar.playerId === 'string'
        && otherCar.playerId.startsWith('bot_');
      const carIsBot = carBody._isRemote && typeof carBody.playerId === 'string'
        && carBody.playerId.startsWith('bot_');
      if (dmgAtoB > 0 && !carBody._isRemote && carBody.playerId
          && (bothLocal || otherIsBot || carBody.playerId < otherCar.playerId)) {
        this._networkManager.sendCollision(
          otherCar.playerId,
          approachA,
          carBody.body.mass,
          otherCar.body.mass,
          this._angleFactor(carBody, otherCar),
          wasAbilityA,
          carBody.playerId,
        );
      }
      if (dmgBtoA > 0 && !otherCar._isRemote && otherCar.playerId
          && (bothLocal || carIsBot || otherCar.playerId < carBody.playerId)) {
        this._networkManager.sendCollision(
          carBody.playerId,
          approachB,
          otherCar.body.mass,
          carBody.body.mass,
          this._angleFactor(otherCar, carBody),
          wasAbilityB,
          otherCar.playerId,
        );
      }

      // Still emit local VFX events (immediate feedback, no HP change)
      if (dmgAtoB > 0) {
        this._emit('damage', {
          target: otherCar, amount: dmgAtoB, source: carBody,
          tier: tierAtoB, wasAbility: wasAbilityA,
          _vfxOnly: true,
        });
      }
      if (dmgBtoA > 0) {
        this._emit('damage', {
          target: carBody, amount: dmgBtoA, source: otherCar,
          tier: tierBtoA, wasAbility: wasAbilityB,
          _vfxOnly: true,
        });
      }
    } else {
      // ── Single player: apply damage directly ──
      if (dmgAtoB > 0) {
        const actual = otherCar.takeDamage(dmgAtoB, carBody, wasAbilityA);
        if (actual > 0) {
          this._emit('damage', {
            target: otherCar, amount: actual, source: carBody,
            tier: tierAtoB, wasAbility: wasAbilityA,
          });
        }
      }

      if (dmgBtoA > 0) {
        const actual = carBody.takeDamage(dmgBtoA, otherCar, wasAbilityB);
        if (actual > 0) {
          this._emit('damage', {
            target: carBody, amount: actual, source: otherCar,
            tier: tierBtoA, wasAbility: wasAbilityB,
          });
        }
      }
    }

    // ── Emit car-impact event for VFX/SFX (once per collision, uses max damage of the two) ──
    const maxDmg = Math.max(dmgAtoB, dmgBtoA);
    if (maxDmg > 0) {
      const impactTier = maxDmg >= 30 ? 'devastating' : maxDmg >= 15 ? 'heavy' : 'light';
      const midX = (carBody.body.position.x + otherCar.body.position.x) * 0.5;
      const midY = (carBody.body.position.y + otherCar.body.position.y) * 0.5;
      const midZ = (carBody.body.position.z + otherCar.body.position.z) * 0.5;
      const sepXn = carBody.body.position.x - otherCar.body.position.x;
      const sepZn = carBody.body.position.z - otherCar.body.position.z;
      const sepDn = Math.sqrt(sepXn * sepXn + sepZn * sepZn) || 1;
      this._emit('car-impact', {
        tier: impactTier,
        x: midX, y: midY, z: midZ,
        nx: sepXn / sepDn, nz: sepZn / sepDn,
        carA: carBody, carB: otherCar,
        damageA: dmgAtoB, damageB: dmgBtoA,
      });
    }

    // ── Bounce apart: push cars away from each other ──
    const sepX = carBody.body.position.x - otherCar.body.position.x;
    const sepZ = carBody.body.position.z - otherCar.body.position.z;
    const sepDist = Math.sqrt(sepX * sepX + sepZ * sepZ) || 1;
    const bnx = sepX / sepDist;
    const bnz = sepZ / sepDist;
    const bounce = DAMAGE.BOUNCE_IMPULSE;

    carBody.body.velocity.x += bnx * bounce;
    carBody.body.velocity.z += bnz * bounce;
    carBody._internalVelX += bnx * bounce;
    carBody._internalVelZ += bnz * bounce;
    carBody.body._justBounced = true;

    if (!otherCar._isRemote) {
      otherCar.body._justBounced = true;
    }

    if (!otherCar._isRemote) {
      otherCar.body.velocity.x -= bnx * bounce;
      otherCar.body.velocity.z -= bnz * bounce;
      otherCar._internalVelX -= bnx * bounce;
      otherCar._internalVelZ -= bnz * bounce;
    }

    // Check eliminations after both damages are applied (single player only)
    if (!isMultiplayer) {
      this._checkEliminated(otherCar, carBody, wasAbilityA);
      this._checkEliminated(carBody, otherCar, wasAbilityB);
    }
  }

  // ── Elimination check ─────────────────────────────────────────────────

  _checkEliminated(victim, killer, wasAbility) {
    if (victim.isEliminated && !victim._eliminationEmitted) {
      victim._eliminationEmitted = true;
      this._emit('eliminated', { victim, killer, wasAbility });
    }
  }

  // ── Shield vs RAM ────────────────────────────────────────────────────

  _resolveShieldRam(bodyA, bodyB) {
    if (bodyA.hasShield && bodyB.hasRam) {
      const vBefore = { x: bodyA.body.velocity.x, z: bodyA.body.velocity.z };
      this._scheduleShieldDampen(bodyA, vBefore);
    }
    if (bodyB.hasShield && bodyA.hasRam) {
      const vBefore = { x: bodyB.body.velocity.x, z: bodyB.body.velocity.z };
      this._scheduleShieldDampen(bodyB, vBefore);
    }

    if (bodyA.hasShield && !bodyB.hasRam) {
      this._scheduleShieldBlock(bodyA);
    }
    if (bodyB.hasShield && !bodyA.hasRam) {
      this._scheduleShieldBlock(bodyB);
    }
  }

  _scheduleShieldDampen(shieldedCar, velBefore) {
    requestAnimationFrame(() => {
      const body = shieldedCar.body;
      const dvx = body.velocity.x - velBefore.x;
      const dvz = body.velocity.z - velBefore.z;
      body.velocity.x = velBefore.x + dvx * SHIELD_VS_RAM.forceAbsorption;
      body.velocity.z = velBefore.z + dvz * SHIELD_VS_RAM.forceAbsorption;
    });
  }

  _scheduleShieldBlock(shieldedCar) {
    const vx = shieldedCar.body.velocity.x;
    const vz = shieldedCar.body.velocity.z;
    requestAnimationFrame(() => {
      shieldedCar.body.velocity.x = vx;
      shieldedCar.body.velocity.z = vz;
    });
  }

  // ── Trail fire proximity check (swept — car path vs stationary trail) ──

  _checkTrailHits(carBodies) {
    const trailBodies = AbilitySystem._activeTrailBodies;
    if (!trailBodies || trailBodies.size === 0) return;

    const TRAIL_RADIUS_SQ = 2.25; // 1.5² — larger radius to catch fast cars

    for (const worldBody of trailBodies) {
      if (!worldBody._isTrailFire) continue;

      const owner = worldBody._ownerId;
      const tx = worldBody.position.x;
      const tz = worldBody.position.z;

      for (const cb of carBodies) {
        if (cb === owner) continue;
        if (cb.isInvincible || cb.isEliminated) continue;

        // Swept check: trace the car's movement path (prev→curr) against trail
        const cx = cb.body.position.x;
        const cz = cb.body.position.z;
        const px = cb._prevPosX !== undefined ? cb._prevPosX : cx;
        const pz = cb._prevPosZ !== undefined ? cb._prevPosZ : cz;

        // Segment: car previous pos → car current pos
        const segX = cx - px;
        const segZ = cz - pz;
        const segLenSq = segX * segX + segZ * segZ;

        let closestX, closestZ;
        if (segLenSq < 0.0001) {
          closestX = cx;
          closestZ = cz;
        } else {
          const toTrailX = tx - px;
          const toTrailZ = tz - pz;
          let t = (toTrailX * segX + toTrailZ * segZ) / segLenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          closestX = px + segX * t;
          closestZ = pz + segZ * t;
        }

        const dx = cx - tx; // use current pos for knockback direction
        const dz = cz - tz;
        const cdx = closestX - tx;
        const cdz = closestZ - tz;
        const distSq = cdx * cdx + cdz * cdz;

        if (distSq < TRAIL_RADIUS_SQ) {
          // Apply knockback away from trail fire
          const dist = Math.sqrt(dx * dx + dz * dz);
          const nx = dist > 0.01 ? dx / dist : 0;
          const nz = dist > 0.01 ? dz / dist : 1;
          cb.body.velocity.x += nx * 8;
          cb.body.velocity.z += nz * 8;
          cb.body.velocity.y += 2;

          // Apply trail damage
          let actual = 0;
          if (cb._isRemote && this._networkManager?.isMultiplayer) {
            this._networkManager.sendPowerUpDamage(cb.playerId, DAMAGE.TRAIL_DAMAGE, 'TRAIL_FIRE', owner?.playerId);
            actual = DAMAGE.TRAIL_DAMAGE; // for VFX
          } else {
            actual = cb.takeDamage(DAMAGE.TRAIL_DAMAGE, owner, true);
          }

          // Remove this trail body after hit (one-shot damage)
          worldBody._isTrailFire = false;
          this._emit('trail-hit', { attacker: owner, victim: cb, damage: actual });
          this._emit('damage', {
            target: cb, amount: actual, source: owner,
            tier: 'light', wasAbility: true,
          });
          this._checkEliminated(cb, owner, true);
        }
      }
    }
  }

  // ── Fall detection ────────────────────────────────────────────────────

  _handleFall(carBody) {
    const isMultiplayer = this._networkManager?.isMultiplayer;

    if (isMultiplayer) {
      // In multiplayer, report fall to server — server handles damage
      const hit = carBody.lastHitBy;
      const now = Date.now();
      const windowMs = KO_ATTRIBUTION.windowSeconds * 1000;
      const withinWindow = hit && (now - hit.time) < windowMs;
      const lastHitById = withinWindow ? hit.source?.playerId : null;
      const lastHitTime = withinWindow ? hit.time : 0;
      this._networkManager.sendPlayerFell(lastHitById, carBody.playerId, lastHitTime);
    } else {
      // Single player: apply fall damage directly
      const actual = carBody.takeDamage(DAMAGE.FALL_DAMAGE);
      if (actual > 0) {
        this._emit('damage', {
          target: carBody, amount: actual, source: null,
          tier: 'heavy', wasAbility: false,
        });
      }

      // Check if the fall eliminated the car
      if (carBody.isEliminated) {
        const hit = carBody.lastHitBy;
        const now = Date.now();
        const windowMs = KO_ATTRIBUTION.windowSeconds * 1000;
        const killer = (hit && (now - hit.time) < windowMs) ? hit.source : null;
        const wasAbility = killer ? hit.wasAbility : false;
        this._checkEliminated(carBody, killer, wasAbility);
      }
    }

    this._emit('fell', { victim: carBody });
  }

  // ── Post-step: global velocity cap ────────────────────────────────────

  _postStep() {
    const carBodies = this.getCarBodies();
    for (const cb of carBodies) {
      const vel = cb.body.velocity;
      const speed = vel.length();
      // Allow 1.5x velocity cap for 1 frame after a bounce to preserve impulse
      const cap = cb.body._justBounced
        ? PHYSICS.maxVelocity * 1.5
        : PHYSICS.maxVelocity;
      if (speed > cap) {
        vel.scale(cap / speed, vel);
      }
      cb.body._justBounced = false;
    }
  }
}
