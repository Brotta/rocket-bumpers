import type * as Party from 'partykit/server';
import { MSG, SRV, BIN, GAME } from './protocol.js';
import { calcDamage, getStreakMultiplier } from './damage.js';
import {
  BotPhysicsState, PlayerSnapshot, createBot, stepBot, encodeBotEntry, shouldUsePowerup,
} from './botsim.js';
import {
  ServerProjectile, ServerTurret,
  spawnMissile, spawnHomingMissile, spawnTurret, spawnTurretBullet,
  stepProjectile, sweepProjectileHit, stepTurret,
  MISSILE as PROJ_MISSILE, HOMING as PROJ_HOMING,
} from './projectilesim.js';

// ── Types ──────────────────────────────────────────────────────────────

interface PlayerData {
  id: string;
  nickname: string;
  carType: string;
  hp: number;
  mass: number;
  isEliminated: boolean;
  isInvincible: boolean;
  // Defensive power-up state, server-tracked so damage calculations stay
  // consistent between human and bot actors. SHIELD halves all incoming
  // damage for 5s (matches client _shieldDamageReduction=0.5 window).
  // HOLO_EVADE doesn't reduce damage — instead it gives incoming homing
  // missiles / turret shots a 50% chance to lock onto a decoy (miss).
  hasShield: boolean;
  holoEvadeActive: boolean;
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

// Half-precision float read (little-endian, matches client protocol.js).
function _readFloat16(view: DataView, offset: number): number {
  const h = view.getUint16(offset, true);
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
  }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

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

  // Binary rate limiting: entityId → last binary message timestamp
  // Keyed per-entity (not per-connection) so the host can send states for
  // multiple entities (local player + bots) in the same tick without them
  // being rate-limited away.
  _binaryRateLimit: Map<string, number> = new Map();
  readonly BINARY_MIN_INTERVAL_MS = 8; // ~120 messages/sec max per entity (headroom for 60Hz sends)

  // Per-player obstacle damage cooldown: playerId → expiry timestamp
  obstacleDamageCooldowns: Map<string, number> = new Map();

  // Invincibility timeout handles: playerId → timeout handle
  invincibilityTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // SHIELD / HOLO_EVADE timers (separate so they don't clobber spawn invincibility).
  shieldTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  holoEvadeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Interval IDs for cleanup
  _intervals: ReturnType<typeof setInterval>[] = [];

  // Server tick: buffer latest binary state per entity, broadcast at 60Hz
  _stateBuffers: Map<string, { buffer: ArrayBuffer; senderId: string }> = new Map();
  readonly TICK_RATE_MS = 16; // ~60Hz — doubled from 30Hz for smooth interpolation

  // ── Server-side bot simulation (BUG 0 fix) ──
  // The server owns bot AI + physics so their pacing is decoupled from any
  // host client's render loop. Bots are spawned automatically to backfill
  // empty seats and their states ride in the same tick batch as humans.
  _bots: Map<string, BotPhysicsState> = new Map();
  _lastBotStep: number = 0;
  readonly TARGET_PLAYERS = 8;
  readonly MIN_BOTS = 3;
  readonly MAX_BOTS = 7;

  // Server-simulated projectiles and turrets fired by bots.
  // Human-fired projectiles stay on the client-authoritative path (unchanged).
  _botProjectiles: ServerProjectile[] = [];
  _botTurrets: ServerTurret[] = [];

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

    // Server tick loop: simulate bots (BUG 0) + batch-broadcast all states at 60Hz
    this._lastBotStep = Date.now();
    this._intervals.push(setInterval(() => {
      this._stepBots();
      this._tickBroadcast();
    }, this.TICK_RATE_MS));

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
    const wasHuman = !playerId.startsWith('bot_');
    this.players.delete(playerId);
    this.rateLimits.delete(playerId);
    this._binaryRateLimit.delete(playerId); // entity-keyed rate limit
    this.obstacleDamageCooldowns.delete(playerId);
    this._stateBuffers.delete(playerId);

    // Clean up pair cooldowns referencing this player so reconnect gets a clean slate
    for (const key of this.pairCooldowns.keys()) {
      if (key.includes(playerId)) this.pairCooldowns.delete(key);
    }
    const invTimer = this.invincibilityTimers.get(playerId);
    if (invTimer) { clearTimeout(invTimer); this.invincibilityTimers.delete(playerId); }
    const shTimer = this.shieldTimers.get(playerId);
    if (shTimer) { clearTimeout(shTimer); this.shieldTimers.delete(playerId); }
    const heTimer = this.holoEvadeTimers.get(playerId);
    if (heTimer) { clearTimeout(heTimer); this.holoEvadeTimers.delete(playerId); }

    // Remove from connection order
    const idx = this.connectionOrder.indexOf(playerId);
    if (idx !== -1) this.connectionOrder.splice(idx, 1);

