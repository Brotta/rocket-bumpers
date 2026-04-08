import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { CARS, STAT_MAP, COLLISION_GROUPS, CAR_FEEL, OBSTACLE_STUN, DAMAGE } from '../core/Config.js';

// Reusable helpers for contact shadow rotation (avoid per-frame allocations)
const _csQuatHelper = new THREE.Quaternion();
const _csAxisX = new THREE.Vector3(1, 0, 0);
const _csInvQuat = new THREE.Quaternion();

// Reusable helpers for visual tilt (avoid per-frame allocations)
const _tiltNormal = new THREE.Vector3();
const _tiltTempVec = new THREE.Vector3();
const _tiltCorrectedFwd = new THREE.Vector3();
const _tiltFallbackEuler = new THREE.Euler();

export class CarBody {
  constructor(carType, mesh, world, opts = {}) {
    const carDef = CARS[carType];
    if (!carDef) throw new Error(`Unknown car type: ${carType}`);

    this.carType = carType;
    this.mesh = mesh;
    this.world = world;

    // Resolve stats (scaled from STAT_BASE — change base to retune all cars)
    this.maxSpeed = STAT_MAP.speed[carDef.stats.speed];
    this.accelRate = STAT_MAP.accel[carDef.stats.speed]; // accel scales with speed stat
    this.mass = STAT_MAP.mass[carDef.stats.mass];
    this.handling = STAT_MAP.handling[carDef.stats.handling];

    // Physics body — box approximation (2 × 1.2 × 1.2)
    const halfExtents = new CANNON.Vec3(1.0, 0.6, 0.6);
    this.body = new CANNON.Body({
      mass: this.mass,
      shape: new CANNON.Box(halfExtents),
      position: new CANNON.Vec3(0, 0.6, 0),
      material: opts.carMaterial || null,
      linearDamping: 0.0,
      angularDamping: 1.0,   // we control rotation manually
      fixedRotation: true,
      collisionFilterGroup: COLLISION_GROUPS.CAR,
      collisionFilterMask:
        COLLISION_GROUPS.ARENA |
        COLLISION_GROUPS.CAR |
        COLLISION_GROUPS.PICKUP |
        COLLISION_GROUPS.TRAIL,
    });

    world.addBody(this.body);

    // Steering angle tracked manually
    this._yaw = 0;
    this._currentSpeed = 0; // signed: positive = forward
    this._steerAngle = 0;   // current front-wheel angle (rad), bicycle model

    // Ability-driven modifiers (set by AbilitySystem)
    this.speedMultiplier = 1;   // NITRO / TRAIL set this
    this.driftMode = false;     // DRIFT sets this
    this._originalMass = this.mass;

    // Identity (set externally by Game)
    this.playerId = null;
    this.nickname = '';

    // HP system
    this.hp = DAMAGE.MAX_HP;
    this.maxHp = DAMAGE.MAX_HP;
    this.isEliminated = false;
    this._eliminationEmitted = false;

    /** @type {((info: {victim:CarBody, killer:CarBody|null, wasAbility:boolean}) => void)|null} */
    this.onEliminated = null;

    // KO attribution — updated by CollisionHandler & AbilitySystem
    this.lastHitBy = null; // { source: CarBody, wasAbility: bool, time: number }

    // Status flags (set by powerup / ability systems)
    this.hasShield = false;
    this._shieldDamageReduction = 0; // 0..1 fraction of damage absorbed
    this.isInvincible = false;  // respawn invincibility
    this.hasRam = false;        // RAM ability active
    this.holoEvadeActive = false; // HoloEvade decoys are live
    this._holoOriginalMaterials = null; // cached originals for opacity restore

    // Fall guard — prevents multiple _handleFall calls for the same fall
    this._isFalling = false;

    // ── Geyser airborne state ──
    this._geyserAirborne = false;
    this._geyserAirborneTime = 0;
    this._geyserSpinRate = 0; // rad/s random yaw spin while airborne

    // ── Obstacle stun state ──
    this._isStunned = false;
    this._stunTimer = 0;
    this._stunSpinRate = 0;    // rad/s — random direction spin while stunned
    this._stunImmunityTimer = 0; // prevents chain-stuns

    // Generation counter — increments on death/respawn.
    // Pending setTimeout effects check this to avoid corrupting state.
    this._generation = 0;

    // ── Internal velocity tracking (avoids CANNON substep jitter) ──
    this._internalVelX = 0;
    this._internalVelZ = 0;
    this._lastSetVelX = 0;
    this._lastSetVelZ = 0;
    // Smooth visual position (predicted from velocity, corrected toward physics)
    this._smoothPosX = 0;
    this._smoothPosZ = 0;
    this._smoothPosInited = false;

    // ── Driving dynamics state (for visual roll/pitch, set by applyControls) ──
    this._steerInput = 0;    // -1 / 0 / +1 current frame
    this._accelInput = 0;    // -1 / 0 / +1 current frame
    this._currentRoll = 0;   // smoothed visual roll angle (rad)
    this._currentPitch = 0;  // smoothed visual pitch angle (rad)

    // ── Previous-frame state for render interpolation ──
    this._prevPosX = 0;
    this._prevPosY = 0;
    this._prevPosZ = 0;
    this._prevYaw = 0;

    // ── Visual tilt system (mesh tilts on slopes, physics body stays upright) ──
    this._tiltRaycaster = new THREE.Raycaster();
    this._tiltRaycaster.far = 5;
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._visualQuat = new THREE.Quaternion();
    this._arenaGroup = null; // set by Game.js — THREE.Group of driveable surfaces
    this._tiltFloorMesh = null; // set by Game.js — direct ref to floor mesh (skip group traversal)
    // Throttle raycast to 30Hz (tilt lerps slowly, no visual difference)
    this._tiltFrameSkip = 0;
    // Cache last raycast position to skip if car hasn't moved significantly
    this._tiltLastX = 0;
    this._tiltLastZ = 0;
    // Reusable objects for tilt calculation
    this._tiltOrigin = new THREE.Vector3();
    this._tiltDown = new THREE.Vector3(0, -1, 0);
    this._tiltUpRef = new THREE.Vector3(0, 1, 0); // pure up — used to filter flat surface noise
    this._tiltForward = new THREE.Vector3();
    this._tiltRight = new THREE.Vector3();
    this._tiltUp = new THREE.Vector3();
    this._tiltMatrix = new THREE.Matrix4();
    this._tiltTargetQuat = new THREE.Quaternion();
    this._rollPitchQuat = new THREE.Quaternion();
    this._rollPitchEuler = new THREE.Euler();
  }

