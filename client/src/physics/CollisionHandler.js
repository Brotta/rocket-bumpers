import {
  SCORING,
  COLLISION_GROUPS,
  PHYSICS,
  RESPAWN,
  KO_ATTRIBUTION,
  SHIELD_VS_RAM,
} from '../core/Config.js';
import { AbilitySystem } from './AbilitySystem.js';

/**
 * CollisionHandler — detects car-car collisions, trail-fire hits, and
 * fall-offs. Scores hits, manages lastHitBy attribution, enforces the
 * global velocity cap, and handles Shield-vs-RAM resolution.
 *
 * Constructor:
 *   world          – CANNON.World
 *   getCarBodies() – returns CarBody[] of ALL active cars
 *
 * Call update() once per frame AFTER physics step.
 *
 * Listen to events via on(eventName, callback):
 *   'hit'        { attacker: CarBody, victim: CarBody, points, tier }
 *   'ko'         { attacker: CarBody, victim: CarBody, points, isAbilityKO }
 *   'self-ko'    { victim: CarBody, points }
 *   'trail-hit'  { attacker: CarBody, victim: CarBody }
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
    const now = performance.now();
    for (const cb of carBodies) {
      if (cb.body.position.y < RESPAWN.fallOffY && !cb._isFalling) {
        cb._isFalling = true;
        this._handleFall(cb, now);
      }
    }

    // Check trail-fire proximity (trail bodies are triggers — use distance)
    this._checkTrailHits(carBodies, now);
  }

  // ── Cannon-es collide callback ────────────────────────────────────────

  _onCollide(carBody, event) {
    const otherPhysBody = event.body;

    // O(1) lookup for the CarBody that owns the other physics body
    const otherCar = this._bodyToCarMap.get(otherPhysBody.id) || null;

    // Car-obstacle collision: static arena bodies (pillars, boulders)
    // The bicycle model overwrites velocity each frame, so we must apply
    // an explicit bounce impulse + kill forward speed on contact.
    if (!otherCar && otherPhysBody.mass === 0
        && (otherPhysBody.collisionFilterGroup & COLLISION_GROUPS.ARENA)
        && !otherPhysBody._isLava && otherPhysBody !== this._floorBody) {
      const contact = event.contact;
      if (!contact) return;
      // Normal pointing from obstacle toward car
      const nx = contact.ni.x;
      const nz = contact.ni.z;
      // Flip normal if it points away from the car
      const dx = carBody.body.position.x - otherPhysBody.position.x;
      const dz = carBody.body.position.z - otherPhysBody.position.z;
      const dot = dx * nx + dz * nz;
      const sign = dot >= 0 ? 1 : -1;
      const nnx = nx * sign;
      const nnz = nz * sign;

      // Push car away from obstacle
      const speed = Math.sqrt(
        carBody.body.velocity.x * carBody.body.velocity.x +
        carBody.body.velocity.z * carBody.body.velocity.z,
      );
      const bounceForce = Math.max(speed * 0.6, 5);
      carBody.body.velocity.x = nnx * bounceForce;
      carBody.body.velocity.z = nnz * bounceForce;

      // Also push position out to prevent sticking
      carBody.body.position.x += nnx * 0.3;
      carBody.body.position.z += nnz * 0.3;

      // Kill the car's internal speed so the bicycle model doesn't
      // immediately push back into the obstacle
      carBody._currentSpeed *= -0.3;
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

    // Skip if either car is invincible (respawn / PHASE)
    if (carBody.isInvincible || otherCar.isInvincible) return;

    // Calculate relative velocity
    const vx = carBody.body.velocity.x - otherCar.body.velocity.x;
    const vy = carBody.body.velocity.y - otherCar.body.velocity.y;
    const vz = carBody.body.velocity.z - otherCar.body.velocity.z;
    const relSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);

    if (relSpeed < SCORING.hitThresholds.normal) return;

    // ── Shield vs RAM resolution ──
    this._resolveShieldRam(carBody, otherCar);

    // ── Determine attacker (higher speed) ──
    const speedA = carBody.body.velocity.length();
    const speedB = otherCar.body.velocity.length();
    const attacker = speedA >= speedB ? carBody : otherCar;
    const victim = attacker === carBody ? otherCar : carBody;

    // ── Scoring tier ──
    let points, tier;
    if (relSpeed >= SCORING.hitThresholds.mega) {
      points = SCORING.megaHit;
      tier = 'mega';
    } else if (relSpeed >= SCORING.hitThresholds.big) {
      points = SCORING.bigHit;
      tier = 'big';
    } else {
      points = SCORING.hit;
      tier = 'normal';
    }

    attacker.score += points;

    // ── KO attribution ──
    const now = performance.now();
    const wasAbility = attacker.hasRam; // RAM collision → wasAbility
    victim.lastHitBy = { source: attacker, wasAbility, time: now };

    this._emit('hit', { attacker, victim, points, tier, relSpeed });
  }

  // ── Shield vs RAM ────────────────────────────────────────────────────

  _resolveShieldRam(bodyA, bodyB) {
    // If one has shield and the other has RAM: shield absorbs 50%
    if (bodyA.hasShield && bodyB.hasRam) {
      // Reduce A's knockback to 50% (halve velocity change)
      const vBefore = { x: bodyA.body.velocity.x, z: bodyA.body.velocity.z };
      // We schedule a post-contact correction on next frame
      this._scheduleShieldDampen(bodyA, vBefore);
    }
    if (bodyB.hasShield && bodyA.hasRam) {
      const vBefore = { x: bodyB.body.velocity.x, z: bodyB.body.velocity.z };
      this._scheduleShieldDampen(bodyB, vBefore);
    }

    // Pure shield (no RAM opponent): zero knockback
    if (bodyA.hasShield && !bodyB.hasRam) {
      this._scheduleShieldBlock(bodyA);
    }
    if (bodyB.hasShield && !bodyA.hasRam) {
      this._scheduleShieldBlock(bodyB);
    }
  }

  _scheduleShieldDampen(shieldedCar, velBefore) {
    // After cannon-es resolves the contact, dampen the velocity change by 50%
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

  // ── Trail fire proximity check ────────────────────────────────────────

  _checkTrailHits(carBodies, now) {
    // Use AbilitySystem's static trail body registry (avoids scanning all world.bodies)
    const trailBodies = AbilitySystem._activeTrailBodies;
    if (!trailBodies || trailBodies.size === 0) return;

    for (const worldBody of trailBodies) {
      if (!worldBody._isTrailFire) continue;

      const owner = worldBody._ownerId; // CarBody that spawned this trail
      const tx = worldBody.position.x;
      const tz = worldBody.position.z;

      for (const cb of carBodies) {
        if (cb === owner) continue; // don't hit yourself
        if (cb.isInvincible) continue;

        const dx = cb.body.position.x - tx;
        const dz = cb.body.position.z - tz;
        const distSq = dx * dx + dz * dz;

        if (distSq < 1.44) { // 1.2 * 1.2
          // Apply knockback away from trail fire
          const dist = Math.sqrt(distSq);
          const nx = dist > 0.01 ? dx / dist : 0;
          const nz = dist > 0.01 ? dz / dist : 1;
          cb.body.velocity.x += nx * 8;
          cb.body.velocity.z += nz * 8;
          cb.body.velocity.y += 2;

          // KO attribution
          cb.lastHitBy = { source: owner, wasAbility: true, time: now };

          // Remove this trail body after hit (one-shot damage)
          worldBody._isTrailFire = false; // prevent re-triggering
          this._emit('trail-hit', { attacker: owner, victim: cb });
        }
      }
    }
  }

  // ── Fall detection ────────────────────────────────────────────────────

  _handleFall(carBody, now) {
    const windowMs = KO_ATTRIBUTION.windowSeconds * 1000;
    const hit = carBody.lastHitBy;

    if (hit && (now - hit.time) < windowMs) {
      // Credited KO
      const isAbilityKO = hit.wasAbility;
      const points = isAbilityKO ? SCORING.abilityKO : SCORING.knockOff;
      hit.source.score += points;
      carBody.score += SCORING.fallOff;

      this._emit('ko', {
        attacker: hit.source,
        victim: carBody,
        points,
        isAbilityKO,
      });
    } else {
      // Self-KO
      carBody.score += SCORING.fallOff;
      this._emit('self-ko', { victim: carBody, points: SCORING.fallOff });
    }

    // Clear attribution
    carBody.lastHitBy = null;

    this._emit('fell', { victim: carBody });
  }

  // ── Post-step: global velocity cap ────────────────────────────────────

  _postStep() {
    const carBodies = this.getCarBodies();
    for (const cb of carBodies) {
      const vel = cb.body.velocity;
      const speed = vel.length();
      if (speed > PHYSICS.maxVelocity) {
        vel.scale(PHYSICS.maxVelocity / speed, vel);
      }
    }
  }
}