    // Broadcast player left
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_LEFT,
      id: playerId,
    }));

    // Host migration — bots are server-owned now (BUG 0), so migrating the
    // host no longer disturbs bot state. We just pick the next human as host.
    if (playerId === this.hostId) {
      this.hostId = this.connectionOrder[0] || null;
      if (this.hostId) {
        this.room.broadcast(JSON.stringify({
          type: SRV.HOST_CHANGED,
          newHostId: this.hostId,
        }));
      }
    }

    // BUG 0: refresh bot population based on new human count.
    if (wasHuman) this._rebalanceBots();
  }

  onError(conn: Party.Connection) {
    this.onClose(conn);
  }

  // ── Message routing ──────────────────────────────────────────────────

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    // Binary messages (PLAYER_STATE) — per-entity rate limit so the host
    // can send states for local player + all bots in the same tick.
    if (message instanceof ArrayBuffer) {
      if (message.byteLength < 22) return;
      const view = new DataView(message);
      if (view.getUint8(0) !== MSG.PLAYER_STATE_BIN) return;

      // Extract entity ID for per-entity rate limiting
      const idLen = view.getUint8(1);
      if (message.byteLength < 2 + idLen + 19) return;
      const entityId = new TextDecoder().decode(new Uint8Array(message, 2, idLen));

      const now = Date.now();
      const lastBinary = this._binaryRateLimit.get(entityId) || 0;
      if (now - lastBinary < this.BINARY_MIN_INTERVAL_MS) return;
      this._binaryRateLimit.set(entityId, now);

      this._handleBinaryState(message, sender);
      return;
    }

    // Rate limiting (JSON messages only)
    if (!this._checkRateLimit(sender.id)) return;

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
      case MSG.REGISTER_BOT:
        this._onRegisterBot(data, sender);
        break;
      case MSG.OBSTACLE_DESTROYED:
        this._onObstacleDestroyed(data, sender);
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
        this._binaryRateLimit.delete(removedBotId);
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
      hasShield: false,
      holoEvadeActive: false,
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

    // First player becomes host (the host role is now only used for
    // administrative broadcasts — bots are server-simulated so the host no
    // longer runs privileged physics).
    if (!this.hostId) {
      this.hostId = playerId;
    }

    // BUG 0: refresh server-side bot population to fill the room.
    this._rebalanceBots();

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
    // Header already validated in onMessage (size, msgType, idLen).
    // Format: [0x01:1][idLen:1][entityId:N][carTypeIndex:1][16 bytes float16][flags:1][hp:1]
    const view = new DataView(buffer);
    const idLen = view.getUint8(1);
    const entityId = new TextDecoder().decode(new Uint8Array(buffer, 2, idLen));

    // Security: each client can only upload its own state.
    // Bots are server-simulated (BUG 0) — reject any client trying to spoof them.
    if (entityId !== sender.id) return;
    if (entityId.startsWith('bot_')) return;

    // Buffer latest state — will be batch-broadcast at 30Hz tick
    this._stateBuffers.set(entityId, { buffer: buffer.slice(0), senderId: sender.id });

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
    // Host can send collisions on behalf of bots via attackerId field
    let attackerId = sender.id;
    if (sender.id === this.hostId && typeof data.attackerId === 'string'
        && data.attackerId.startsWith('bot_') && data.attackerId.length <= 64) {
      attackerId = data.attackerId;
    }

    // Only accept collision reports from the attacker's connection
    // (prevent double damage when both clients report the same collision).
    // Non-host senders can only report collisions where they are the attacker.
    if (sender.id !== this.hostId && attackerId !== sender.id) return;

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

    const damage = calcDamage(approachSpeed, attackerMass, victimMass, angleFactor);
    if (damage <= 0) return;
    this._dealDamage(victim, damage, attacker, !!data.wasAbility);
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

    // BUG 0 fix: server owns bot respawn (humans respawn via PLAYER_RESPAWN
    // message — handled elsewhere). Schedule a respawn after a short delay.
    if (victim.id.startsWith('bot_')) {
      this._scheduleBotRespawn(victim.id);
    }
  }

  _scheduleBotRespawn(botId: string) {
    setTimeout(() => {
      const player = this.players.get(botId);
      const botState = this._bots.get(botId);
      if (!player || !botState) return; // bot was despawned in the meantime

      // Reset bot state — clear all status effects so they don't carry over.
      player.hp = GAME.MAX_HP;
      player.isEliminated = false;
      player.isInvincible = true;
      player.hasShield = false;
      player.holoEvadeActive = false;
      const sh = this.shieldTimers.get(botId); if (sh) { clearTimeout(sh); this.shieldTimers.delete(botId); }
      const he = this.holoEvadeTimers.get(botId); if (he) { clearTimeout(he); this.holoEvadeTimers.delete(botId); }
      player.lastStateTime = Date.now();
      this._setInvincibilityTimer(botId, 1500);

      // Respawn at a new edge position facing center
      const slot = Math.floor(Math.random() * 8);
      const angle = (slot / 8) * Math.PI * 2;
      const r = (ARENA_RADIUS * Math.cos(Math.PI / 8)) * 0.7;
      botState.posX = Math.cos(angle) * r;
      botState.posY = 0.6;
      botState.posZ = Math.sin(angle) * r;
      botState.velX = 0;
      botState.velY = 0;
      botState.velZ = 0;
      botState.yaw = Math.atan2(-Math.sin(angle), -Math.cos(angle));
      botState.speed = 0;
      botState.targetId = null;
      botState.nextRetargetAt = Date.now();
      // Fresh bots don't keep their old inventory/status through death.
      botState.heldPowerup = null;
      botState.powerupReadyAt = Date.now() + 1000;
      botState.powerupUseEarliest = 0;
      botState.glitchExpireAt = 0;
      botState.lastHitById = null;
      botState.revengeExpireAt = 0;

      this.room.broadcast(JSON.stringify({
        type: SRV.PLAYER_RESPAWN,
        playerId: botId,
        carType: player.carType,
        pos: [botState.posX, botState.posY, botState.posZ],
      }));
    }, 2000);
  }

  _onPlayerFell(data: any, sender: Party.Connection) {
    // Host can send falls on behalf of bots via playerId field
    let targetId = sender.id;
    if (sender.id === this.hostId && typeof data.playerId === 'string'
        && data.playerId.startsWith('bot_') && data.playerId.length <= 64) {
      targetId = data.playerId;
    }

    const player = this.players.get(targetId);
    if (!player || player.isEliminated) return;
    if (player.isInvincible) return;

    // Resolve KO attribution BEFORE applying damage so _handleElimination
    // (fired from _dealDamage) can credit the right killer. Falls still
    // count as "environmental" with an optional attributed killer if they
    // were hit recently enough.
    const killerId = (typeof data.lastHitById === 'string') ? data.lastHitById : null;
    const lastHitTime = (typeof data.lastHitTime === 'number') ? data.lastHitTime : 0;
    const withinWindow = lastHitTime > 0 && (Date.now() - lastHitTime) < GAME.KO_ATTRIBUTION_WINDOW_MS;
    const killer = (killerId && withinWindow) ? this.players.get(killerId) : null;
    const attacker = (killer && !killer.isEliminated) ? killer : null;

    this._dealDamage(player, GAME.FALL_DAMAGE, attacker, false);
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

    // Track defensive state so server-computed damage paths honor the
    // player's protection. Durations match client PowerUpManager:
    //   SHIELD     = 5.0s active, 0.5× damage reduction
    //   HOLO_EVADE = 1.3s (1.0 active + 0.3 fade), homing/turret decoy roll
    //   REPAIR_KIT = instant +30 HP
    if (data.powerupType === 'SHIELD') {
      player.hasShield = true;
      this._setShieldTimer(sender.id, 5000);
    } else if (data.powerupType === 'HOLO_EVADE') {
      player.holoEvadeActive = true;
      this._setHoloEvadeTimer(sender.id, 1300);
    } else if (data.powerupType === 'REPAIR_KIT') {
      // Keep the server's authoritative HP aligned with the client's
      // optimistic heal so later damage events compute against the
      // correct starting value.
      player.hp = Math.min(GAME.MAX_HP, player.hp + 30);
    } else if (data.powerupType === 'GLITCH_BOMB' && pos) {
      // AOE disruption on bots: human-fired glitch bombs should scramble
      // any bot inside the 18u blast radius (client parity). Damage itself
      // is still reported via POWERUP_DAMAGE — we only apply the AI effect.
      const now = Date.now();
      const glitchUntil = now + 5000;
      const r2 = 18 * 18;
      for (const [id, bot] of this._bots) {
        const dx = bot.posX - pos[0];
        const dz = bot.posZ - pos[2];
        if (dx * dx + dz * dz <= r2) {
          bot.glitchExpireAt = glitchUntil;
        }
      }
    }

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
    this._dealDamage(player, damage, null, false);
  }

  _onPowerupDamage(data: any, sender: Party.Connection) {
    // Host can send power-up damage on behalf of bots
    let attackerId = sender.id;
    if (sender.id === this.hostId && typeof data.attackerId === 'string'
        && data.attackerId.startsWith('bot_') && data.attackerId.length <= 64) {
      attackerId = data.attackerId;
    }
    const attacker = this.players.get(attackerId);
    if (!attacker || attacker.isEliminated) return;

    const { targetId } = data;
    if (typeof targetId !== 'string' || targetId.length > 64) return;

    const victim = this.players.get(targetId);
    if (!victim || victim.isEliminated || victim.isInvincible) return;

    const damage = typeof data.damage === 'number' && isFinite(data.damage)
      ? Math.min(Math.max(data.damage, 0), GAME.MAX_DAMAGE) : 0;
    if (damage <= 0) return;
    this._dealDamage(victim, damage, attacker, true);
  }

  _onEnvDamage(data: any, sender: Party.Connection) {
    // Host can send env damage on behalf of bots via playerId field
    let targetId = sender.id;
    if (sender.id === this.hostId && typeof data.playerId === 'string'
        && data.playerId.startsWith('bot_') && data.playerId.length <= 64) {
      targetId = data.playerId;
    }

    const player = this.players.get(targetId);
    if (!player || player.isEliminated || player.isInvincible) return;

    const damage = typeof data.damage === 'number' && isFinite(data.damage)
      ? Math.min(Math.max(data.damage, 0), GAME.MAX_DAMAGE) : 0;
    if (damage <= 0) return;
    this._dealDamage(player, damage, null, false);
  }

  _onRegisterBot(_data: any, _sender: Party.Connection) {
    // BUG 0 fix: bots are now server-simulated. Client REGISTER_BOT messages
    // are ignored — the server spawns and owns bots via _rebalanceBots().
    // Kept as a no-op handler to avoid breaking older clients during rollout.
  }

  _onObstacleDestroyed(data: any, sender: Party.Connection) {
    const player = this.players.get(sender.id);
    if (!player) return;

    const { x, y, z } = data;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;

    // Broadcast to all OTHER clients so they remove the obstacle too
    this.room.broadcast(JSON.stringify({
      type: SRV.OBSTACLE_DESTROYED,
      x, y, z,
    }), [sender.id]);
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
    if (!player.isEliminated) return;

    player.hp = GAME.MAX_HP;
    player.isEliminated = false;
    player.isInvincible = true;
    // Clear defensive power-up state so it doesn't persist across death.
    player.hasShield = false;
    player.holoEvadeActive = false;
    const sh = this.shieldTimers.get(sender.id); if (sh) { clearTimeout(sh); this.shieldTimers.delete(sender.id); }
    const he = this.holoEvadeTimers.get(sender.id); if (he) { clearTimeout(he); this.holoEvadeTimers.delete(sender.id); }
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

  /** Set or refresh the SHIELD reduction window for a player. */
  _setShieldTimer(playerId: string, ms: number) {
    const existing = this.shieldTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.shieldTimers.delete(playerId);
      const p = this.players.get(playerId);
      if (p) p.hasShield = false;
    }, ms);
    this.shieldTimers.set(playerId, handle);
  }

  /** Set or refresh the HOLO_EVADE decoy window for a player. */
  _setHoloEvadeTimer(playerId: string, ms: number) {
    const existing = this.holoEvadeTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.holoEvadeTimers.delete(playerId);
      const p = this.players.get(playerId);
      if (p) p.holoEvadeActive = false;
    }, ms);
    this.holoEvadeTimers.set(playerId, handle);
  }

  // ── Server tick: batch-broadcast player states ──────────────────────
  //
  // BUG 2+3+4 fix: emit ONE binary packet per tick containing every entity's
  // state plus a single server timestamp. The previous per-entity broadcast
  // produced N separate WebSocket messages that arrived in the same JS task
  // on the client — all collapsing to the same performance.now() timestamp,
  // which broke Hermite bracketing. With a single serverTime stamp, every
  // entry in the batch shares a precise authoritative time and the client
  // interpolates in server-clock space (immune to arrival jitter).

  _tickBroadcast() {
    // Build bot entries (BUG 0: server owns bot state).
    const botEntries: ArrayBuffer[] = [];
    for (const [botId, bot] of this._bots) {
      const player = this.players.get(botId);
      if (!player || player.isEliminated) continue;
      // Flag layout (matches client/src/network/protocol.js::unpackFlags):
      //   bit0 abilityActive, bit1 hasShield, bit2 hasRam, bit3 isStunned,
      //   bit4 driftMode, bit5 isInvincible, bit6 holoEvadeActive.
      // Server-simulated bots don't do drifts/stuns/abilities, so we only
      // set the bits whose state we actually track.
      let flags = 0;
      if (player.hasShield)       flags |= 0x02;
      if (player.isInvincible)    flags |= 0x20;
      if (player.holoEvadeActive) flags |= 0x40;
      botEntries.push(encodeBotEntry(bot, player.hp, flags));
    }

    if (this._stateBuffers.size === 0 && botEntries.length === 0) return;
    if (this.players.size === 0) return;

    // Compute total payload size. Human entries: skip leading 0x01 (1 byte).
    // Bot entries: already in batch-entry format (no leading msgType).
    let payloadBytes = 0;
    for (const [, { buffer }] of this._stateBuffers) {
      payloadBytes += buffer.byteLength - 1;
    }
    for (const e of botEntries) payloadBytes += e.byteLength;

    const headerBytes = 1 /*msgType*/ + 4 /*serverTime*/ + 1 /*count*/;
    const out = new ArrayBuffer(headerBytes + payloadBytes);
    const outView = new DataView(out);
    const outArr = new Uint8Array(out);

    outView.setUint8(0, BIN.PLAYER_STATE_BATCH);
    // serverTime: low 32 bits of Date.now() (ms since 1970 mod 2^32 ≈ every 49.7 days).
    // Client reads absolute value and only uses deltas, so rollover only matters
    // if a single session spans >24 days — not a concern here.
    outView.setUint32(1, Date.now() >>> 0, true);
    outView.setUint8(5, this._stateBuffers.size + botEntries.length);

    let cursor = headerBytes;
    for (const [, { buffer }] of this._stateBuffers) {
      const entryLen = buffer.byteLength - 1;
      outArr.set(new Uint8Array(buffer, 1, entryLen), cursor);
      cursor += entryLen;
    }
    for (const e of botEntries) {
      outArr.set(new Uint8Array(e), cursor);
      cursor += e.byteLength;
    }

    // Single broadcast to everyone. Each client filters out its own state
    // by playerId in _handleBinaryMessage (already does this).
    this.room.broadcast(out);
    this._stateBuffers.clear();
  }

  // ── Server-side bot simulation (BUG 0 fix) ──────────────────────────

  _stepBots() {
    const now = Date.now();
    const dtMs = now - this._lastBotStep;
    this._lastBotStep = now;
    if (this._bots.size === 0 && this._botProjectiles.length === 0 && this._botTurrets.length === 0) {
      return;
    }

    // Cap dt at 100ms in case the setInterval hiccups — otherwise bots
    // can integrate huge steps and fly out of the arena.
    const dt = Math.min(dtMs, 100) / 1000;

    // Build one authoritative snapshot of every entity for this tick. Every
    // AI/collision decision reads from the SAME snapshot so racing against
    // the wire order of client uploads doesn't produce inconsistent results.
    const snapshots = this._buildSnapshots();

    // Step AI + physics for each bot. Track hunter counts so target
    // selection naturally spreads bots across multiple victims (anti-gangup).
    const hunterCounts = new Map<string, number>();
    for (const [, bot] of this._bots) {
      const player = this.players.get(bot.botId);
      if (!player || player.isEliminated) continue;
      stepBot(bot, dt, snapshots, now, hunterCounts);
      player.lastStateTime = now;
    }

    // Bot↔player physical collisions — server-authoritative since bots have
    // no local client running cannon for them.
    this._detectBotCollisions(snapshots, now);

    // Power-up pickup + situational use. Fires real projectiles into the
    // server sim; damage (if any) comes from flight simulation, not a timer.
    this._stepBotPowerups(snapshots, now);

    // Step every active bot-fired projectile and turret. Hits are resolved
    // via swept-sphere against current snapshots, so a target that just
    // moved out of the way on their own client genuinely dodges.
    this._stepBotProjectiles(dt, snapshots, now);
    this._stepBotTurrets(dt, snapshots, now);
  }

  _buildSnapshots(): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const [, b] of this._bots) {
      const player = this.players.get(b.botId);
      out.push({
        id: b.botId,
        posX: b.posX, posY: b.posY, posZ: b.posZ,
        velX: b.velX, velZ: b.velZ,
        yaw: b.yaw,
        mass: player?.mass ?? 5,
        hp: player?.hp ?? GAME.MAX_HP,
        maxHp: GAME.MAX_HP,
        isEliminated: player?.isEliminated ?? false,
        isInvincible: player?.isInvincible ?? false,
        hasShield: player?.hasShield ?? false,
        holoEvadeActive: player?.holoEvadeActive ?? false,
        isBot: true,
      });
    }
    const decoder = new TextDecoder();
    for (const [, { buffer }] of this._stateBuffers) {
      const view = new DataView(buffer);
      const idLen = view.getUint8(1);
      const id = decoder.decode(new Uint8Array(buffer, 2, idLen));
      const s = 2 + idLen + 1; // skip [0x01][idLen][id][carType]
      const posX = _readFloat16(view, s + 0);
      const posY = _readFloat16(view, s + 2);
      const posZ = _readFloat16(view, s + 4);
      const velX = _readFloat16(view, s + 6);
      const velZ = _readFloat16(view, s + 10);
      const yaw  = _readFloat16(view, s + 12);
      const player = this.players.get(id);
      if (!player) continue;
      out.push({
        id, posX, posY, posZ, velX, velZ, yaw,
        mass: player.mass,
        hp: player.hp,
        maxHp: GAME.MAX_HP,
        isEliminated: player.isEliminated,
        isInvincible: player.isInvincible,
        hasShield: player.hasShield,
        holoEvadeActive: player.holoEvadeActive,
        isBot: false,
      });
    }
    return out;
  }

  // ── Bot↔player collision damage (BUG 0 restore) ──────────────────────
  //
  // The host used to detect these via its local cannon world. Now the server
  // owns bots, so we run a simple sphere overlap + approach-speed check on
  // every tick. A small radius (1.8m) approximates the car AABB and
  // pair-cooldown (1s) prevents re-applying damage while the entities stay
  // in contact.

  readonly _BOT_COLLIDE_RADIUS = 1.8;
  readonly _BOT_MIN_APPROACH = 3.0; // m/s — ignore glancing touches

  _detectBotCollisions(snapshots: PlayerSnapshot[], now: number) {
    for (const [, bot] of this._bots) {
      const botPlayer = this.players.get(bot.botId);
      if (!botPlayer || botPlayer.isEliminated) continue;

      for (const target of snapshots) {
        if (target.id === bot.botId) continue;
        if (target.isEliminated || target.isInvincible) continue;
        // Bots CAN damage each other — matches original client-simulated
        // behaviour. Only constraint is iteration order: each (a,b) pair
        // is visited twice (once from a, once from b), but the shared
        // pair-cooldown below dedupes the damage.

        const dx = target.posX - bot.posX;
        const dz = target.posZ - bot.posZ;
        const dist = Math.hypot(dx, dz);
        if (dist > this._BOT_COLLIDE_RADIUS || dist < 0.0001) continue;

        // Net approach speed (>0 = closing)
        const dxn = dx / dist;
        const dzn = dz / dist;
        // rate of change of |d| = (b.vel - p.vel) · d/|d| ; closing when <0.
        const closureRate = (bot.velX - target.velX) * dxn + (bot.velZ - target.velZ) * dzn;
        const approachSpeed = -closureRate;
        if (approachSpeed < this._BOT_MIN_APPROACH) continue;

        // Determine attacker = entity moving toward the other faster along
        // the normal. Bot velocity projected along -n (toward target):
        const botIn = -(bot.velX * dxn + bot.velZ * dzn);
        const pIn   =  (target.velX * dxn + target.velZ * dzn);
        const botIsAttacker = botIn >= pIn;

        const attacker = botIsAttacker ? botPlayer : this.players.get(target.id);
        const victim   = botIsAttacker ? this.players.get(target.id) : botPlayer;
        if (!attacker || !victim) continue;
        if (victim.isEliminated || victim.isInvincible) continue;

        // Pair cooldown (shared with human-reported collisions).
        const idA = attacker.id < victim.id ? attacker.id : victim.id;
        const idB = attacker.id < victim.id ? victim.id : attacker.id;
        const key = `${idA}-${idB}`;
        if ((this.pairCooldowns.get(key) || 0) > now) continue;
        this.pairCooldowns.set(key, now + GAME.PAIR_COOLDOWN_MS);

        // Angle factor — matches client CollisionHandler._angleFactor.
        // cos(angle between relative velocity and collision normal) scaled
        // to [0.3 .. 1.0]. Head-on = 1.0 full damage; glancing = 0.3.
        const relVelMag = Math.hypot(bot.velX - target.velX, bot.velZ - target.velZ);
        const cosAngle = relVelMag > 0.01 ? Math.max(0, approachSpeed / relVelMag) : 1.0;
        const angleFactor = GAME.ANGLE_MIN + (GAME.ANGLE_MAX - GAME.ANGLE_MIN) * cosAngle;

        this._applyPvpDamage(attacker, victim, approachSpeed, angleFactor, false);
      }
    }
  }

  /**
   * Shared pvp damage application — computes calcDamage from an approach
   * speed and defers to _dealDamage for reduction/broadcast/elimination.
   */
  _applyPvpDamage(
    attacker: PlayerData,
    victim: PlayerData,
    approachSpeed: number,
    angleFactor: number,
    wasAbility: boolean,
  ) {
    if (approachSpeed > GAME.MAX_VELOCITY * 1.5) return;
    const damage = calcDamage(approachSpeed, attacker.mass, victim.mass, angleFactor);
    if (damage <= 0) return;
    this._dealDamage(victim, damage, attacker, wasAbility);
  }

  /**
   * Single source of truth for applying damage to any victim.
   *
   *  - Applies SHIELD 50% reduction if the victim currently has shield up.
   *  - Applies invincibility guard (zero damage, no broadcast).
   *  - Updates HP, attacker hits/score/streak multiplier.
   *  - Broadcasts DAMAGE_DEALT.
   *  - Routes to _handleElimination if HP hit zero.
   *
   * Returns the final damage actually applied (0 when blocked).
   *
   * Every damage path on the server funnels through here so SHIELD
   * reduction stays consistent whether the damage originated from a
   * collision, a bot-fired missile, a human-reported power-up hit, the
   * lava pool, or a fall.
   */
  _dealDamage(
    victim: PlayerData,
    rawDamage: number,
    attacker: PlayerData | null,
    wasAbility: boolean,
  ): number {
    if (victim.isEliminated) return 0;
    if (victim.isInvincible) return 0;
    if (rawDamage <= 0) return 0;

    // SHIELD halves incoming damage (client constant _shieldDamageReduction=0.5).
    let dmg = victim.hasShield ? rawDamage * 0.5 : rawDamage;
    dmg = Math.min(dmg, GAME.MAX_DAMAGE);
    dmg = Math.round(dmg * 10) / 10;
    if (dmg <= 0) return 0;

    victim.hp = Math.max(0, victim.hp - dmg);

    // Feed revenge memory if the victim is a server bot and the attacker
    // is a DIFFERENT live entity. Matches client BotBrain._lastHitBy
    // tracking so bots pursue whoever wronged them for ~8s.
    if (attacker && attacker.id !== victim.id) {
      const victimBot = this._bots.get(victim.id);
      if (victimBot) {
        victimBot.lastHitById = attacker.id;
        victimBot.revengeExpireAt = Date.now() + 8000;
      }
    }

    let scoreDelta: number | undefined;
    if (attacker && !attacker.isEliminated) {
      attacker.hits++;
      const hitDelta = dmg >= GAME.SCORE_BIG_HIT_THRESHOLD
        ? GAME.SCORE_BIG_HIT : GAME.SCORE_SMALL_HIT;
      const hitMult = getStreakMultiplier(attacker.streak);
      scoreDelta = hitDelta * hitMult;
      attacker.score += scoreDelta;
    }

    this.room.broadcast(JSON.stringify({
      type: SRV.DAMAGE_DEALT,
      targetId: victim.id,
      amount: dmg,
      newHp: Math.round(victim.hp * 10) / 10,
      sourceId: attacker?.id ?? null,
      wasAbility,
      ...(scoreDelta !== undefined ? { scoreDelta } : {}),
    }));

    if (victim.hp <= 0) this._handleElimination(victim, attacker);
    return dmg;
  }

  // ── Bot power-up pickup + situational use ────────────────────────────
  //
  // Pickup: opportunistic proximity (2.5m from pedestal). Use: NOT a random
  // timer — the bot waits until the tactical situation warrants it (target
  // in the forward cone for MISSILE, enemies nearby for AOE, low HP for
  // REPAIR/SHIELD, etc.). There's still a short reaction delay after pickup
  // so bots don't fire the instant they grab something.

  readonly _BOT_PICKUP_RADIUS = 2.0; // matches client PICKUP_RADIUS constant

  _stepBotPowerups(snapshots: PlayerSnapshot[], now: number) {
    for (const [, bot] of this._bots) {
      const botPlayer = this.players.get(bot.botId);
      if (!botPlayer || botPlayer.isEliminated) continue;

      // 1) Pickup — empty-handed and off cooldown: grab any pedestal in range.
      if (!bot.heldPowerup && now >= bot.powerupReadyAt) {
        for (const [id, pedestal] of this.powerups) {
          if (!pedestal.type) continue;
          const dx = pedestal.position[0] - bot.posX;
          const dz = pedestal.position[2] - bot.posZ;
          if (Math.hypot(dx, dz) > this._BOT_PICKUP_RADIUS) continue;

          bot.heldPowerup = pedestal.type;
          // Reaction delay scales inversely with aggression: aggressive
          // bots react quickly (~350ms), cautious ones take their time (~900ms).
          const reaction = 900 - Math.floor(bot.aggression * 550);
          bot.powerupUseEarliest = now + reaction;
          const type = pedestal.type;
          pedestal.type = null;
          pedestal.respawnAt = now + GAME.POWERUP_RESPAWN_MS;
          this.room.broadcast(JSON.stringify({
            type: SRV.POWERUP_TAKEN,
            id,
            playerId: bot.botId,
            powerupType: type,
          }));
          break;
        }
      }

      // 2) Use — only when the situation says so (not random timer).
      if (bot.heldPowerup) {
        if (shouldUsePowerup(bot, botPlayer.hp, GAME.MAX_HP, bot.heldPowerup, snapshots, now)) {
          const type = bot.heldPowerup;
          bot.heldPowerup = null;
          bot.powerupReadyAt = now + 500;
          this._useBotPowerup(bot, botPlayer, type, snapshots, now);
        } else if (now - bot.powerupUseEarliest > 12000) {
          // Safety valve: if we've been sitting on a power-up for 12s
          // without a good moment, release it so the bot can grab something
          // more situationally useful next time.
          bot.heldPowerup = null;
          bot.powerupReadyAt = now + 1500;
        }
      }
    }
  }

  _useBotPowerup(
    bot: BotPhysicsState,
    botPlayer: PlayerData,
    type: string,
    _snapshots: PlayerSnapshot[],
    now: number,
  ) {
    // Broadcast visual event to every client — they animate the effect
    // from the fire point. Actual damage (for projectiles) is decided by
    // the server-side flight sim that starts on the next tick.
    this.room.broadcast(JSON.stringify({
      type: SRV.POWERUP_USED,
      playerId: bot.botId,
      powerupType: type,
      pos: [bot.posX, bot.posY, bot.posZ],
    }));

    switch (type) {
      case 'REPAIR_KIT': {
        // Instant heal matching client: +30 HP capped at max.
        botPlayer.hp = Math.min(GAME.MAX_HP, botPlayer.hp + 30);
        break;
      }
      case 'SHIELD': {
        // SHIELD = 50% damage reduction for 5s (NOT invincibility).
        // _dealDamage reads hasShield and halves incoming damage.
        botPlayer.hasShield = true;
        this._setShieldTimer(bot.botId, 5000);
        break;
      }
      case 'HOLO_EVADE': {
        // HOLO_EVADE = 1.3s decoy window (1.0s active + 0.3s fade).
        // Does NOT grant invincibility — the real car still takes full
        // damage. Only effect: incoming homing missiles / turret acquisition
        // have a 50% chance to lock onto a decoy (see projectilesim.ts).
        botPlayer.holoEvadeActive = true;
        this._setHoloEvadeTimer(bot.botId, 1300);
        break;
      }
      case 'MISSILE': {
        this._botProjectiles.push(
          spawnMissile(bot.botId, bot.posX, bot.posY + 0.6, bot.posZ, bot.yaw, bot.speed, now),
        );
        break;
      }
      case 'HOMING_MISSILE': {
        this._botProjectiles.push(
          spawnHomingMissile(bot.botId, bot.posX, bot.posY + 0.6, bot.posZ, bot.yaw, now),
        );
        break;
      }
      case 'AUTO_TURRET': {
        this._botTurrets.push(
          spawnTurret(bot.botId, bot.posX, bot.posY, bot.posZ, bot.yaw, now),
        );
        break;
      }
      case 'GLITCH_BOMB': {
        // Instant AOE — matches client constants: 18u radius, 10 HP damage.
        this._botDetonateGlitch(bot, botPlayer, now);
        break;
      }
      default:
        break;
    }
  }

  _botDetonateGlitch(bot: BotPhysicsState, attacker: PlayerData, now: number) {
    // Matches client constants: 18u radius, 10 HP light damage. Instant AOE.
    // Victims that are bots get their AI scrambled for 5s (client parity
    // with BotBrain._applyGlitchDisruption).
    const snapshots = this._buildSnapshots();
    const radius = 18;
    const r2 = radius * radius;
    const damage = 10;
    const glitchUntil = now + 5000;
    for (const s of snapshots) {
      if (s.id === bot.botId) continue;
      const dx = s.posX - bot.posX;
      const dz = s.posZ - bot.posZ;
      if (dx * dx + dz * dz > r2) continue;
      const victim = this.players.get(s.id);
      if (!victim) continue;
      this._dealDamage(victim, damage, attacker, true);
      // Disrupt any bot in the blast radius.
      const victimBot = this._bots.get(s.id);
      if (victimBot) victimBot.glitchExpireAt = glitchUntil;
    }
  }

  // ── Bot projectile + turret stepping ─────────────────────────────────

  _stepBotProjectiles(dt: number, snapshots: PlayerSnapshot[], now: number) {
    if (this._botProjectiles.length === 0) return;
    const kept: ServerProjectile[] = [];
    for (const proj of this._botProjectiles) {
      const alive = stepProjectile(proj, dt, snapshots, now);
      if (!alive) continue;
      const victim = sweepProjectileHit(proj, dt, snapshots, now);
      if (victim) {
        this._resolveProjectileHit(proj, victim);
        // Projectile consumed on impact (matches client behavior).
        continue;
      }
      kept.push(proj);
    }
    this._botProjectiles = kept;
  }

  _stepBotTurrets(dt: number, snapshots: PlayerSnapshot[], now: number) {
    if (this._botTurrets.length === 0) return;
    const kept: ServerTurret[] = [];
    for (const t of this._botTurrets) {
      const { alive, emit } = stepTurret(t, dt, snapshots, now);
      if (emit) this._botProjectiles.push(emit);
      if (alive) kept.push(t);
    }
    this._botTurrets = kept;
  }

  _resolveProjectileHit(proj: ServerProjectile, victim: PlayerSnapshot) {
    const attacker = this.players.get(proj.attackerId);
    const victimPlayer = this.players.get(victim.id);
    if (!attacker || !victimPlayer) return;
    // Reductions/guards all live in _dealDamage.
    this._dealDamage(victimPlayer, proj.damage, attacker, true);
  }

  /**
   * Ensure bot population matches current human count. Called when a human
   * joins or leaves. Spawns bots in empty slots up to TARGET_PLAYERS and
   * keeps at least MIN_BOTS if the room has any human.
   */
  _rebalanceBots() {
    const humanCount = Array.from(this.players.values()).filter(p => !p.id.startsWith('bot_')).length;
    if (humanCount === 0) {
      // Empty room — despawn all bots to save compute.
      for (const id of Array.from(this._bots.keys())) this._despawnBot(id);
      return;
    }
    const targetBots = Math.min(
      this.MAX_BOTS,
      Math.max(this.MIN_BOTS, this.TARGET_PLAYERS - humanCount),
    );

    // Despawn excess first (prefer eliminated bots)
    while (this._bots.size > targetBots) {
      let victim: string | null = null;
      for (const [id] of this._bots) {
        const p = this.players.get(id);
        if (p?.isEliminated) { victim = id; break; }
      }
      if (!victim) victim = this._bots.keys().next().value as string;
      this._despawnBot(victim);
    }

    // Spawn new bots until we hit target
    while (this._bots.size < targetBots) {
      this._spawnBot();
    }
  }

  _spawnBot() {
    const names = ['ACE','BLITZ','NOVA','ORBIT','QUASAR','RAZOR','SABER','TITAN','VOLT','ZEPH'];
    // Pick an unused name
    let name = names[Math.floor(Math.random() * names.length)];
    let i = 0;
    while (this.players.has(`bot_${name}`) && i < 20) {
      name = names[Math.floor(Math.random() * names.length)] + '_' + (Math.floor(Math.random() * 99));
      i++;
    }
    const botId = `bot_${name}`;
    const carTypes = Object.keys(CAR_STATS);
    const carType = carTypes[Math.floor(Math.random() * carTypes.length)];
    const slotIndex = this._bots.size;

    this._bots.set(botId, createBot(botId, carType, slotIndex));
    const bot: PlayerData = {
      id: botId,
      nickname: name,
      carType,
      hp: GAME.MAX_HP,
      mass: getCarMass(carType),
      isEliminated: false,
      isInvincible: true,
      hasShield: false,
      holoEvadeActive: false,
      score: 0, kills: 0, deaths: 0, streak: 0, hits: 0,
      lastStateTime: Date.now(),
    };
    this.players.set(botId, bot);
    this._setInvincibilityTimer(botId, 1500);

    // Tell all clients the bot exists.
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_JOINED,
      id: botId,
      nickname: name,
      carType,
    }));
  }

  _despawnBot(botId: string) {
    this._bots.delete(botId);
    this.players.delete(botId);
    this._binaryRateLimit.delete(botId);
    this.room.broadcast(JSON.stringify({
      type: SRV.PLAYER_LEFT,
      id: botId,
    }));
  }

  // ── Power-up respawns ────────────────────────────────────────────────

  _checkPowerupRespawns() {
    const now = Date.now();
    for (const [id, pedestal] of this.powerups) {
      if (!pedestal.type && pedestal.respawnAt && now >= pedestal.respawnAt) {
        // Clear respawnAt first to prevent re-entry from a concurrent pickup
        pedestal.respawnAt = null;
        // Re-check that pedestal is still empty (a pickup could have raced)
        if (pedestal.type) continue;
        pedestal.type = randomPowerupType();
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