  /**
   * Hard-reset mutable state to factory defaults.
   * Call on respawn / round reset to clear any lingering power-up / ability effects.
   * Pending setTimeouts become stale (they check _generation).
   */
  resetState() {
    this._generation++;
    this._isFalling = false;
    this.body.mass = this._originalMass;
    this.body.updateMassProperties();
    this.speedMultiplier = 1;
    this.driftMode = false;
    this.hasShield = false;
    this._shieldDamageReduction = 0;
    this.hasRam = false;
    this.holoEvadeActive = false;
    this._restoreCarOpacity();
    this.lastHitBy = null;
    this._isStunned = false;
    this._stunTimer = 0;
    this._stunSpinRate = 0;
    this._stunImmunityTimer = 0;
    this._geyserAirborne = false;
    this._geyserAirborneTime = 0;
    this._geyserSpinRate = 0;
    this._internalVelX = 0;
    this._internalVelZ = 0;
    this._lastSetVelX = 0;
    this._lastSetVelZ = 0;
    this._steerAngle = 0;
    this._steerInput = 0;
    this._accelInput = 0;
    this._currentRoll = 0;
    this._currentPitch = 0;
  }

  /** Reset HP for a new round. */
  resetHP() {
    this.hp = this.maxHp;
    this.isEliminated = false;
    this._eliminationEmitted = false;
  }

