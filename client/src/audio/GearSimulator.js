/**
 * GearSimulator — fake gear simulation that produces RPM and throttle
 * values purely from game state, without affecting gameplay at all.
 *
 * Input:  carBody._currentSpeed, carBody.maxSpeed, carBody.speedMultiplier, carBody._accelInput
 * Output: rpm (number), throttle (0-1)
 *
 * The RPM follows a realistic "sawtooth" pattern: it climbs within each gear,
 * drops on upshift, then climbs again. This creates the characteristic engine
 * sound of a real car accelerating through gears.
 *
 * All smoothing uses delta-time, never frame-count, making it safe for
 * variable frame rates and future multiplayer synchronization.
 */

import { GEAR_DEFAULTS } from './AudioConfig.js';

export class GearSimulator {
  /**
   * @param {object} profile - Car engine profile from CAR_ENGINE_PROFILES
   */
  constructor(profile) {
    this._gears = profile.gears;
    this._idleRPM = profile.idleRPM;
    this._redlineRPM = profile.redlineRPM;

    // ── Mutable state ──
    this._currentGear = 0;            // index into _gears array
    this._smoothedRPM = this._idleRPM;
    this._targetRPM = this._idleRPM;
    this._smoothedThrottle = 0;

    // Shift animation state
    this._shiftTimer = 0;             // >0 = currently shifting
    this._shiftFromRPM = 0;           // RPM at moment of shift
    this._shiftTargetRPM = 0;         // RPM target after shift

    // Previous speed fraction (for hysteresis)
    this._prevSpeedFrac = 0;
  }

  /**
   * Current output RPM (smoothed).
   * @returns {number}
   */
  get rpm() {
    return this._smoothedRPM;
  }

  /**
   * Current output throttle (0-1, smoothed).
   * @returns {number}
   */
  get throttle() {
    return this._smoothedThrottle;
  }

  /** Current virtual gear (1-indexed for display). */
  get gear() {
    return this._currentGear + 1;
  }

  /**
   * Update the simulator. Call once per frame.
   *
   * @param {object} carBody - CarBody instance
   * @param {number} dt - Frame delta time (seconds)
   */
  update(carBody, dt) {
    if (dt <= 0) return;

    const effectiveMax = Math.max(carBody.maxSpeed * carBody.speedMultiplier, 1);
    const absSpeed = Math.abs(carBody._currentSpeed);
    const speedFrac = Math.min(absSpeed / effectiveMax, 1);

    // ── 1. Determine virtual gear ──
    this._updateGear(speedFrac, dt);

    // ── 2. Calculate target RPM within current gear ──
    if (this._shiftTimer > 0) {
      // During shift: RPM drops toward shift target
      this._shiftTimer -= dt;
      const shiftProgress = 1 - Math.max(0, this._shiftTimer / GEAR_DEFAULTS.shiftDuration);
      // Ease-out curve for natural RPM drop
      const eased = 1 - Math.pow(1 - shiftProgress, 2);
      this._targetRPM = this._shiftFromRPM + (this._shiftTargetRPM - this._shiftFromRPM) * eased;
    } else {
      // Normal: map speed within current gear range to idle→redline
      this._targetRPM = this._speedToRPM(speedFrac);
    }

    // ── 3. Smooth RPM (different rates for rise vs fall) ──
    const rpmDiff = this._targetRPM - this._smoothedRPM;
    const rpmSmoothing = rpmDiff > 0
      ? GEAR_DEFAULTS.rpmSmoothingUp
      : GEAR_DEFAULTS.rpmSmoothingDown;
    this._smoothedRPM += rpmDiff * Math.min(1, rpmSmoothing * dt);

    // Clamp to valid range
    this._smoothedRPM = Math.max(this._idleRPM, Math.min(this._redlineRPM, this._smoothedRPM));

    // ── 4. Derive throttle from input ──
    const accelInput = carBody._accelInput; // -1, 0, or 1
    let targetThrottle;
    if (accelInput === 1) {
      // Accelerating: full throttle
      targetThrottle = 1.0;
    } else if (accelInput === -1) {
      // Braking: engine braking sound (low throttle)
      targetThrottle = 0.0;
    } else {
      // Coasting: let off gas
      targetThrottle = 0.0;
    }

    // Smooth throttle transitions
    const throttleDiff = targetThrottle - this._smoothedThrottle;
    const throttleSmoothing = throttleDiff > 0
      ? GEAR_DEFAULTS.throttleSmoothingUp
      : GEAR_DEFAULTS.throttleSmoothingDown;
    this._smoothedThrottle += throttleDiff * Math.min(1, throttleSmoothing * dt);
    this._smoothedThrottle = Math.max(0, Math.min(1, this._smoothedThrottle));

    this._prevSpeedFrac = speedFrac;
  }

  /**
   * Determine and update the current virtual gear based on speed fraction.
   * Includes hysteresis to prevent rapid gear hunting at boundaries.
   */
  _updateGear(speedFrac, dt) {
    // Skip gear logic during a shift
    if (this._shiftTimer > 0) return;

    const gears = this._gears;
    const hysteresis = GEAR_DEFAULTS.downshiftHysteresis;

    // Find the gear that contains the current speed fraction
    let newGear = this._currentGear;

    // Check upshift: are we above the current gear's top?
    if (this._currentGear < gears.length - 1) {
      const currentTop = gears[this._currentGear].maxSpeedFrac;
      if (speedFrac >= currentTop) {
        newGear = this._currentGear + 1;
      }
    }

    // Check downshift: are we below the previous gear's range (with hysteresis)?
    if (this._currentGear > 0) {
      const prevTop = gears[this._currentGear - 1].maxSpeedFrac;
      if (speedFrac < prevTop - hysteresis) {
        newGear = this._currentGear - 1;
      }
    }

    // Handle very low speed: snap to 1st gear
    if (speedFrac < 0.02) {
      newGear = 0;
    }

    if (newGear !== this._currentGear) {
      const isUpshift = newGear > this._currentGear;
      this._currentGear = newGear;

      if (isUpshift) {
        // Upshift: RPM drops then climbs in new gear
        this._shiftFromRPM = this._smoothedRPM;
        this._shiftTargetRPM = this._redlineRPM * GEAR_DEFAULTS.shiftDropFrac;
        this._shiftTimer = GEAR_DEFAULTS.shiftDuration;
      }
      // Downshift: no animation (RPM naturally rises as gear range narrows)
    }
  }

  /**
   * Map a speed fraction to RPM within the current gear's range.
   * @param {number} speedFrac - 0-1 fraction of max speed
   * @returns {number} RPM value
   */
  _speedToRPM(speedFrac) {
    const gears = this._gears;
    const gear = this._currentGear;

    // Bottom of this gear's speed range
    const gearMin = gear > 0 ? gears[gear - 1].maxSpeedFrac : 0;
    // Top of this gear's speed range
    const gearMax = gears[gear].maxSpeedFrac;

    // Where are we within this gear's range? (0 = bottom, 1 = top)
    const gearRange = gearMax - gearMin;
    const rpmFrac = gearRange > 0
      ? Math.max(0, Math.min(1, (speedFrac - gearMin) / gearRange))
      : 0;

    // Map to RPM range
    return this._idleRPM + rpmFrac * (this._redlineRPM - this._idleRPM);
  }

  /**
   * Reset to idle state (e.g., on respawn).
   */
  reset() {
    this._currentGear = 0;
    this._smoothedRPM = this._idleRPM;
    this._targetRPM = this._idleRPM;
    this._smoothedThrottle = 0;
    this._shiftTimer = 0;
    this._prevSpeedFrac = 0;
  }
}
