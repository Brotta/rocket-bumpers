import { SCORE } from './Config.js';

/**
 * ScoreManager — tracks per-player scores in endless mode.
 *
 * Multiplayer-ready: all state is keyed by playerId and serializable.
 * Events: 'scoreUpdate' { playerId, score, streak, delta }
 *         'leaderboard' { entries: [{ playerId, nickname, score, kills, deaths, streak }] }
 */
export class ScoreManager {
  constructor() {
    /** @type {Map<string, { nickname: string, score: number, kills: number, deaths: number, streak: number, hits: number }>} */
    this._players = new Map();
    this._listeners = {};
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
  }

  _emit(event, data) {
    const arr = this._listeners[event];
    if (arr) for (const fn of arr) fn(data);
  }

  // ── Player registration ───────────────────────────────────────────────

  registerPlayer(playerId, nickname) {
    if (!this._players.has(playerId)) {
      this._players.set(playerId, {
        nickname,
        score: 0,
        kills: 0,
        deaths: 0,
        streak: 0,
        hits: 0,
      });
    }
  }

  removePlayer(playerId) {
    this._players.delete(playerId);
  }

  // ── Score events ──────────────────────────────────────────────────────

  /** Called when a player kills another. */
  onKill(killerId, victimId) {
    const killer = this._players.get(killerId);
    const victim = this._players.get(victimId);

    if (killer) {
      killer.kills++;
      killer.streak++;
      const multiplier = this._getStreakMultiplier(killer.streak);
      const delta = SCORE.KO * multiplier;
      killer.score += delta;
      this._emit('scoreUpdate', {
        playerId: killerId,
        score: killer.score,
        streak: killer.streak,
        delta,
        multiplier,
      });
    }

    if (victim) {
      victim.deaths++;
      victim.streak = 0;
      victim.score = Math.max(0, victim.score + SCORE.DEATH);
      this._emit('scoreUpdate', {
        playerId: victimId,
        score: victim.score,
        streak: 0,
        delta: SCORE.DEATH,
        multiplier: 1,
      });
    }

    this._emitLeaderboard();
  }

  /** Called when a player deals damage to another. */
  onDamage(attackerId, amount) {
    const attacker = this._players.get(attackerId);
    if (!attacker) return;

    attacker.hits++;
    const delta = amount >= SCORE.BIG_HIT_THRESHOLD ? SCORE.BIG_HIT : SCORE.SMALL_HIT;
    const multiplier = this._getStreakMultiplier(attacker.streak);
    attacker.score += delta * multiplier;
    this._emit('scoreUpdate', {
      playerId: attackerId,
      score: attacker.score,
      streak: attacker.streak,
      delta: delta * multiplier,
      multiplier,
    });
  }

  /** Called when a player dies (no killer — environmental, self). */
  onDeath(playerId) {
    const player = this._players.get(playerId);
    if (!player) return;

    player.deaths++;
    player.streak = 0;
    player.score = Math.max(0, player.score + SCORE.DEATH);
    this._emit('scoreUpdate', {
      playerId,
      score: player.score,
      streak: 0,
      delta: SCORE.DEATH,
      multiplier: 1,
    });
    this._emitLeaderboard();
  }

  // ── Getters ───────────────────────────────────────────────────────────

  getPlayerStats(playerId) {
    return this._players.get(playerId) || null;
  }

  getLeaderboard() {
    return [...this._players.entries()]
      .map(([playerId, data]) => ({ playerId, ...data }))
      .sort((a, b) => b.score - a.score);
  }

  // ── Serialization (for portal params & multiplayer sync) ──────────────

  serialize() {
    const obj = {};
    for (const [id, data] of this._players) {
      obj[id] = { ...data };
    }
    return obj;
  }

  /**
   * Bulk-update player data from server state (multiplayer).
   * @param {object[]} scores — [{ playerId, nickname, score, kills, deaths, streak }]
   */
  syncFromServer(scores) {
    for (const s of scores) {
      this.registerPlayer(s.playerId, s.nickname);
      const data = this._players.get(s.playerId);
      if (data) {
        data.score = s.score;
        data.kills = s.kills;
        data.deaths = s.deaths;
        data.streak = s.streak;
      }
    }
    this._emitLeaderboard();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _getStreakMultiplier(streak) {
    if (streak >= SCORE.STREAK_3X) return 3;
    if (streak >= SCORE.STREAK_2X) return 2;
    return 1;
  }

  _emitLeaderboard() {
    this._emit('leaderboard', { entries: this.getLeaderboard() });
  }
}
