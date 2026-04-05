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

  // ── Controls (Drift-style kinematic model) ──────────────────────────
  // Heading rotates proportionally to speed. Velocity blends toward facing
  // direction via lateral friction — creates natural, smooth drifting.
  applyControls(input, dt) {
    // Wake sleeping body so velocity changes take effect (allowSleep optimization)
    if (this.body.sleepState !== 0) this.body.wakeUp();

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

    // ── 5. Apply velocity via lateral friction blending ──
    // Forward component follows _currentSpeed directly.
    // Lateral component blends via lateralFriction — this creates drift.
    const fwdX = -Math.sin(this._yaw);
    const fwdZ = -Math.cos(this._yaw);

    // Decompose current body velocity into forward and lateral components
    const vx = this.body.velocity.x;
    const vz = this.body.velocity.z;
    const fwdDot = vx * fwdX + vz * fwdZ;          // forward speed from physics
    const latX = vx - fwdDot * fwdX;                // lateral velocity
    const latZ = vz - fwdDot * fwdZ;

    // Lateral friction: determines how much lateral velocity persists.
    // Lower value = more slide (drift). Higher = more grip.
    const isSteering = Math.abs(this._steerAngle) > 0.001;
    let lf;

    if (!isSteering) {
      // Not steering: zero out lateral velocity completely.
      // CANNON.js contact resolution injects small lateral forces every step;
      // any non-zero retention creates a persistent diagonal drift.
      lf = 0;
    } else if (this.driftMode) {
      lf = Math.pow(CAR_FEEL.driftLateralFriction, dt * 60);
    } else {
      // Handling stat adjusts grip: hf=1 → base, hf<1 → more slide, hf>1 → more grip
      let latFric = CAR_FEEL.lateralFriction + (hf - 1) * 0.06;
      latFric = Math.max(0.70, Math.min(0.96, latFric));
      lf = Math.pow(latFric, dt * 60);
    }

    // Forward = driven by _currentSpeed, lateral = decays via friction
    this.body.velocity.x = fwdX * this._currentSpeed + latX * lf;
    this.body.velocity.z = fwdZ * this._currentSpeed + latZ * lf;

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
