import type * as Party from 'partykit/server';
import { MSG, SRV, GAME } from './protocol.js';
import { calcDamage, getStreakMultiplier } from './damage.js';

// ── Types ──────────────────────────────────────────────────────────────

interface PlayerData {
  id: string;
  nickname: string;
  carType: string;
  hp: number;
  mass: number;
  isEliminated: boolean;
  isInvincible: boolean;
  score: number;
  kills: number;
  deaths: number;
  streak: number;
  hits: number;
  lastStateTime: number;
}

interface PowerupPedestal {
  id: string;
  type: string | null;
  position: [number, number, number];
  respawnAt: number | null;
}

// ── Stat tables (must match client Config.js STAT_MAP) ─────────────────

const STAT_BASE_MASS = 10;
const MAX_STAT = 10;
const CAR_STATS: Record<string, { mass: number }> = {
  FANG:    { mass: 5 },
  HORNET:  { mass: 2 },
  RHINO:   { mass: 8 },
  VIPER:   { mass: 3 },
  TOAD:    { mass: 6 },
  LYNX:    { mass: 4 },
  MAMMOTH: { mass: 7 },
  GHOST:   { mass: 3 },
};

const VALID_CAR_TYPES = new Set(Object.keys(CAR_STATS));

function getCarMass(carType: string): number {
  const stat = CAR_STATS[carType]?.mass ?? 5;
  return +(STAT_BASE_MASS * stat / MAX_STAT).toFixed(1);
}

// ── Power-up pedestal positions (6 around arena perimeter) ─────────────

const PEDESTAL_COUNT = 6;
const ARENA_RADIUS = 60; // diameter/2
const PEDESTAL_DIST = ARENA_RADIUS * 0.65;

function buildPedestalPositions(): [number, number, number][] {
  const positions: [number, number, number][] = [];
  for (let i = 0; i < PEDESTAL_COUNT; i++) {
    const angle = (i / PEDESTAL_COUNT) * Math.PI * 2;
    positions.push([
      Math.cos(angle) * PEDESTAL_DIST,
      0.6,
      Math.sin(angle) * PEDESTAL_DIST,
    ]);
  }
  return positions;
}

const POWERUP_TYPES = [
  'MISSILE', 'HOMING_MISSILE', 'SHIELD', 'REPAIR_KIT',
  'HOLO_EVADE', 'AUTO_TURRET', 'GLITCH_BOMB',
];
const POWERUP_WEIGHTS = [22, 18, 18, 18, 12, 12, 6];
const WEIGHT_TOTAL = POWERUP_WEIGHTS.reduce((a, b) => a + b, 0);

function randomPowerupType(): string {
  let r = Math.random() * WEIGHT_TOTAL;
  for (let i = 0; i < POWERUP_TYPES.length; i++) {
    r -= POWERUP_WEIGHTS[i];
    if (r <= 0) return POWERUP_TYPES[i];
  }
  return POWERUP_TYPES[0];
}

// ── Room ID sequencing (for matchmaking overflow) ─────────────────────

function _nextRoomId(currentRoom: string): string {
  // Rooms are named "arena-1", "arena-2", etc.
  const match = currentRoom.match(/^(.+?)-(\d+)$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10);
    return `${prefix}-${num + 1}`;
  }
  // Fallback: append -2 if room doesn't follow the pattern
  return `${currentRoom}-2`;
}

// ── Room server ────────────────────────────────────────────────────────

export default class RocketBumpersServer implements Party.Server {
  // Room state
  players: Map<string, PlayerData> = new Map();
  hostId: string | null = null;
  powerups: Map<string, PowerupPedestal> = new Map();
  pairCooldowns: Map<string, number> = new Map();

  // Connection order for host migration
  connectionOrder: string[] = [];

  // Rate limiting: connectionId → message timestamps
  rateLimits: Map<string, number[]> = new Map();
  readonly MAX_MESSAGES_PER_SECOND = 60;

