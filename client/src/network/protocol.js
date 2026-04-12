// ── Message type constants (must match server/protocol.ts) ─────────────

// Client → Server
export const MSG = {
  PLAYER_JOIN: 'PLAYER_JOIN',
  COLLISION: 'COLLISION',
  PICKUP_POWERUP: 'PICKUP_POWERUP',
  USE_POWERUP: 'USE_POWERUP',
  USE_ABILITY: 'USE_ABILITY',
  PLAYER_FELL: 'PLAYER_FELL',
  CHANGE_CAR: 'CHANGE_CAR',
  PLAYER_RESPAWN: 'PLAYER_RESPAWN',
  OBSTACLE_DAMAGE: 'OBSTACLE_DAMAGE',
  PLAYER_STATE_BIN: 0x01,
};

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
};

// ── Float16 encoding/decoding ──────────────────────────────────────────
// Uses DataView.setFloat16/getFloat16 if available (Chrome 120+),
// otherwise falls back to manual conversion.

const _hasNativeFloat16 = typeof DataView.prototype.getFloat16 === 'function';

export function writeFloat16(view, offset, value) {
  if (_hasNativeFloat16) {
    view.setFloat16(offset, value, true);
  } else {
    view.setUint16(offset, _float32ToFloat16Bits(value), true);
  }
}

export function readFloat16(view, offset) {
  if (_hasNativeFloat16) {
    return view.getFloat16(offset, true);
  }
  return _float16BitsToFloat32(view.getUint16(offset, true));
}

// Manual float16 conversion (IEEE 754 half-precision)
function _float32ToFloat16Bits(val) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const bits = u32[0];
  const sign = (bits >> 16) & 0x8000;
  const exp = ((bits >> 23) & 0xff) - 127 + 15;
  const frac = (bits >> 13) & 0x03ff;

  if (exp <= 0) return sign; // underflow → 0
  if (exp >= 31) return sign | 0x7c00; // overflow → infinity
  return sign | (exp << 10) | frac;
}

function _float16BitsToFloat32(h) {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;

  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    // Subnormal
    let val = frac / 1024;
    return (sign ? -1 : 1) * val * Math.pow(2, -14);
  }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);

  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// ── Car type index mapping ─────────────────────────────────────────────
import { CAR_ORDER } from '../core/Config.js';

const _carTypeToIndex = new Map();
CAR_ORDER.forEach((key, i) => _carTypeToIndex.set(key, i));

// ── Binary state encoding ──────────────────────────────────────────────

/**
 * Encode a car's state into a variable-length ArrayBuffer for network transmission.
 * Includes the entity's playerId so the server can relay it correctly
 * (critical for host-sent bot states).
 *
 * Layout:
 *   [0]         msgType (0x01)
 *   [1]         entityIdLen (N)
 *   [2..2+N-1]  entityId (UTF-8 bytes)
 *   [2+N]       carTypeIndex (uint8)
 *   [3+N..20+N] state: posX/Y/Z, velX/Y/Z, yaw, speed (float16 each), flags, hp (uint8 each)
 *   Total: 3 + N + 18 bytes
 */
export function encodePlayerState(carBody) {
  const entityIdBytes = _textEncoder.encode(carBody.playerId || 'unknown');
  const buf = new ArrayBuffer(3 + entityIdBytes.length + 18);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);
  const pos = carBody.body.position;
  const vel = carBody.body.velocity;

  view.setUint8(0, MSG.PLAYER_STATE_BIN);
  view.setUint8(1, entityIdBytes.length);
  arr.set(entityIdBytes, 2);

  const s = 2 + entityIdBytes.length; // state start offset
  view.setUint8(s, _carTypeToIndex.get(carBody.carType) ?? 0);
  writeFloat16(view, s + 1, pos.x);
  writeFloat16(view, s + 3, pos.y);
  writeFloat16(view, s + 5, pos.z);
  writeFloat16(view, s + 7, vel.x);
  writeFloat16(view, s + 9, vel.y);
  writeFloat16(view, s + 11, vel.z);
  writeFloat16(view, s + 13, carBody._yaw);
  writeFloat16(view, s + 15, carBody._currentSpeed);

  // Flags bitfield
  let flags = 0;
  const ability = carBody._abilityRef; // set by Game.js
  if (ability && ability.isActive) flags |= 1;
  if (carBody.hasShield) flags |= 2;
  if (carBody.hasRam) flags |= 4;
  if (carBody._isStunned) flags |= 8;
  if (carBody.driftMode) flags |= 16;
  if (carBody.isInvincible) flags |= 32;
  if (carBody.holoEvadeActive) flags |= 64;
  view.setUint8(s + 17, flags);
  view.setUint8(s + 18, Math.round(carBody.hp));

  return buf;
}

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

/**
 * Decode a player state update from the server.
 * Format: [msgType:1][entityIdLen:1][entityId:N][carTypeIndex:1][state:18]
 * Returns { playerId, carType, state } or null.
 */
export function decodePlayerUpdate(buffer) {
  const view = new DataView(buffer);
  const arr = new Uint8Array(buffer);

  if (view.getUint8(0) !== MSG.PLAYER_STATE_BIN) return null;
  const idLen = view.getUint8(1);
  if (buffer.byteLength < 3 + idLen + 18) return null;

  const playerId = _textDecoder.decode(arr.slice(2, 2 + idLen));
  const s = 2 + idLen; // state start offset
  const carTypeIndex = view.getUint8(s);

  const state = {
    posX: readFloat16(view, s + 1),
    posY: readFloat16(view, s + 3),
    posZ: readFloat16(view, s + 5),
    velX: readFloat16(view, s + 7),
    velY: readFloat16(view, s + 9),
    velZ: readFloat16(view, s + 11),
    yaw: readFloat16(view, s + 13),
    speed: readFloat16(view, s + 15),
    flags: view.getUint8(s + 17),
    hp: view.getUint8(s + 18),
  };

  return { playerId, carType: CAR_ORDER[carTypeIndex] || CAR_ORDER[0], state };
}

/**
 * Unpack flags bitfield into named booleans.
 */
export function unpackFlags(flags) {
  return {
    abilityActive: !!(flags & 1),
    hasShield: !!(flags & 2),
    hasRam: !!(flags & 4),
    isStunned: !!(flags & 8),
    driftMode: !!(flags & 16),
    isInvincible: !!(flags & 32),
    holoEvadeActive: !!(flags & 64),
  };
}
