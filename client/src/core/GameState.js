import { GAME_STATES } from './Config.js';

/**
 * GameState — endless mode state machine.
 *
 * States: LOADING → PLAYING (forever).
 *
 * No rounds, no countdown, no results. The game is always in PLAYING state
 * once started. Multiplayer-ready: state transitions are driven by explicit
 * calls, making it easy to synchronize via a server.
 */
export class GameState {
  constructor() {
    this.state = GAME_STATES.LOADING;
    this.timer = 0;
    this._listeners = {};
    this._lastCountdownSecond = -1;
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

  // ── State transitions ────────────────────────────────────────────────

  _transition(to) {
    const from = this.state;
    this.state = to;
    this.timer = 0;
    this._lastCountdownSecond = -1;
    this._emit('stateChange', { from, to });
  }

  /** Start endless play (from LOADING). */
  startPlaying() {
    if (this.state === GAME_STATES.LOADING) {
      this._transition(GAME_STATES.PLAYING);
    }
  }

  // Legacy compat — called by old code paths
  startRound() { this.startPlaying(); }
  forceEndRound() { /* no-op in endless mode */ }

  // ── Update (call every frame) ────────────────────────────────────────

  update(dt) {
    this.timer += dt;
    // No state transitions in endless mode — always PLAYING
  }

  // ── Getters ───────────────────────────────────────────────────────────

  get remainingTime() { return -1; }

  get isPlaying() {
    return this.state === GAME_STATES.PLAYING;
  }

  get isCountdown() {
    return false;
  }
}
