import { GAME_STATES, ROUND } from './Config.js';

/**
 * GameState — round state machine.
 *
 * States: LOBBY → COUNTDOWN → PLAYING → RESULTS → COUNTDOWN → …
 *
 * Listen to transitions via on('stateChange', { from, to }).
 * Additional events: 'countdownTick' { seconds }, 'roundTimeUpdate' { remaining }.
 */
export class GameState {
  constructor() {
    this.state = GAME_STATES.LOBBY;
    this.timer = 0;
    this._listeners = {};

    // Countdown tracking
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

  /** Manually trigger the start of a round (from LOBBY). */
  startRound() {
    if (this.state === GAME_STATES.LOBBY) {
      this._transition(GAME_STATES.COUNTDOWN);
    }
  }

  /** Force-end the current round (e.g. last car standing). */
  forceEndRound() {
    if (this.state === GAME_STATES.PLAYING) {
      this._transition(GAME_STATES.RESULTS);
    }
  }

  // ── Update (call every frame) ────────────────────────────────────────

  update(dt) {
    this.timer += dt;

    switch (this.state) {
      case GAME_STATES.LOBBY:
        // Lobby waits for explicit startRound() call
        break;

      case GAME_STATES.COUNTDOWN:
        this._updateCountdown();
        break;

      case GAME_STATES.PLAYING:
        this._updatePlaying();
        break;

      case GAME_STATES.RESULTS:
        this._updateResults();
        break;
    }
  }

  _updateCountdown() {
    const remaining = ROUND.countdown - this.timer;
    const sec = Math.ceil(remaining);

    if (sec !== this._lastCountdownSecond && sec > 0) {
      this._lastCountdownSecond = sec;
      this._emit('countdownTick', { seconds: sec });
    }

    if (remaining <= 0) {
      this._emit('countdownTick', { seconds: 0 }); // "SMASH!"
      this._transition(GAME_STATES.PLAYING);
    }
  }

  _updatePlaying() {
    const remaining = ROUND.playTime - this.timer;
    this._emit('roundTimeUpdate', { remaining: Math.max(0, remaining) });

    if (remaining <= 0) {
      this._transition(GAME_STATES.RESULTS);
    }
  }

  _updateResults() {
    if (this.timer >= ROUND.resultsTime) {
      this._transition(GAME_STATES.COUNTDOWN);
    }
  }

  // ── Getters ───────────────────────────────────────────────────────────

  /** Seconds remaining in current phase, or -1 if unlimited. */
  get remainingTime() {
    switch (this.state) {
      case GAME_STATES.COUNTDOWN: return Math.max(0, ROUND.countdown - this.timer);
      case GAME_STATES.PLAYING:   return Math.max(0, ROUND.playTime - this.timer);
      case GAME_STATES.RESULTS:   return Math.max(0, ROUND.resultsTime - this.timer);
      default: return -1;
    }
  }

  get isPlaying() {
    return this.state === GAME_STATES.PLAYING;
  }

  get isCountdown() {
    return this.state === GAME_STATES.COUNTDOWN;
  }
}