  /**
   * Apply damage to this car. Returns actual damage dealt.
   * @param {number} amount — raw damage
   * @param {CarBody|null} source — who dealt it (for kill attribution)
   * @param {boolean} wasAbility — ability-sourced damage
   * @returns {number} actual damage applied
   */
  takeDamage(amount, source = null, wasAbility = false) {
    if (this.isEliminated || this.isInvincible) return 0;
    // Shield halves incoming damage
    if (this.hasShield && this._shieldDamageReduction > 0) {
      amount *= (1 - this._shieldDamageReduction);
    }
    const actual = Math.min(amount, this.hp);
    this.hp -= actual;
    if (source) {
      this.lastHitBy = { source, wasAbility, time: performance.now() };
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.isEliminated = true;

      // Emit elimination exactly once — works for ALL damage sources
      if (!this._eliminationEmitted) {
        this._eliminationEmitted = true;
        const killer = source || (this.lastHitBy ? this.lastHitBy.source : null);
        const killerAbility = wasAbility || (this.lastHitBy ? this.lastHitBy.wasAbility : false);
        if (this.onEliminated) {
          this.onEliminated({ victim: this, killer, wasAbility: killerAbility });
        }
      }
    }
    return actual;
  }

  // ── HoloEvade opacity helpers ──────────────────────────────────────

