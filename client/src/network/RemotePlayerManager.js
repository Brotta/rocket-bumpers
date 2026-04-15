import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildCar, animateWheels } from '../rendering/CarFactory.js';
import { InterpolationBuffer } from './InterpolationBuffer.js';
import { unpackFlags } from './protocol.js';
import { NETWORK, COLLISION_GROUPS, STAT_MAP, CARS } from '../core/Config.js';
const _snapThresholdSq = NETWORK.snapThreshold * NETWORK.snapThreshold;
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * RemotePlayerManager — manages visual representations of remote players.
 *
 * Remote players do NOT have physics bodies in the CANNON world.
 * Their meshes are positioned directly by the interpolation system.
 *
 * State updates for unknown players are queued. The game loop calls
 * processPendingAdds() once per frame to create them without blocking
 * the WebSocket message handler.
 */
export class RemotePlayerManager {
  constructor(game) {
    this.game = game;
    this._players = new Map();

    // Queue for players we've seen in binary state but haven't created yet.
    // Key: playerId, Value: { nickname, carType }
    this._pendingQueue = new Map();

    // Set of playerIds currently being loaded (async buildCar in flight)
    this._loading = new Set();

    // Buffer states for players being loaded so they aren't dropped
    // Key: playerId, Value: state[] (last few states)
    this._pendingStates = new Map();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Add a remote player to the scene.
   * @returns {Promise<object>} The remote player entry.
   */
  async addPlayer(playerId, nickname, carType) {
    if (this._players.has(playerId)) {
      const existing = this._players.get(playerId);
      // playerJoined may arrive after the player was already created from
      // the pending queue with a placeholder nickname. Update the nickname
      // and name tag DOM element with the real value.
      if (nickname && existing.nickname !== nickname) {
        existing.nickname = nickname;
        // Update the DOM name tag element via the NameTags manager
        const tag = this.game.nameTags._tags.get(existing);
        if (tag) {
          tag.textContent = nickname;
          // Recalculate cached dimensions since text changed
          tag._cachedW = 0;
          tag._cachedH = 0;
          requestAnimationFrame(() => {
            tag._cachedW = tag.offsetWidth;
            tag._cachedH = tag.offsetHeight;
          });
        }
      }
      return existing;
    }

    const mesh = await buildCar(carType);
    // Check again after async — might have been added by another call
    if (this._players.has(playerId)) {
      // Duplicate — dispose the mesh we just built
      mesh.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
      return this._players.get(playerId);
    }

    this.game.sceneManager.scene.add(mesh);

    // Create kinematic CANNON body so collision detection works
    const carDef = CARS[carType] || CARS.FANG;
    const mass = STAT_MAP.mass[carDef.stats.mass] || 5;
    const halfExtents = new CANNON.Vec3(1.0, 0.6, 0.6);
    const physBody = new CANNON.Body({
      mass: 0, // kinematic
      type: CANNON.Body.KINEMATIC,
      shape: new CANNON.Box(halfExtents),
      position: new CANNON.Vec3(0, 0.6, 0),
      collisionFilterGroup: COLLISION_GROUPS.CAR,
      collisionFilterMask: COLLISION_GROUPS.CAR, // only collide with other cars, not floor/obstacles
      collisionResponse: true, // must be true for CANNON to fire 'collide' events
    });
    physBody.mass = mass; // store real mass for damage calculation
    this.game.physicsWorld.world.addBody(physBody);

    const entry = {
      mesh,
      carType,
      nickname,
      playerId,
      buffer: new InterpolationBuffer(10, NETWORK.interpolationBuffer),
      hp: 100,
      isEliminated: false,
      _eliminationEmitted: false,
      _eliminationHandled: false,
      flags: {},
      _yaw: 0,
      _currentSpeed: 0,
      _steerAngle: 0,
      driftMode: false,
      // Real CANNON body for collision detection
      body: physBody,
      isInvincible: false,
      hasShield: false,
      hasRam: false,
      _isStunned: false,
      _stunImmunityTimer: 0,
      holoEvadeActive: false,
      speedMultiplier: 1,
      _internalVelX: 0,
      _internalVelZ: 0,
      _lastSetVelX: 0,
      _lastSetVelZ: 0,
      _isFalling: false,
      lastHitBy: null,
      maxSpeed: STAT_MAP.speed[carDef.stats.speed] || 20,
      // Flag to distinguish from real CarBody instances
      _isRemote: true,
      // Stub methods that CollisionHandler or other systems might call
      takeDamage() { return 0; }, // damage handled by server
      resetState() {},
      resetHP() {},
      onEliminated: null,
    };

    this._players.set(playerId, entry);

    // Add to game.carBodies so CollisionHandler detects collisions
    this.game.carBodies.push(entry);

    this.game.nameTags.add(entry, false);
    this.game.healthBars.add(entry, false);
    // NOTE: remote players are NOT registered with sampleEngineAudio.
    // The GearSimulator expects CarBody properties (maxSpeed, speedMultiplier,
    // _accelInput) that remote entries don't have. Spatial engine audio for
    // remote players can be added later with a lightweight adapter.

    return entry;
  }

  removePlayer(playerId) {
    // Also clean up from pending queues (PLAYER_LEFT may arrive before creation)
    this._pendingQueue.delete(playerId);
    this._pendingStates.delete(playerId);
    this._loading.delete(playerId);

    const entry = this._players.get(playerId);
    if (!entry) return;

    this.game.nameTags.remove(entry);
    this.game.healthBars.remove(entry);
    this.game.sceneManager.scene.remove(entry.mesh);

    // Remove kinematic physics body
    if (entry.body && entry.body instanceof CANNON.Body) {
      this.game.physicsWorld.world.removeBody(entry.body);
    }

    // Remove from game.carBodies
    const idx = this.game.carBodies.indexOf(entry);
    if (idx !== -1) this.game.carBodies.splice(idx, 1);

    entry.mesh.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    });
    this._players.delete(playerId);
  }

  getPlayer(playerId) {
    return this._players.get(playerId) || null;
  }

  getAllPlayers() {
    return Array.from(this._players.values());
  }

  hasPlayer(playerId) {
    return this._players.has(playerId);
  }

  // ── State updates (SYNCHRONOUS — safe to call from message handler) ───

  /**
   * Push a state snapshot. If the player exists, buffers it immediately.
   * If not, queues it for creation in the next processPendingAdds() call.
   */
  updatePlayerState(playerId, state, carType) {
    const entry = this._players.get(playerId);
    if (entry) {
      entry.buffer.push(state);
      return;
    }

    // Player is loading — buffer the state so it's not dropped
    if (this._loading.has(playerId)) {
      let arr = this._pendingStates.get(playerId);
      if (!arr) { arr = []; this._pendingStates.set(playerId, arr); }
      // Keep only the last 5 states to avoid memory growth
      if (arr.length >= 5) arr.shift();
      arr.push(state);
      return;
    }

    // Unknown player — queue for creation (don't await anything here)
    if (!this._pendingQueue.has(playerId)) {
      const nickname = playerId.startsWith('bot_')
        ? playerId.replace('bot_', '')
        : 'Player';
      this._pendingQueue.set(playerId, { nickname, carType: carType || 'FANG' });
    }
  }

  /**
   * Called once per frame from Game._renderUpdate.
   * Creates remote player entries for any queued unknown players.
   * Processes one at a time to avoid blocking.
   */
  processPendingAdds() {
    if (this._pendingQueue.size === 0) return;

    // Take all pending entries and clear the queue
    const batch = new Map(this._pendingQueue);
    this._pendingQueue.clear();

    for (const [playerId, { nickname, carType }] of batch) {
      if (this._players.has(playerId) || this._loading.has(playerId)) continue;
      this._loading.add(playerId);

      // Fire-and-forget async add (won't block the frame)
      this.addPlayer(playerId, nickname, carType).then(() => {
        this._loading.delete(playerId);
        this.game.scoreManager.registerPlayer(playerId, nickname);

        // Flush any states that arrived while loading
        const buffered = this._pendingStates.get(playerId);
        if (buffered) {
          const entry = this._players.get(playerId);
          if (entry) {
            for (const s of buffered) entry.buffer.push(s);
          }
          this._pendingStates.delete(playerId);
        }
      }).catch(() => {
        this._loading.delete(playerId);
        this._pendingStates.delete(playerId);
      });
    }
  }

  applyDamage(playerId, newHp, eliminated) {
    const entry = this._players.get(playerId);
    if (!entry) return;
    entry.hp = newHp;
    if (eliminated) entry.isEliminated = true;
  }

  async respawnPlayer(playerId, carType, pos) {
    const existing = this._players.get(playerId);

    if (existing && existing.carType !== carType) {
      this.removePlayer(playerId);
      const entry = await this.addPlayer(playerId, existing.nickname, carType);
      if (pos) entry.mesh.position.set(pos[0], pos[1], pos[2]);
      entry.hp = 100;
      entry.isEliminated = false;
      return;
    }

    if (existing) {
      existing.hp = 100;
      existing.isEliminated = false;
      existing._eliminationEmitted = false;
      existing._eliminationHandled = false;
      existing.mesh.visible = true;
      existing.buffer.clear();
      if (pos) existing.mesh.position.set(pos[0], pos[1], pos[2]);
    }
  }

  // ── Physics body update (called every fixed update, before physics step) ──

  updatePhysicsBodies() {
    for (const [, entry] of this._players) {
      if (entry.isEliminated) continue;
      // If the interpolation buffer has data, skip — interpolateAll() is the
      // sole source of position/velocity updates for interpolated players.
      // This avoids the race condition where position is set twice per frame
      // (once here and once in interpolateAll), causing jitter.
      if (entry.buffer._buffer.length > 0) continue;
      // Fallback for players that just joined and have no buffered states yet
      const state = entry.buffer.sample();
      if (!state) continue;
      entry.body.position.set(state.posX, state.posY, state.posZ);
      entry.body.velocity.set(state.velX, state.velY, state.velZ);
    }
  }

  // ── Interpolation (called every render frame) ─────────────────────────

  interpolateAll(frameDt, alpha) {
    // Process any pending player creations first
    this.processPendingAdds();

    for (const [, entry] of this._players) {
      if (entry.isEliminated) {
        entry.mesh.visible = false;
        continue;
      }

      const state = entry.buffer.sample();
      if (!state) continue;

      const mesh = entry.mesh;

      // Snap instead of interpolate if distance exceeds threshold (e.g., respawn, network stall)
      const dx = state.posX - mesh.position.x;
      const dy = (state.posY - 0.55) - mesh.position.y;
      const dz = state.posZ - mesh.position.z;
      if (dx * dx + dy * dy + dz * dz > _snapThresholdSq) {
        // Clear the interpolation buffer so it doesn't drag us back
        entry.buffer.clear();
        entry.buffer.push(state);
      }

      // Set position from interpolated state
      // Apply -0.55 Y offset to mesh (same as CarBody.syncMesh) — physics body stays at true Y
      mesh.position.set(state.posX, state.posY - 0.55, state.posZ);

      // Update kinematic physics body position (for collision detection)
      entry.body.position.set(state.posX, state.posY, state.posZ);
      entry.body.velocity.set(state.velX, state.velY, state.velZ);

      // Yaw rotation
      entry._yaw = state.yaw;
      mesh.quaternion.setFromAxisAngle(_yAxis, state.yaw);

      // Update CarBody-like properties for collision/HUD
      entry._currentSpeed = state.speed;
      entry._internalVelX = state.velX;
      entry._internalVelZ = state.velZ;

      // Update flags
      const flags = unpackFlags(state.flags);
      entry.flags = flags;
      entry.isInvincible = flags.isInvincible;
      entry.hasShield = flags.hasShield;
      entry.hasRam = flags.hasRam;
      entry._isStunned = flags.isStunned;
      entry.driftMode = flags.driftMode;
      entry.holoEvadeActive = flags.holoEvadeActive;

      // Animate wheels
      animateWheels(mesh, state.speed, frameDt, entry._steerAngle, flags.driftMode);
    }
  }

  removeAll() {
    // Copy keys to avoid mutating Map during iteration
    for (const id of [...this._players.keys()]) {
      this.removePlayer(id);
    }
    this._pendingQueue.clear();
    this._loading.clear();
    this._pendingStates.clear();
  }
}
