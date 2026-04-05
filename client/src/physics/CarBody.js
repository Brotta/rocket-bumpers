import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { CARS, STAT_MAP, COLLISION_GROUPS, CAR_FEEL } from '../core/Config.js';

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

    // Identity & scoring (set externally by Game)
    this.playerId = null;
    this.nickname = '';
    this.score = 0;

    // KO attribution — updated by CollisionHandler & AbilitySystem
    this.lastHitBy = null; // { source: CarBody, wasAbility: bool, time: number }

    // Status flags (set by powerup / ability systems)
    this.hasShield = false;
    this.isInvincible = false;  // respawn invincibility
    this.hasRam = false;        // RAM ability active

    // Fall guard — prevents multiple _handleFall calls for the same fall
    this._isFalling = false;

    // Generation counter — increments on death/respawn.
    // Pending setTimeout effects check this to avoid corrupting state.
    this._generation = 0;

    // ── Driving dynamics state (for visual roll/pitch, set by applyControls) ──
    this._steerInput = 0;    // -1 / 0 / +1 current frame
    this._accelInput = 0;    // -1 / 0 / +1 current frame
    this._currentRoll = 0;   // smoothed visual roll angle (rad)
    this._currentPitch = 0;  // smoothed visual pitch angle (rad)

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
    this.hasRam = false;
    this.lastHitBy = null;
    this._steerAngle = 0;
    this._steerInput = 0;
    this._accelInput = 0;
    this._currentRoll = 0;
    this._currentPitch = 0;
  }

  // ── Controls (Rear-Axle Bicycle Model) ──────────────────────────────
  // The car pivots around its rear axle. Front wheels steer, rear drives.
  // This makes the front "sweep" around turns — like a real car.
  applyControls(input, dt) {
    // Wake sleeping body so velocity changes take effect (allowSleep optimization)
    if (this.body.sleepState !== 0) this.body.wakeUp();

    const effectiveMax = this.maxSpeed * this.speedMultiplier;
    const absSpeed = Math.abs(this._currentSpeed);
    const speedRatio = Math.min(absSpeed / Math.max(effectiveMax, 1), 1);

    // ── 1. Front-wheel steering angle ──
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    this._steerInput = steerInput;

    // Handling factor: normalised so that mid-handling (3.5) → 1.0
    // Low handling → smaller steer angle, slower steer, less grip, more slide
    // High handling → wider steer angle, faster steer, more grip, less slide
    const hf = this.handling / 3.5;

    let maxAngle = CAR_FEEL.maxSteerAngle * hf;

    if (this.driftMode) {
      maxAngle *= 1.5;
    } else {
      // Reduce steer angle at high speed — worse handling = more reduction
      const highSpeedFactor = CAR_FEEL.highSpeedSteerFactor + (1 - CAR_FEEL.highSpeedSteerFactor) * (hf - 0.5);
      const highSpeedLerp = 1 - (1 - highSpeedFactor) * speedRatio;
      maxAngle *= highSpeedLerp;
    }

    const targetSteer = steerInput * maxAngle;

    // Smoothly blend steering — high handling = snappier response
    const effectiveSteerSpeed = CAR_FEEL.steerSpeed * (0.6 + 0.4 * hf);
    if (steerInput !== 0) {
      this._steerAngle += (targetSteer - this._steerAngle) * Math.min(1, effectiveSteerSpeed * dt);
    } else {
      const effectiveReturnSpeed = CAR_FEEL.steerReturnSpeed * (0.6 + 0.4 * hf);
      this._steerAngle += (0 - this._steerAngle) * Math.min(1, effectiveReturnSpeed * dt);
    }

    // ── 2. Rear-axle bicycle model ──
    // Compute rear axle position, advance it, compute new heading from axle positions
    if (absSpeed > CAR_FEEL.minTurnSpeed) {
      // Angular velocity from bicycle model, hard-capped for sanity
      let angularVel = this._currentSpeed * Math.tan(this._steerAngle) / CAR_FEEL.wheelbase;
      const maxAV = CAR_FEEL.maxAngularVel;
      if (angularVel > maxAV) angularVel = maxAV;
      if (angularVel < -maxAV) angularVel = -maxAV;

      // Pivot offset: positive = rear pivot (nose sweeps), negative = front pivot (tail swings)
      const fwdX = -Math.sin(this._yaw);
      const fwdZ = -Math.cos(this._yaw);
      const pivotOff = this.driftMode ? CAR_FEEL.driftPivotOffset : CAR_FEEL.rearAxleOffset;
      const pivotX = this.body.position.x - fwdX * pivotOff;
      const pivotZ = this.body.position.z - fwdZ * pivotOff;

      // Update heading
      this._yaw += angularVel * dt;

      // Compute new forward after rotation
      const newFwdX = -Math.sin(this._yaw);
      const newFwdZ = -Math.cos(this._yaw);

      // Move body so that the pivot point stays planted
      this.body.position.x = pivotX + newFwdX * pivotOff;
      this.body.position.z = pivotZ + newFwdZ * pivotOff;
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
        // Moving forward + backward = brake
        this._currentSpeed -= CAR_FEEL.brakeDecel * dt;
        if (this._currentSpeed < 0) this._currentSpeed = 0;
      } else {
        // Stopped or nearly stopped: engage reverse
        this._currentSpeed -= CAR_FEEL.reverseAccel * dt;
        const reverseMax = -effectiveMax * CAR_FEEL.reverseMaxFactor;
        if (this._currentSpeed < reverseMax) this._currentSpeed = reverseMax;
      }
      this._accelInput = -1;
    } else {
      // Coasting deceleration (reduced during drift to maintain speed)
      let coastRate = CAR_FEEL.coastDecel;
      if (this.driftMode) coastRate *= CAR_FEEL.driftCoastFactor;
      if (this._currentSpeed > 0) {
        this._currentSpeed -= coastRate * dt;
        if (this._currentSpeed < 0) this._currentSpeed = 0;
      } else if (this._currentSpeed < 0) {
        this._currentSpeed += coastRate * dt;
        if (this._currentSpeed > 0) this._currentSpeed = 0;
      }
      this._accelInput = 0;
    }

    // ── 3b. Turn speed reduction — low handling loses more speed in turns ──
    if (!this.driftMode && maxAngle > 0) {
      const steerRatio = Math.abs(this._steerAngle) / maxAngle;
      const handlingReductionScale = 1.3 - 0.3 * hf; // low handling = more speed loss
      const reduction = CAR_FEEL.turnSpeedReduction * handlingReductionScale
        * Math.pow(steerRatio, CAR_FEEL.turnReductionPower)
        * speedRatio;
      this._currentSpeed *= (1 - reduction * dt * 3);
    }

    // ── 4. Apply velocity ──
    const fwdX = -Math.sin(this._yaw);
    const fwdZ = -Math.cos(this._yaw);
    const targetVx = fwdX * this._currentSpeed;
    const targetVz = fwdZ * this._currentSpeed;

    if (this.driftMode) {
      // Drift: moderate blend toward facing (tail slides out but car responds to steering)
      const blend = Math.min(1, CAR_FEEL.driftBlend * dt);
      this.body.velocity.x += (targetVx - this.body.velocity.x) * blend;
      this.body.velocity.z += (targetVz - this.body.velocity.z) * blend;
    } else {
      // Normal: lateral grip scaled by handling + steer intensity
      // High handling = more grip, less slide. Low handling = boat-like.
      const steerFrac = maxAngle > 0 ? Math.abs(this._steerAngle) / maxAngle : 0;
      const baseGrip = CAR_FEEL.lateralGrip * (0.7 + 0.3 * hf);     // handling scales base grip
      const slideAmount = CAR_FEEL.turnSlideAmount * (1.4 - 0.4 * hf); // low handling = more slide
      const slideBoost = steerFrac * steerFrac * slideAmount;
      const effectiveGrip = Math.max(0.15, baseGrip - slideBoost);
      const grip = 1 - Math.pow(1 - effectiveGrip, dt * 60);
      this.body.velocity.x += (targetVx - this.body.velocity.x) * grip;
      this.body.velocity.z += (targetVz - this.body.velocity.z) * grip;
    }

    // ── 5. Apply rotation ──
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
  syncMesh() {
    this.mesh.position.copy(this.body.position);
    // Sink mesh to match visible ground plane at Y≈0 (physics body is at Y=0.6)
    this.mesh.position.y -= 0.55;
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
  setPosition(x, y, z) {
    this.body.position.set(x, y, z);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this._currentSpeed = 0;
    this._steerAngle = 0;
    this._yaw = 0;
  }
}