  /** Make car semi-transparent + cyan-tinted (called by PowerUpManager when HoloEvade activates). */
  setCarOpacity(opacity) {
    if (!this._holoOriginalMaterials) {
      this._holoOriginalMaterials = [];
      this.mesh.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) {
            this._holoOriginalMaterials.push({
              mat,
              transparent: mat.transparent,
              opacity: mat.opacity,
              depthWrite: mat.depthWrite,
              emissiveHex: mat.emissive ? mat.emissive.getHex() : null,
              emissiveIntensity: mat.emissiveIntensity ?? 0,
            });
          }
        }
      });
    }
    for (const entry of this._holoOriginalMaterials) {
      entry.mat.transparent = true;
      entry.mat.opacity = opacity;
      entry.mat.depthWrite = opacity > 0.9;
      // Cyan tint to match decoys — stronger at low opacity (active), fades as opacity restores
      if (entry.mat.emissive) {
        const tint = Math.max(0, 1 - opacity); // 1.0 at opacity=0, 0 at opacity=1
        entry.mat.emissive.setHex(0x00ccff);
        entry.mat.emissiveIntensity = 0.4 * tint;
      }
      entry.mat.needsUpdate = true;
    }
  }

  /** Restore car to full opacity and original emissive. */
  _restoreCarOpacity() {
    if (!this._holoOriginalMaterials) return;
    for (const entry of this._holoOriginalMaterials) {
      entry.mat.transparent = entry.transparent;
      entry.mat.opacity = entry.opacity;
      entry.mat.depthWrite = entry.depthWrite;
      if (entry.mat.emissive && entry.emissiveHex !== null) {
        entry.mat.emissive.setHex(entry.emissiveHex);
        entry.mat.emissiveIntensity = entry.emissiveIntensity;
      }
      entry.mat.needsUpdate = true;
    }
    this._holoOriginalMaterials = null;
  }

  // ── Controls (Drift-style kinematic model) ──────────────────────────
  // Heading rotates proportionally to speed. Velocity blends toward facing
  // direction via lateral friction — creates natural, smooth drifting.
  applyControls(input, dt) {
    // Wake sleeping body so velocity changes take effect (allowSleep optimization)
    if (this.body.sleepState !== 0) this.body.wakeUp();

    // ── Stun immunity cooldown ──
    if (this._stunImmunityTimer > 0) {
      this._stunImmunityTimer -= dt;
    }

    // ── Obstacle stun: no input, spin in place, decay timer ──
    if (this._isStunned) {
      this._stunTimer -= dt;
      if (this._stunTimer <= 0) {
        this._isStunned = false;
        this._stunImmunityTimer = OBSTACLE_STUN.immunityDuration;
      } else {
        // Spin the car (dizzy effect)
        this._yaw += this._stunSpinRate * dt;
        this.body.quaternion.setFromEuler(0, this._yaw, 0);
        // Bleed off remaining velocity
        this.body.velocity.x *= 0.95;
        this.body.velocity.z *= 0.95;
        this._internalVelX *= 0.95;
        this._internalVelZ *= 0.95;
        this._currentSpeed *= 0.95;
        this._lastSetVelX = this.body.velocity.x;
        this._lastSetVelZ = this.body.velocity.z;
        return; // skip all driving controls
      }
    }

    // ── Geyser airborne: no traction, ballistic trajectory only ──
    if (this._geyserAirborne) {
      this._geyserAirborneTime += dt;

      // Detect landing: car is near ground, falling, and has been airborne a bit
      if (this.body.position.y < 1.0 && this.body.velocity.y <= 0 && this._geyserAirborneTime > 0.3) {
        this._geyserAirborne = false;
        // Align yaw to travel direction for smooth landing
        const vx = this.body.velocity.x;
        const vz = this.body.velocity.z;
        const hSpeed = Math.sqrt(vx * vx + vz * vz);
        if (hSpeed > 1) {
          this._yaw = Math.atan2(-vx, -vz);
        }
        this._currentSpeed = hSpeed;
      } else {
        // Spin: full rate for first 0.8s, then ease out
        const spinEase = this._geyserAirborneTime < 0.8 ? 1.0
          : Math.max(0, 1.0 - (this._geyserAirborneTime - 0.8) * 1.5);
        this._yaw += this._geyserSpinRate * spinEase * dt;
        this.body.quaternion.setFromEuler(0, this._yaw, 0);
        return; // skip all driving controls — wheels don't touch ground
      }
    }

    const effectiveMax = this.maxSpeed * this.speedMultiplier;
    const absSpeed = Math.abs(this._currentSpeed);
    const speedRatio = Math.min(absSpeed / Math.max(effectiveMax, 1), 1);

    // Handling factor: normalised so that mid-handling (3.5) → 1.0
    const hf = this.handling / 3.5;

    // ── 1. Steering ──
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    this._steerInput = steerInput;

    // Steer angle scales with handling; reduces at high speed (understeer)
    let maxSteer = CAR_FEEL.maxSteerAngle * hf;
    if (this.driftMode) {
      maxSteer *= CAR_FEEL.driftSteerMultiplier;
    } else {
      // Understeer: reduce steer at high speed — worse handling = more reduction
      const steerAtSpeed = CAR_FEEL.steerAtSpeed * (0.7 + 0.3 * hf);
      const spf = 1 - speedRatio * steerAtSpeed;
      maxSteer *= spf;
    }

    // Smooth steer interpolation (frame-rate independent via dt*60)
    const targetSteer = steerInput * maxSteer;
    const steerBlend = Math.min(1.0,
      (steerInput !== 0 ? CAR_FEEL.steerSpeed : CAR_FEEL.steerReturnSpeed) * dt * 60
    );
    this._steerAngle += (targetSteer - this._steerAngle) * steerBlend;

    // ── 2. Heading rotation (proportional to speed) ──
    // Negate in reverse so left=left regardless of direction.
    if (absSpeed > CAR_FEEL.minTurnSpeed) {
      const reverseSign = this._currentSpeed >= 0 ? 1 : -1;
      this._yaw += this._steerAngle * (absSpeed / effectiveMax) * reverseSign * dt * 60;
    }

    // ── 3. Acceleration / Braking ──
    if (input.forward) {
      if (this._currentSpeed < 0) {
        // Pressing forward while going backward = brake first
        this._currentSpeed += CAR_FEEL.brakeDecel * dt;
        if (this._currentSpeed > 0) this._currentSpeed = 0;
      } else {
        let accel = this.accelRate;
        if (speedRatio > CAR_FEEL.accelFalloffStart) {
          const t = (speedRatio - CAR_FEEL.accelFalloffStart) / (1 - CAR_FEEL.accelFalloffStart);
          accel *= CAR_FEEL.accelFalloffMin + (1 - CAR_FEEL.accelFalloffMin) * (1 - t);
        }
        this._currentSpeed += accel * dt;
        if (this._currentSpeed > effectiveMax) this._currentSpeed = effectiveMax;
      }
      this._accelInput = 1;
    } else if (input.backward) {
      if (this._currentSpeed > CAR_FEEL.minTurnSpeed) {
        this._currentSpeed -= CAR_FEEL.brakeDecel * dt;
        if (this._currentSpeed < 0) this._currentSpeed = 0;
      } else {
        this._currentSpeed -= CAR_FEEL.reverseAccel * dt;
        const reverseMax = -effectiveMax * CAR_FEEL.reverseMaxFactor;
        if (this._currentSpeed < reverseMax) this._currentSpeed = reverseMax;
      }
      this._accelInput = -1;
    } else {
      this._accelInput = 0;
    }

    // ── 4. Multiplicative friction (replaces linear coast decel) ──
    // Drag when accelerating/braking, ground friction when coasting — like Drift Zero
    let frictionFactor;
    if (input.forward || input.backward) {
      frictionFactor = this.driftMode ? CAR_FEEL.driftDragOverride : CAR_FEEL.drag;
    } else {
      frictionFactor = this.driftMode ? CAR_FEEL.driftDragOverride : CAR_FEEL.groundFriction;
    }
    this._currentSpeed *= Math.pow(frictionFactor, dt * 60);
    if (Math.abs(this._currentSpeed) < 0.05) this._currentSpeed = 0;

    // ── 5. Apply velocity — Drift Zero model with internal tracking ──
    // Velocity is tracked internally to avoid CANNON substep noise.
    // Only real collision impulses (large deltas) are absorbed.
    const fwdX = -Math.sin(this._yaw);
    const fwdZ = -Math.cos(this._yaw);

    // Desired velocity = heading × speed
    const desiredVx = fwdX * this._currentSpeed;
    const desiredVz = fwdZ * this._currentSpeed;

    // Lateral friction: blend internal velocity toward desired.
    // This is the pure Drift Zero model: vel = vel * lf + desired * (1 - lf)
    let latFric;
    if (this.driftMode) {
      latFric = CAR_FEEL.driftLateralFriction;
    } else {
      latFric = CAR_FEEL.lateralFriction + (hf - 1) * 0.06;
      latFric = Math.max(0.70, Math.min(0.96, latFric));
    }

    const lf = Math.pow(latFric, dt * 60);
    this._internalVelX = this._internalVelX * lf + desiredVx * (1 - lf);
    this._internalVelZ = this._internalVelZ * lf + desiredVz * (1 - lf);

    // Absorb real collision impulses from CANNON (ignore ground contact noise)
    const cannonDx = this.body.velocity.x - this._lastSetVelX;
    const cannonDz = this.body.velocity.z - this._lastSetVelZ;
    const impulseSq = cannonDx * cannonDx + cannonDz * cannonDz;
    if (impulseSq > 1.0) { // threshold: 1 u/s²
      this._internalVelX += cannonDx;
      this._internalVelZ += cannonDz;
    }

    // Write to CANNON body
    this.body.velocity.x = this._internalVelX;
    this.body.velocity.z = this._internalVelZ;
    this._lastSetVelX = this._internalVelX;
    this._lastSetVelZ = this._internalVelZ;

    // ── 6. Apply rotation ──
    this.body.quaternion.setFromEuler(0, this._yaw, 0);

    // Velocity cap handled by CollisionHandler._postStep after physics step
  }

  // ── Visual tilt — raycast to find ground normal, tilt mesh only ─────
  _updateVisualTilt() {
    if (!this._arenaGroup) {
      // No arena group set — fall back to physics quaternion
      this._visualQuat.set(0, 0, 0, 1);
      _tiltFallbackEuler.set(0, this._yaw, 0);
      this._visualQuat.setFromEuler(_tiltFallbackEuler);
      return;
    }

    // Throttle raycast to 30Hz — tilt lerps at 0.08 so skipping frames is imperceptible
    if (++this._tiltFrameSkip >= 2) {
      this._tiltFrameSkip = 0;
      // Skip if car hasn't moved significantly since last raycast
      const dx = this.body.position.x - this._tiltLastX;
      const dz = this.body.position.z - this._tiltLastZ;
      if (dx * dx + dz * dz > 0.01) {
        this._tiltLastX = this.body.position.x;
        this._tiltLastZ = this.body.position.z;
        // Raycast downward from above the car
        this._tiltOrigin.set(this.body.position.x, this.body.position.y + 2, this.body.position.z);
        this._tiltRaycaster.set(this._tiltOrigin, this._tiltDown);
        // Use floor mesh directly if available (avoids traversing entire arenaGroup)
        const target = this._tiltFloorMesh || this._arenaGroup;
        const recursive = !this._tiltFloorMesh;
        const hits = this._tiltRaycaster.intersectObject(target, recursive);

        if (hits.length > 0) {
          _tiltNormal.copy(hits[0].face.normal);
          _tiltNormal.transformDirection(hits[0].object.matrixWorld);
          const upDot = _tiltNormal.dot(this._tiltUpRef);
          if (upDot < 0.998) {
            this._groundNormal.lerp(_tiltNormal, 0.08);
            this._groundNormal.normalize();
          } else {
            this._groundNormal.lerp(this._tiltUpRef, 0.1);
            this._groundNormal.normalize();
          }
        }
      }
    }

    // Build quaternion from yaw + ground normal
    this._tiltUp.copy(this._groundNormal);
    this._tiltForward.set(-Math.sin(this._yaw), 0, -Math.cos(this._yaw));

    // Project forward onto ground plane (reuse _tiltTempVec instead of clone)
    const dot = this._tiltForward.dot(this._tiltUp);
    _tiltTempVec.copy(this._tiltUp).multiplyScalar(dot);
    this._tiltForward.sub(_tiltTempVec).normalize();
    this._tiltRight.crossVectors(this._tiltForward, this._tiltUp).normalize();
    _tiltCorrectedFwd.copy(this._tiltUp).cross(this._tiltRight).normalize().negate();

    this._tiltMatrix.makeBasis(this._tiltRight, this._tiltUp, _tiltCorrectedFwd);
    this._tiltTargetQuat.setFromRotationMatrix(this._tiltMatrix);

    // Smooth interpolation — slower slerp to absorb residual noise
    this._visualQuat.slerp(this._tiltTargetQuat, 0.08);

    // ── Visual body roll — applied to body parts only, wheels stay upright ──
    const speedRatio = Math.min(Math.abs(this._currentSpeed) / Math.max(this.maxSpeed, 1), 1);
    const rc = CAR_FEEL.roll;

    // Roll: steerInput × speed × inverse mass influence, clamped
    const massFactor = 1 / (1 + this._originalMass * rc.massDamping);
    const targetRoll = this._steerInput * speedRatio * massFactor * rc.maxAngle;
    this._currentRoll += (targetRoll - this._currentRoll) * Math.min(1, rc.smoothing * (1 / 60));

    // Apply roll to body parts only (not wheels) via local Z rotation
    const bodyParts = this.mesh.userData.bodyParts;
    if (bodyParts && bodyParts.length > 0 && Math.abs(this._currentRoll) > 0.0005) {
      for (const part of bodyParts) {
        part.rotation.z = this._currentRoll;
      }
    } else if (bodyParts) {
      for (const part of bodyParts) {
        part.rotation.z = 0;
      }
    }
  }

  // ── Sync physics body → Three.js mesh ──────────────────────────────
  syncMesh(dt, alpha) {
    // With fixed-timestep, interpolate between previous and current physics
    // state for smooth rendering at any display refresh rate.
    if (alpha !== undefined && alpha < 1) {
      const ix = this._prevPosX + (this.body.position.x - this._prevPosX) * alpha;
      const iy = this._prevPosY + (this.body.position.y - this._prevPosY) * alpha;
      const iz = this._prevPosZ + (this.body.position.z - this._prevPosZ) * alpha;

      this.mesh.position.x = ix;
      this.mesh.position.z = iz;
      this.mesh.position.y = iy - 0.55;

      // Also update smooth pos to stay in sync (for systems that read it)
      this._smoothPosX = ix;
      this._smoothPosZ = iz;
    } else {
      // Fallback: velocity-predicted smooth position (countdown, no alpha)
      if (!this._smoothPosInited) {
        this._smoothPosX = this.body.position.x;
        this._smoothPosZ = this.body.position.z;
        this._smoothPosInited = true;
      }

      const frameDt = dt || (1 / 60);
      this._smoothPosX += this._internalVelX * frameDt;
      this._smoothPosZ += this._internalVelZ * frameDt;
      const correctionRate = 0.15;
      this._smoothPosX += (this.body.position.x - this._smoothPosX) * correctionRate;
      this._smoothPosZ += (this.body.position.z - this._smoothPosZ) * correctionRate;

      this.mesh.position.x = this._smoothPosX;
      this.mesh.position.z = this._smoothPosZ;
      this.mesh.position.y = this.body.position.y - 0.55;
    }

    // Use visual quaternion (with tilt) instead of physics quaternion
    this.mesh.quaternion.copy(this._visualQuat);

    // Keep contact shadow pinned to ground plane
    const cs = this.mesh.userData.contactShadow;
    if (cs) {
      // Pin shadow to ground: undo car's Y offset (including the -0.55 sink)
      cs.position.y = 0.02 - this.body.position.y + 0.55;

      // Counter-rotate the shadow plane so it stays world-aligned (flat on ground)
      // The car group has _visualQuat applied — undo pitch/roll but keep yaw irrelevant
      // since the shadow is circular. We just need to cancel the X-axis tilt from the plane.
      // Shadow base rotation is -PI/2 on X. We undo the car quaternion's tilt component.
      _csInvQuat.copy(this._visualQuat).invert();
      cs.quaternion.copy(_csInvQuat);
      // Re-apply the flat-on-ground rotation
      const flatRot = _csQuatHelper.setFromAxisAngle(_csAxisX, -Math.PI / 2);
      cs.quaternion.multiply(flatRot);

      // Fade shadow when airborne
      const airHeight = Math.max(0, this.body.position.y - 0.8);
      cs.material.opacity = Math.max(0, 1.0 - airHeight * 0.4);
    }
  }

  // ── Setters ────────────────────────────────────────────────────────
  setPosition(x, y, z, yaw) {
    this.body.position.set(x, y, z);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this._currentSpeed = 0;
    this._steerAngle = 0;
    if (yaw !== undefined) this._yaw = yaw;
    this._internalVelX = 0;
    this._internalVelZ = 0;
    this._lastSetVelX = 0;
    this._lastSetVelZ = 0;
    this._smoothPosX = x;
    this._smoothPosZ = z;
    this._smoothPosInited = true;
    this._prevPosX = x;
    this._prevPosY = y;
    this._prevPosZ = z;
    this._prevYaw = this._yaw;

    // Sync mesh immediately so car is never visible at origin
    this.mesh.position.set(x, y - 0.55, z);
    this.body.quaternion.setFromEuler(0, this._yaw, 0);
    this.mesh.quaternion.copy(this.body.quaternion);
  }
}
