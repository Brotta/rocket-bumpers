import PartySocket from 'partysocket';
import { MSG, SRV, encodePlayerState, decodePlayerUpdate } from './protocol.js';
import { NETWORK } from '../core/Config.js';

/**
 * NetworkManager — manages WebSocket connection to PartyKit server,
 * handles message encoding/decoding, and dispatches events to Game.js.
 *
 * Usage:
 *   const net = new NetworkManager(game);
 *   await net.connect(roomId, nickname, carType);
 *   // In fixed update (every 3rd tick):
 *   net.sendPlayerState(localCarBody);
 *   // Listen:
 *   net.on('playerJoined', ({ id, nickname, carType }) => ...);
 */
export class NetworkManager {
  constructor(game) {
    this.game = game;
    this._socket = null;
    this._listeners = {};
    this._connected = false;
    this._localPlayerId = null;
    this._roomId = null;
    this._hostId = null;

    // Send rate throttle
    this._sendCounter = 0;
    this._sendInterval = Math.round(60 / NETWORK.sendRate); // ticks between sends (3 for 20Hz)

    // Reconnection
    this._reconnectAttempts = 0;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  /**
   * Connect to a PartyKit room.
   * @returns {Promise<object>} Resolves with room state on success.
   */
  connect(roomId, nickname, carType) {
    this._roomId = roomId;

    return new Promise((resolve, reject) => {
      const host = NETWORK.partyKitHost;

      // Connection timeout — reject if no ROOM_STATE within 10s
      const timeout = setTimeout(() => {
        reject(new Error('Connection timed out'));
        this.disconnect();
      }, 10000);

      this._socket = new PartySocket({
        host,
        room: roomId,
      });

      this._socket.binaryType = 'arraybuffer';

      // Store bound handlers so we can remove them on disconnect
      this._onOpen = () => {
        this._connected = true;
        this._reconnectAttempts = 0;

        // Send join message
        this._sendJSON({
          type: MSG.PLAYER_JOIN,
          nickname,
          carType,
        });
      };

      this._onMessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this._handleBinaryMessage(event.data);
          return;
        }

        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        // ROOM_FULL — server says this room is full, redirect
        if (data.type === SRV.ROOM_FULL) {
          clearTimeout(timeout);
          this._socket.close();
          this._socket = null;
          reject({ roomFull: true, suggestedRoom: data.suggestedRoom });
          return;
        }

        // ROOM_STATE is the first message after join — resolves the connect promise
        if (data.type === SRV.ROOM_STATE) {
          clearTimeout(timeout);
          this._localPlayerId = data.playerId;
          this._hostId = data.hostId;
          this._emit('connected', data);
          resolve(data);
          return;
        }

        this._handleJSONMessage(data);
      };

      this._onClose = () => {
        this._connected = false;
        this._emit('disconnected', {});
      };

      this._onError = (err) => {
        if (!this._connected) {
          clearTimeout(timeout);
          reject(err);
        }
      };

      this._socket.addEventListener('open', this._onOpen);
      this._socket.addEventListener('message', this._onMessage);
      this._socket.addEventListener('close', this._onClose);
      this._socket.addEventListener('error', this._onError);
    });
  }

  disconnect() {
    if (this._socket) {
      // Remove all event listeners before closing to prevent leaks
      if (this._onOpen) this._socket.removeEventListener('open', this._onOpen);
      if (this._onMessage) this._socket.removeEventListener('message', this._onMessage);
      if (this._onClose) this._socket.removeEventListener('close', this._onClose);
      if (this._onError) this._socket.removeEventListener('error', this._onError);
      this._socket.close();
      this._socket = null;
    }
    this._onOpen = null;
    this._onMessage = null;
    this._onClose = null;
    this._onError = null;
    this._connected = false;
    this._localPlayerId = null;
    this._hostId = null;
    this._listeners = {};
  }

  // ── Getters ───────────────────────────────────────────────────────────

  get isConnected() { return this._connected; }
  get isHost() { return this._localPlayerId === this._hostId; }
  get localPlayerId() { return this._localPlayerId; }
  get roomId() { return this._roomId; }
  get isMultiplayer() { return this._connected; }

  // ── Send methods (called by Game.js) ──────────────────────────────────

  /**
   * Called every fixed update tick. Sends player state at the configured
   * network send rate (every 3rd tick for 20Hz).
   */
  tickAndMaybeSend(localCarBody) {
    if (!this._connected) return;
    this._sendCounter++;
    if (this._sendCounter % this._sendInterval !== 0) return;
    this._sendBinary(encodePlayerState(localCarBody));
  }

  /**
   * Send bot states (host only). Only sends on the same throttled ticks as
   * the local player state (called right after tickAndMaybeSend).
   */
  sendBotStates(bots) {
    if (!this._connected || !this.isHost) return;
    // Only send on the same tick that tickAndMaybeSend sent (throttle aligned)
    if (this._sendCounter % this._sendInterval !== 0) return;
    for (const bot of bots) {
      if (!bot.carBody) continue;
      this._sendBinary(encodePlayerState(bot.carBody));
    }
  }

  sendCollision(targetId, approachSpeed, attackerMass, victimMass, angleFactor, wasAbility) {
    this._sendJSON({
      type: MSG.COLLISION,
      targetId,
      approachSpeed,
      attackerMass,
      victimMass,
      angleFactor,
      wasAbility,
    });
  }

  sendPickupRequest(powerupId) {
    this._sendJSON({
      type: MSG.PICKUP_POWERUP,
      powerupId,
    });
  }

  sendPowerUpUsed(powerupType, pos) {
    this._sendJSON({
      type: MSG.USE_POWERUP,
      powerupType,
      pos,
    });
  }

  sendAbilityUsed(abilityType, pos) {
    this._sendJSON({
      type: MSG.USE_ABILITY,
      abilityType,
      pos,
    });
  }

  sendObstacleDamage(damage) {
    this._sendJSON({
      type: MSG.OBSTACLE_DAMAGE,
      damage,
    });
  }

  sendPlayerFell(lastHitById) {
    this._sendJSON({
      type: MSG.PLAYER_FELL,
      lastHitById,
    });
  }

  sendChangeCar(carType) {
    this._sendJSON({
      type: MSG.CHANGE_CAR,
      carType,
    });
  }

  sendPlayerRespawn(carType, pos) {
    this._sendJSON({
      type: MSG.PLAYER_RESPAWN,
      carType,
      pos,
    });
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

  // ── Message handling ──────────────────────────────────────────────────

  _handleBinaryMessage(buffer) {
    // Don't process binary state before we know our own ID (ROOM_STATE not yet received)
    if (!this._localPlayerId) return;

    const update = decodePlayerUpdate(buffer);
    if (!update) return;

    // Don't process our own state back
    if (update.playerId === this._localPlayerId) return;

    // Emit: { playerId, carType, state }
    this._emit('remotePlayerState', update);
  }

  _handleJSONMessage(data) {
    switch (data.type) {
      case SRV.PLAYER_JOINED:
        this._emit('playerJoined', data);
        break;

      case SRV.PLAYER_LEFT:
        this._emit('playerLeft', data);
        break;

      case SRV.DAMAGE_DEALT:
        this._emit('damageDealt', data);
        break;

      case SRV.PLAYER_ELIMINATED:
        this._emit('playerEliminated', data);
        break;

      case SRV.POWERUP_SPAWNED:
        this._emit('powerupSpawned', data);
        break;

      case SRV.POWERUP_TAKEN:
        this._emit('powerupTaken', data);
        break;

      case SRV.PICKUP_DENIED:
        this._emit('pickupDenied', data);
        break;

      case SRV.POWERUP_USED:
        this._emit('powerupUsed', data);
        break;

      case SRV.ABILITY_USED:
        this._emit('abilityUsed', data);
        break;

      case SRV.PLAYER_RESPAWN:
        this._emit('playerRespawn', data);
        break;

      case SRV.HOST_CHANGED:
        this._hostId = data.newHostId;
        this._emit('hostChanged', data);
        break;

      case SRV.SCORE_UPDATE:
        this._emit('scoreUpdate', data);
        break;
    }
  }

  // ── Transport helpers ─────────────────────────────────────────────────

  _sendJSON(data) {
    if (!this._socket || !this._connected) return;
    this._socket.send(JSON.stringify(data));
  }

  _sendBinary(buffer) {
    if (!this._socket || !this._connected) return;
    this._socket.send(buffer);
  }
}
