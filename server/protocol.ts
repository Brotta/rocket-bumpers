// ── Message type constants ─────────────────────────────────────────────

// Client → Server
export const MSG = {
  // JSON messages
  PLAYER_JOIN: 'PLAYER_JOIN',
  COLLISION: 'COLLISION',
  PICKUP_POWERUP: 'PICKUP_POWERUP',
  USE_POWERUP: 'USE_POWERUP',
  USE_ABILITY: 'USE_ABILITY',
  PLAYER_FELL: 'PLAYER_FELL',
  CHANGE_CAR: 'CHANGE_CAR',
  PLAYER_RESPAWN: 'PLAYER_RESPAWN',
  OBSTACLE_DAMAGE: 'OBSTACLE_DAMAGE',
  POWERUP_DAMAGE: 'POWERUP_DAMAGE',
  ENV_DAMAGE: 'ENV_DAMAGE',
  OBSTACLE_DESTROYED: 'OBSTACLE_DESTROYED',
  REGISTER_BOT: 'REGISTER_BOT',

  // Binary message type byte (client → server: per-entity state upload)
  PLAYER_STATE_BIN: 0x01,
} as const;

// Server → Client binary message types
export const BIN = {
  // Batch of all entity states for one server tick (BUG 2+3 fix).
  // Layout: [0x02:u8][serverTimeLow:u32 LE][count:u8][entry...]
  // Entry:  [idLen:u8][id:N][carType:u8][pos/vel/yaw/speed:16 bytes float16][flags:u8][hp:u8]
  PLAYER_STATE_BATCH: 0x02,
} as const;

// Server → Client
export const SRV = {
  ROOM_STATE: 'ROOM_STATE',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  PLAYER_UPDATE: 'PLAYER_UPDATE',
  DAMAGE_DEALT: 'DAMAGE_DEALT',
  PLAYER_ELIMINATED: 'PLAYER_ELIMINATED',
  POWERUP_SPAWNED: 'POWERUP_SPAWNED',
  POWERUP_TAKEN: 'POWERUP_TAKEN',
  PICKUP_DENIED: 'PICKUP_DENIED',
  POWERUP_USED: 'POWERUP_USED',
  ABILITY_USED: 'ABILITY_USED',
  PLAYER_RESPAWN: 'PLAYER_RESPAWN',
  HOST_CHANGED: 'HOST_CHANGED',
  SCORE_UPDATE: 'SCORE_UPDATE',
  ROOM_FULL: 'ROOM_FULL',
  OBSTACLE_DESTROYED: 'OBSTACLE_DESTROYED',
  // Broadcast when a destructible edge barrier regenerates after its
  // respawn delay. Payload: { edgeIdx, segIdx } — the client uses these
  // indices to rebuild the matching physics body + visual.
  BARRIER_RESPAWN: 'BARRIER_RESPAWN',
  // Emitted when the server detects a bot-involved car-to-car collision.
  // Drives comic impact VFX/SFX on clients — the client collision handler
  // never fires for remote-vs-remote bodies, so without this broadcast a
  // bot↔bot crash produces no sparks, screen flash or POW text.
  CAR_IMPACT: 'CAR_IMPACT',
} as const;

// ── Shared game constants (must match client Config.js) ────────────────

export const GAME = {
  MAX_VELOCITY: 45,
  PAIR_COOLDOWN_MS: 1000,
  POWERUP_RESPAWN_MS: 8000,
  MAX_HP: 100,
  MAX_PLAYERS: 16,
  MAX_BOTS: 7,

  // Damage formula constants
  BASE_DAMAGE: 16,
  REF_SPEED: 15,
  MIN_SPEED: 3,
  MIN_DAMAGE: 2,
  MAX_DAMAGE: 80,
  ANGLE_MIN: 0.3,
  ANGLE_MAX: 1.0,
  ARMOR_FACTOR: 0.08,

  // Hit tier thresholds — must match client/src/core/Config.js
  TIER_HEAVY: 10,
  TIER_DEVASTATING: 25,

  // Scoring
  SCORE_KO: 100,
  SCORE_BIG_HIT: 25,
  SCORE_SMALL_HIT: 10,
  SCORE_DEATH: -50,
  SCORE_BIG_HIT_THRESHOLD: 20,
  SCORE_STREAK_2X: 3,
  SCORE_STREAK_3X: 5,

  // Environmental damage
  FALL_DAMAGE: 25,
  KO_ATTRIBUTION_WINDOW_MS: 3000,
} as const;
