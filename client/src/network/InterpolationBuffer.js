/**
 * InterpolationBuffer — circular buffer of timestamped states for smooth
 * network interpolation of remote players.
 *
 * Uses Hermite interpolation with position + velocity for smooth curves.
 * Falls back to linear interpolation when velocity data is missing.
 */
export class InterpolationBuffer {
  /**
   * @param {number} [bufferSize=10] — max snapshots to keep
   * @param {number} [interpolationDelay=100] — ms behind "live" to render
   */
  constructor(bufferSize = 10, interpolationDelay = 100) {
    this._buffer = [];
    this._maxSize = bufferSize;
    this._baseDelay = interpolationDelay;
    this._delay = interpolationDelay;

    // Adaptive jitter tracking
    this._lastPushTime = 0;
    this._jitterSamples = [];
    this._maxJitterSamples = 30;
  }

  /**
   * Push a new state snapshot from the network.
   * @param {object} state — { posX, posY, posZ, velX, velY, velZ, yaw, speed, flags, hp }
   */
  push(state) {
    // Guard against NaN contamination — skip corrupted states
    if (isNaN(state.posX) || isNaN(state.posY) || isNaN(state.posZ) ||
        isNaN(state.velX) || isNaN(state.velY) || isNaN(state.velZ)) return;

    const now = performance.now();

    // Track inter-packet jitter to adapt interpolation delay
    if (this._lastPushTime > 0) {
      const gap = now - this._lastPushTime;
      this._jitterSamples.push(gap);
      if (this._jitterSamples.length > this._maxJitterSamples) {
        this._jitterSamples.shift();
      }
      this._updateAdaptiveDelay();
    }
    this._lastPushTime = now;

    const entry = {
      time: now,
      ...state,
    };
    this._buffer.push(entry);
    if (this._buffer.length > this._maxSize) {
      this._buffer.shift();
    }
  }

  /**
   * Sample the interpolated state at the current render time.
   * @returns {object|null} — interpolated state or null if no data
   */
  sample() {
    const len = this._buffer.length;
    if (len === 0) return null;
    if (len === 1) {
      // Single snapshot — extrapolate using velocity for smooth motion
      const s = this._buffer[0];
      const elapsed = (performance.now() - s.time) / 1000;
      if (elapsed > 0 && elapsed < 0.35) {
        return {
          posX: s.posX + s.velX * elapsed,
          posY: s.posY + s.velY * elapsed,
          posZ: s.posZ + s.velZ * elapsed,
          velX: s.velX, velY: s.velY, velZ: s.velZ,
          yaw: s.yaw, speed: s.speed, flags: s.flags, hp: s.hp,
        };
      }
      return s;
    }

    const renderTime = performance.now() - this._delay;

    // Find bracketing snapshots
    let i = 0;
    for (; i < len - 1; i++) {
      if (this._buffer[i + 1].time >= renderTime) break;
    }

    const a = this._buffer[i];
    const b = this._buffer[Math.min(i + 1, len - 1)];

    if (a === b) {
      // Only one unique snapshot — extrapolate using its velocity
      const elapsed = (renderTime - a.time) / 1000;
      if (elapsed > 0 && elapsed < 0.35) { // cap extrapolation at 350ms
        return {
          posX: a.posX + a.velX * elapsed,
          posY: a.posY + a.velY * elapsed,
          posZ: a.posZ + a.velZ * elapsed,
          velX: a.velX, velY: a.velY, velZ: a.velZ,
          yaw: a.yaw, speed: a.speed, flags: a.flags, hp: a.hp,
        };
      }
      return a;
    }

    const dt = b.time - a.time;
    if (dt <= 0) return b;

    const rawT = (renderTime - a.time) / dt;

    // If t > 1, we've run past the latest snapshot — extrapolate gently
    if (rawT > 1) {
      const overshoot = (renderTime - b.time) / 1000; // seconds past b
      if (overshoot > 0 && overshoot < 0.35) { // cap at 350ms
        return {
          posX: b.posX + b.velX * overshoot,
          posY: b.posY + b.velY * overshoot,
          posZ: b.posZ + b.velZ * overshoot,
          velX: b.velX, velY: b.velY, velZ: b.velZ,
          yaw: b.yaw, speed: b.speed, flags: b.flags, hp: b.hp,
        };
      }
      return b;
    }

    const t = Math.max(0, rawT);

    // Hermite interpolation for position using velocity
    const dt_sec = dt / 1000;
    return {
      posX: _hermite(a.posX, a.velX * dt_sec, b.posX, b.velX * dt_sec, t),
      posY: _hermite(a.posY, a.velY * dt_sec, b.posY, b.velY * dt_sec, t),
      posZ: _hermite(a.posZ, a.velZ * dt_sec, b.posZ, b.velZ * dt_sec, t),
      velX: _lerp(a.velX, b.velX, t),
      velY: _lerp(a.velY, b.velY, t),
      velZ: _lerp(a.velZ, b.velZ, t),
      yaw: _lerpAngle(a.yaw, b.yaw, t),
      speed: _lerp(a.speed, b.speed, t),
      flags: t < 0.5 ? a.flags : b.flags,
      hp: t < 0.5 ? a.hp : b.hp,
    };
  }

  /**
   * Get the latest raw state (no interpolation).
   */
  latest() {
    return this._buffer.length > 0 ? this._buffer[this._buffer.length - 1] : null;
  }

  /**
   * Adapt interpolation delay based on measured jitter.
   * Low jitter → smaller delay (more responsive).
   * High jitter → larger delay (smoother, avoids stalls).
   */
  _updateAdaptiveDelay() {
    if (this._jitterSamples.length < 5) return;
    // Compute mean and standard deviation of inter-packet gaps
    let sum = 0;
    for (let i = 0; i < this._jitterSamples.length; i++) sum += this._jitterSamples[i];
    const mean = sum / this._jitterSamples.length;
    let variance = 0;
    for (let i = 0; i < this._jitterSamples.length; i++) {
      const d = this._jitterSamples[i] - mean;
      variance += d * d;
    }
    const stdDev = Math.sqrt(variance / this._jitterSamples.length);
    // Delay = mean gap + 2× stddev, clamped between baseDelay and baseDelay*2.5.
    // Never go below baseDelay — doing so starves the buffer (< 3 samples)
    // and causes constant extrapolation stutter.
    const desired = mean + 2 * stdDev;
    this._delay = Math.max(this._baseDelay, Math.min(desired, this._baseDelay * 2.5));
  }

  /**
   * Clear the buffer.
   */
  clear() {
    this._buffer.length = 0;
    this._jitterSamples.length = 0;
    this._lastPushTime = 0;
    this._delay = this._baseDelay;
  }
}

// ── Math helpers ─────────────────────────────────��─────────────────────

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _lerpAngle(a, b, t) {
  let diff = b - a;
  // Shortest arc
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Cubic Hermite interpolation.
 * p0, m0: start value & tangent; p1, m1: end value & tangent; t: [0,1]
 */
function _hermite(p0, m0, p1, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}
