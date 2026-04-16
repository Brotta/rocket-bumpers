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
   *
   * BUG 3+4 fix: the caller passes the authoritative server timestamp (ms)
   * when available. All timestamps in the buffer live in the same clock
   * space — either server-clock (new batched protocol) or local-clock
   * (legacy single-entity fallback). The sample() caller must use the
   * matching `now` value.
   *
   * @param {object} state — { posX, posY, posZ, velX, velY, velZ, yaw, speed, flags, hp }
   * @param {number} [timestamp] — server-clock ms; defaults to performance.now()
   */
  push(state, timestamp) {
    // Guard against NaN contamination — skip corrupted states
    if (isNaN(state.posX) || isNaN(state.posY) || isNaN(state.posZ) ||
        isNaN(state.velX) || isNaN(state.velY) || isNaN(state.velZ)) return;

    const t = (typeof timestamp === 'number' && isFinite(timestamp))
      ? timestamp
      : performance.now();

    // Deduplicate: if the new timestamp collides with the most recent entry
    // (e.g. two entries from the same server tick or fallback packets that
    // collapse to the same performance.now()), keep the latest by overwriting.
    // Without this, Hermite bracketing can pick a zero-duration interval.
    const last = this._buffer[this._buffer.length - 1];
    if (last && t <= last.time) {
      last.time = t;
      last.posX = state.posX; last.posY = state.posY; last.posZ = state.posZ;
      last.velX = state.velX; last.velY = state.velY; last.velZ = state.velZ;
      last.yaw = state.yaw; last.speed = state.speed;
      last.flags = state.flags; last.hp = state.hp;
      return;
    }

    // Track inter-packet jitter to adapt interpolation delay
    if (this._lastPushTime > 0) {
      const gap = t - this._lastPushTime;
      if (gap > 0) {
        this._jitterSamples.push(gap);
        if (this._jitterSamples.length > this._maxJitterSamples) {
          this._jitterSamples.shift();
        }
        this._updateAdaptiveDelay();
      }
    }
    this._lastPushTime = t;

    const entry = {
      time: t,
      ...state,
    };
    this._buffer.push(entry);
    if (this._buffer.length > this._maxSize) {
      this._buffer.shift();
    }
  }

  /**
   * Sample the interpolated state at the current render time.
   *
   * @param {number} [now] — current time in the SAME clock space as the
   *   timestamps passed to push() (server-clock if using the batched
   *   protocol). Defaults to performance.now() for legacy callers.
   * @returns {object|null} — interpolated state or null if no data
   */
  sample(now) {
    if (typeof now !== 'number' || !isFinite(now)) now = performance.now();
    const len = this._buffer.length;
    if (len === 0) return null;
    if (len === 1) {
      // Single snapshot — extrapolate using velocity for smooth motion.
      // BUG 10 fix: apply exponential velocity decay (τ=0.2s) so the
      // displacement integral converges — a network stall no longer sends
      // the vehicle flying off at constant speed. At t→∞, displacement
      // asymptotes to v0·τ = 0.2·v0, which is smooth to return from.
      const s = this._buffer[0];
      const elapsed = (now - s.time) / 1000;
      if (elapsed > 0 && elapsed < 0.35) {
        const tau = 0.2;
        const decayFactor = Math.exp(-elapsed / tau);
        const displacement = tau * (1 - decayFactor);
        return {
          posX: s.posX + s.velX * displacement,
          posY: s.posY + s.velY * displacement,
          posZ: s.posZ + s.velZ * displacement,
          velX: s.velX * decayFactor,
          velY: s.velY * decayFactor,
          velZ: s.velZ * decayFactor,
          yaw: s.yaw, speed: s.speed, flags: s.flags, hp: s.hp,
        };
      }
      return s;
    }

    const renderTime = now - this._delay;

    // Find bracketing snapshots
    let i = 0;
    for (; i < len - 1; i++) {
      if (this._buffer[i + 1].time >= renderTime) break;
    }

    const a = this._buffer[i];
    const b = this._buffer[Math.min(i + 1, len - 1)];

    if (a === b) {
      // Only one unique snapshot — extrapolate using its velocity (with decay).
      const elapsed = (renderTime - a.time) / 1000;
      if (elapsed > 0 && elapsed < 0.35) { // cap extrapolation at 350ms
        const tau = 0.2;
        const decayFactor = Math.exp(-elapsed / tau);
        const displacement = tau * (1 - decayFactor);
        return {
          posX: a.posX + a.velX * displacement,
          posY: a.posY + a.velY * displacement,
          posZ: a.posZ + a.velZ * displacement,
          velX: a.velX * decayFactor, velY: a.velY * decayFactor, velZ: a.velZ * decayFactor,
          yaw: a.yaw, speed: a.speed, flags: a.flags, hp: a.hp,
        };
      }
      return a;
    }

    const dt = b.time - a.time;
    if (dt <= 0) return b;

    const rawT = (renderTime - a.time) / dt;

    // If t > 1, we've run past the latest snapshot — extrapolate gently
    // with exponential velocity decay (BUG 10 fix).
    if (rawT > 1) {
      const overshoot = (renderTime - b.time) / 1000; // seconds past b
      if (overshoot > 0 && overshoot < 0.35) { // cap at 350ms
        const tau = 0.2;
        const decayFactor = Math.exp(-overshoot / tau);
        const displacement = tau * (1 - decayFactor);
        return {
          posX: b.posX + b.velX * displacement,
          posY: b.posY + b.velY * displacement,
          posZ: b.posZ + b.velZ * displacement,
          velX: b.velX * decayFactor, velY: b.velY * decayFactor, velZ: b.velZ * decayFactor,
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
   *
   * BUG 5 fix: the target delay is smoothed (low-pass EMA) instead of being
   * set instantly. An instant change of 80ms shifts renderTime = now - _delay
   * backward by 80ms on one frame, which produces a visible time-warp on
   * every rendered remote player. The EMA converges in ~15–20 packets
   * (~250–330ms at 60 Hz) — fast enough to track real jitter shifts, slow
   * enough that the eye doesn't see the transition.
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
    const rawDesired = mean + 2 * stdDev;
    const desired = Math.max(this._baseDelay, Math.min(rawDesired, this._baseDelay * 2.5));
    // EMA smoothing (alpha=0.08 per packet ≈ 250ms time-constant at 60 Hz).
    this._delay = this._delay * 0.92 + desired * 0.08;
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