  // Per-player obstacle damage cooldown: playerId → expiry timestamp
  obstacleDamageCooldowns: Map<string, number> = new Map();

  // Invincibility timeout handles: playerId → timeout handle
  invincibilityTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Interval IDs for cleanup
  _intervals: ReturnType<typeof setInterval>[] = [];

  constructor(readonly room: Party.Room) {}

  onStart() {
    // Initialize power-up pedestals
    const positions = buildPedestalPositions();
    for (let i = 0; i < PEDESTAL_COUNT; i++) {
      const id = `pu_${i}`;
      this.powerups.set(id, {
        id,
        type: randomPowerupType(),
        position: positions[i],
        respawnAt: null,
      });
    }

    // Power-up respawn timer (check every second)
    this._intervals.push(setInterval(() => this._checkPowerupRespawns(), 1000));

    // Periodic score broadcast (every 3 seconds)
    this._intervals.push(setInterval(() => {
      if (this.players.size > 0) this._broadcastScores();
    }, 3000));

    // Periodic cleanup of expired pairCooldowns (every 10 seconds)
    this._intervals.push(setInterval(() => {
      const now = Date.now();
      for (const [key, expiry] of this.pairCooldowns) {
        if (now >= expiry) this.pairCooldowns.delete(key);
      }
    }, 10000));

    // Stale player detection: eliminate players with no state update in 30s
    this._intervals.push(setInterval(() => {
      const now = Date.now();
      const STALE_THRESHOLD_MS = 30000;
      for (const [, player] of this.players) {
        if (!player.isEliminated && (now - player.lastStateTime) > STALE_THRESHOLD_MS) {
          this._handleElimination(player, null);
        }
      }
    }, 10000));
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  onConnect(conn: Party.Connection) {
    // Send current room state to the new connection
    // Player registration happens on PLAYER_JOIN message
  }

  onClose(conn: Party.Connection) {
    const playerId = conn.id;
    this.players.delete(playerId);
    this.rateLimits.delete(playerId);
    this.obstacleDamageCooldowns.delete(playerId);
    const invTimer = this.invincibilityTimers.get(playerId);
    if (invTimer) { clearTimeout(invTimer); this.invincibilityTimers.delete(playerId); }

    // Remove from connection order
    const idx = this.connectionOrder.indexOf(playerId);
    if (idx !== -1) this.connectionOrder.splice(idx, 1);

    // Broadcast player left
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_LEFT,
      id: playerId,
    }));

    // Host migration
    if (playerId === this.hostId) {
      // Clean up orphaned bot entries — bots are managed by the host client
      const botIds: string[] = [];
      for (const [id] of this.players) {
        if (id.startsWith('bot_')) botIds.push(id);
      }
      for (const botId of botIds) {
        this.players.delete(botId);
        this.room.broadcast(JSON.stringify({
          type: SRV.PLAYER_LEFT,
          id: botId,
        }));
      }

      this.hostId = this.connectionOrder[0] || null;
      if (this.hostId) {
        this.room.broadcast(JSON.stringify({
          type: SRV.HOST_CHANGED,
          newHostId: this.hostId,
        }));
      }
    }
  }

  onError(conn: Party.Connection) {
    this.onClose(conn);
  }

  // ── Message routing ──────────────────────────────────────────────────

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    // Rate limiting
    if (!this._checkRateLimit(sender.id)) return;

    // Binary messages (PLAYER_STATE)
    if (message instanceof ArrayBuffer) {
      this._handleBinaryState(message, sender);
      return;
    }

    // JSON messages
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    switch (data.type) {
      case MSG.PLAYER_JOIN:
        this._onPlayerJoin(data, sender);
        break;
      case MSG.COLLISION:
        this._onCollision(data, sender);
        break;
      case MSG.PICKUP_POWERUP:
        this._onPickupPowerup(data, sender);
        break;
      case MSG.USE_POWERUP:
        this._onUsePowerup(data, sender);
        break;
      case MSG.USE_ABILITY:
        this._onUseAbility(data, sender);
        break;
      case MSG.PLAYER_FELL:
        this._onPlayerFell(data, sender);
        break;
      case MSG.OBSTACLE_DAMAGE:
        this._onObstacleDamage(data, sender);
        break;
      case MSG.POWERUP_DAMAGE:
        this._onPowerupDamage(data, sender);
        break;
      case MSG.ENV_DAMAGE:
        this._onEnvDamage(data, sender);
        break;
      case MSG.CHANGE_CAR:
        this._onChangeCar(data, sender);
        break;
      case MSG.PLAYER_RESPAWN:
        this._onPlayerRespawn(data, sender);
        break;
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────

  _onPlayerJoin(data: any, sender: Party.Connection) {
    const playerId = sender.id;
    const { nickname, carType } = data;

    // Validate
    if (!nickname || !carType) return;
    if (!VALID_CAR_TYPES.has(String(carType))) return;

    // Room full — try to kick a bot to make space, otherwise redirect
    if (this.players.size >= GAME.MAX_PLAYERS) {
      // Find a bot to remove (bot IDs start with "bot_")
      let removedBotId: string | null = null;
      for (const [id] of this.players) {
        if (id.startsWith('bot_')) {
          removedBotId = id;
          break;
        }
      }

      if (removedBotId) {
        // Remove the bot from server state
        this.players.delete(removedBotId);
        const orderIdx = this.connectionOrder.indexOf(removedBotId);
        if (orderIdx !== -1) this.connectionOrder.splice(orderIdx, 1);

        // Tell all clients to remove this bot
        this.room.broadcast(JSON.stringify({
          type: SRV.PLAYER_LEFT,
          id: removedBotId,
        }));
      } else {
        // No bots to remove — room is genuinely full with humans
        const currentRoom = this.room.id;
        const nextRoom = _nextRoomId(currentRoom);
        sender.send(JSON.stringify({
          type: SRV.ROOM_FULL,
          suggestedRoom: nextRoom,
        }));
        return;
      }
    }

    const player: PlayerData = {
      id: playerId,
      nickname: String(nickname).slice(0, 12),
      carType: String(carType),
      hp: GAME.MAX_HP,
      mass: getCarMass(carType),
      isEliminated: false,
      isInvincible: true, // spawn invincibility
      score: 0,
      kills: 0,
      deaths: 0,
      streak: 0,
      hits: 0,
      lastStateTime: Date.now(),
    };

    this.players.set(playerId, player);
    if (!this.connectionOrder.includes(playerId)) {
      this.connectionOrder.push(playerId);
    }

    // First player becomes host
    if (!this.hostId) {
      this.hostId = playerId;
    }

    // Send ROOM_STATE to the joining player
    const roomState = {
      type: SRV.ROOM_STATE,
      playerId,
      hostId: this.hostId,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        nickname: p.nickname,
        carType: p.carType,
        hp: p.hp,
        isEliminated: p.isEliminated,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        streak: p.streak,
      })),
      powerups: Array.from(this.powerups.values()).map(p => ({
        id: p.id,
        type: p.type,
        position: p.position,
      })),
    };
    sender.send(JSON.stringify(roomState));

    // Broadcast new player to everyone else
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_JOINED,
      id: playerId,
      nickname: player.nickname,
      carType: player.carType,
    }), [playerId]);

    // Clear spawn invincibility after 1.5s (cancel previous if any)
    this._setInvincibilityTimer(playerId, 1500);
  }

  _handleBinaryState(buffer: ArrayBuffer, sender: Party.Connection) {
    // New format: [msgType:1][entityIdLen:1][entityId:N][carTypeIndex:1][state:18]
    // Format: [0x01:1][idLen:1][entityId:N][carTypeIndex:1][16 bytes float16][flags:1][hp:1]
    // Total = 2 + N + 19 bytes. Minimum with 1-char ID = 22
    if (buffer.byteLength < 22) return;

    const view = new DataView(buffer);
    if (view.getUint8(0) !== MSG.PLAYER_STATE_BIN) return;

    const idLen = view.getUint8(1);
    if (buffer.byteLength < 2 + idLen + 19) return;

    // Extract entity ID for validation
    const entityId = new TextDecoder().decode(new Uint8Array(buffer, 2, idLen));

    // Security: non-host can only send their own state
    if (sender.id !== this.hostId && entityId !== sender.id) return;

    // Relay the entire binary message as-is to all OTHER clients
    this.room.broadcast(buffer, [sender.id]);

    // Update server-side state for the entity
    // State layout: [0x01][idLen:1][entityId:N][carTypeIndex:1][...16 bytes float16...][flags:1][hp:1]
    // HP is at offset 2 + idLen + 18
    const player = this.players.get(entityId);
    if (player) {
      player.lastStateTime = Date.now();
      // Don't trust client HP — server is authoritative for HP.
      // Only update lastStateTime for stale detection.
    }
  }

  _onCollision(data: any, sender: Party.Connection) {
    const attackerId = sender.id;
    const { targetId, approachSpeed } = data;

    // Validate targetId
    if (typeof targetId !== 'string' || targetId.length > 64) return;

    const attacker = this.players.get(attackerId);
    const victim = this.players.get(targetId);
    if (!attacker || !victim) return;

    // Validate
    if (victim.isEliminated || victim.isInvincible) return;
    if (attacker.isEliminated) return;
    if (typeof approachSpeed !== 'number' || !isFinite(approachSpeed) || approachSpeed < 0) return;

    // Use server-authoritative mass — never trust client-provided values
    const attackerMass = attacker.mass;
    const victimMass = victim.mass;
    const angleFactor = (typeof data.angleFactor === 'number' && isFinite(data.angleFactor))
      ? Math.min(Math.max(data.angleFactor, GAME.ANGLE_MIN), GAME.ANGLE_MAX) : 1.0;

    // Speed plausibility check
    if (approachSpeed > GAME.MAX_VELOCITY * 1.5) return;

    // Per-pair cooldown
    const idA = attackerId < targetId ? attackerId : targetId;
    const idB = attackerId < targetId ? targetId : attackerId;
    const pairKey = `${idA}-${idB}`;
    const now = Date.now();
    const cooldownExpiry = this.pairCooldowns.get(pairKey) || 0;
    if (now < cooldownExpiry) return;
    this.pairCooldowns.set(pairKey, now + GAME.PAIR_COOLDOWN_MS);

    // Calculate damage
    const damage = calcDamage(
      approachSpeed,
      attackerMass,
      victimMass,
      angleFactor,
    );
    if (damage <= 0) return;

    // Apply damage
    victim.hp = Math.max(0, victim.hp - damage);

    // Broadcast damage
    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId,
      amount: Math.round(damage * 10) / 10,
      sourceId: attackerId,
      wasAbility: !!data.wasAbility,
    }));

    // Score: credit attacker for hit
    attacker.hits++;
    const hitDelta = damage >= GAME.SCORE_BIG_HIT_THRESHOLD
      ? GAME.SCORE_BIG_HIT : GAME.SCORE_SMALL_HIT;
    const hitMult = getStreakMultiplier(attacker.streak);
    attacker.score += hitDelta * hitMult;

    // Check elimination
    if (victim.hp <= 0) {
      this._handleElimination(victim, attacker);
    }
  }

  _handleElimination(victim: PlayerData, killer: PlayerData | null) {
    // Guard: prevent double-counting if called from multiple sources
    if (victim.isEliminated) return;
    victim.isEliminated = true;

    // Score: kill credit
    if (killer) {
      killer.kills++;
      killer.streak++;
      const mult = getStreakMultiplier(killer.streak);
      const delta = GAME.SCORE_KO * mult;
      killer.score += delta;
    }

    // Score: victim death penalty
    victim.deaths++;
    victim.streak = 0;
    victim.score = Math.max(0, victim.score + GAME.SCORE_DEATH);

    // Broadcast elimination
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_ELIMINATED,
      playerId: victim.id,
      killerId: killer?.id || null,
    }));

    // Broadcast updated scores
    this._broadcastScores();
  }

  _onPlayerFell(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player || player.isEliminated) return;

    // Skip if invincible
    if (player.isInvincible) return;

    // Apply fall damage
    player.hp = Math.max(0, player.hp - GAME.FALL_DAMAGE);

    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId: sender.id,
      amount: GAME.FALL_DAMAGE,
      sourceId: null,
      wasAbility: false,
    }));

    if (player.hp <= 0) {
      // Validate lastHitBy attribution: must be a string, existing player, not eliminated
      const killerId = (typeof data.lastHitById === 'string') ? data.lastHitById : null;
      const killer = killerId ? this.players.get(killerId) : null;
      // Only credit kill if the killer exists and isn't eliminated
      this._handleElimination(player, (killer && !killer.isEliminated) ? killer : null);
    }
  }

  _onPickupPowerup(data: any, sender: Party.Connection) {
    const { powerupId } = data;
    const pedestal = this.powerups.get(powerupId);
    if (!pedestal || !pedestal.type) {
      // Deny: pedestal empty or doesn't exist
      sender.send(JSON.stringify({
        type: SRV.PICKUP_DENIED,
        powerupId,
      }));
      return;
    }

    // First-come-first-served: grant pickup
    const type = pedestal.type;
    pedestal.type = null;
    pedestal.respawnAt = Date.now() + GAME.POWERUP_RESPAWN_MS;

    this.room.broadcast(JSON.stringify({
      type: SRV.POWERUP_TAKEN,
      id: powerupId,
      playerId: sender.id,
      powerupType: type,
    }));
  }

  _onUsePowerup(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player || player.isEliminated) return;
    if (typeof data.powerupType !== 'string' || data.powerupType.length > 32) return;
    const pos = Array.isArray(data.pos) && data.pos.length === 3
      && data.pos.every((v: any) => typeof v === 'number' && isFinite(v))
      ? data.pos : null;

    this.room.broadcast(JSON.stringify({
      type: SRV.POWERUP_USED,
      playerId: sender.id,
      powerupType: data.powerupType,
      pos,
    }), [sender.id]);
  }

  _onUseAbility(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player || player.isEliminated) return;
    if (typeof data.abilityType !== 'string' || data.abilityType.length > 32) return;
    const pos = Array.isArray(data.pos) && data.pos.length === 3
      && data.pos.every((v: any) => typeof v === 'number' && isFinite(v))
      ? data.pos : null;

    this.room.broadcast(JSON.stringify({
      type: SRV.ABILITY_USED,
      playerId: sender.id,
      abilityType: data.abilityType,
      pos,
    }), [sender.id]);
  }

  _onObstacleDamage(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player || player.isEliminated || player.isInvincible) return;

    // Per-player cooldown (500ms) to prevent spam
    const now = Date.now();
    const cooldownExpiry = this.obstacleDamageCooldowns.get(sender.id) || 0;
    if (now < cooldownExpiry) return;
    this.obstacleDamageCooldowns.set(sender.id, now + 500);

    const damage = typeof data.damage === 'number' ? Math.min(Math.max(data.damage, 0), GAME.MAX_DAMAGE) : 0;
    if (damage <= 0) return;

    player.hp = Math.max(0, player.hp - damage);

    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId: sender.id,
      amount: Math.round(damage * 10) / 10,
      sourceId: null,
      wasAbility: false,
    }));

    if (player.hp <= 0) {
      this._handleElimination(player, null);
    }
  }

  _onPowerupDamage(data: any, sender: Party.Connection) {
    const attacker = this.players.get(sender.id);
    if (!attacker || attacker.isEliminated) return;

    const { targetId } = data;
    if (typeof targetId !== 'string' || targetId.length > 64) return;

    const victim = this.players.get(targetId);
    if (!victim || victim.isEliminated || victim.isInvincible) return;

    const damage = typeof data.damage === 'number' && isFinite(data.damage)
      ? Math.min(Math.max(data.damage, 0), GAME.MAX_DAMAGE) : 0;
    if (damage <= 0) return;

    victim.hp = Math.max(0, victim.hp - damage);

    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId,
      amount: Math.round(damage * 10) / 10,
      sourceId: sender.id,
      wasAbility: false,
    }));

    attacker.hits++;
    const hitDelta = damage >= GAME.SCORE_BIG_HIT_THRESHOLD
      ? GAME.SCORE_BIG_HIT : GAME.SCORE_SMALL_HIT;
    attacker.score += hitDelta;

    if (victim.hp <= 0) {
      this._handleElimination(victim, attacker);
    }
  }

  _onEnvDamage(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player || player.isEliminated || player.isInvincible) return;

    const damage = typeof data.damage === 'number' && isFinite(data.damage)
      ? Math.min(Math.max(data.damage, 0), GAME.MAX_DAMAGE) : 0;
    if (damage <= 0) return;

    player.hp = Math.max(0, player.hp - damage);

    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId: sender.id,
      amount: Math.round(damage * 10) / 10,
      sourceId: null,
      wasAbility: false,
    }));

    if (player.hp <= 0) {
      this._handleElimination(player, null);
    }
  }

  _onChangeCar(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player) return;
    const carType = String(data.carType);
    if (!VALID_CAR_TYPES.has(carType)) return;
    player.carType = carType;
    player.mass = getCarMass(carType);
  }

  _onPlayerRespawn(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player) return;

    player.hp = GAME.MAX_HP;
    player.isEliminated = false;
    player.isInvincible = true;
    if (data.carType && VALID_CAR_TYPES.has(String(data.carType))) {
      player.carType = String(data.carType);
      player.mass = getCarMass(player.carType);
    }

    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_RESPAWN,
      playerId: sender.id,
      carType: player.carType,
      pos: data.pos,
    }));

    // Clear invincibility after 1.5s (cancel previous if any)
    this._setInvincibilityTimer(sender.id, 1500);
  }

  /** Set or reset an invincibility timer for a player. Cancels any existing timer. */
  _setInvincibilityTimer(playerId: string, ms: number) {
    const existing = this.invincibilityTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.invincibilityTimers.delete(playerId);
      const p = this.players.get(playerId);
      if (p) p.isInvincible = false;
    }, ms);
    this.invincibilityTimers.set(playerId, handle);
  }

  // ── Power-up respawns ────────────────────────────────────────────────

  _checkPowerupRespawns() {
    const now = Date.now();
    for (const [id, pedestal] of this.powerups) {
      if (!pedestal.type && pedestal.respawnAt && now >= pedestal.respawnAt) {
        pedestal.type = randomPowerupType();
        pedestal.respawnAt = null;
        this.room.broadcast(JSON.stringify({
          type: SRV.POWERUP_SPAWNED,
          id,
          powerupType: pedestal.type,
          position: pedestal.position,
        }));
      }
    }
  }

  // ── Score broadcast ──────────────────────────────────────────────────

  _broadcastScores() {
    const scores = Array.from(this.players.values()).map(p => ({
      playerId: p.id,
      nickname: p.nickname,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      streak: p.streak,
    })).sort((a, b) => b.score - a.score);

    this.room.broadcast(JSON.stringify({
      type: SRV.SCORE_UPDATE,
      scores,
    }));
  }

  // ── Rate limiting ────────────────────────────────────────────────────

  _checkRateLimit(connId: string): boolean {
    const now = Date.now();
    let stamps = this.rateLimits.get(connId);
    if (!stamps) {
      stamps = [];
      this.rateLimits.set(connId, stamps);
    }

    // Remove timestamps older than 1 second
    while (stamps.length > 0 && stamps[0] < now - 1000) {
      stamps.shift();
    }

    if (stamps.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false;
    }

    stamps.push(now);
    return true;
  }
}
