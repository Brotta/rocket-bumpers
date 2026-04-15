import * as THREE from 'three';
import { SceneManager } from '../rendering/SceneManager.js';
import { buildCar, animateWheels, preloadCarModels } from '../rendering/CarFactory.js';
import { PhysicsWorld } from '../physics/PhysicsWorld.js';
import { CarBody } from '../physics/CarBody.js';
import { AbilitySystem } from '../physics/AbilitySystem.js';
import { CollisionHandler } from '../physics/CollisionHandler.js';
import { PowerUpManager } from './PowerUpManager.js';
import { GameState } from './GameState.js';
import { BotManager } from '../ai/BotManager.js';
import { NameTags } from '../ui/NameTags.js';
import { DynamicHazards } from '../physics/DynamicHazards.js';
import { TireSmokeFX } from '../rendering/TireSmokeFX.js';
import { GAME_STATES, ARENA, RESPAWN, CAR_FEEL, OBSTACLE_STUN, COLLISION_IMPACT, MISSILE_IMPACT, IMPACT_TEXT, DAMAGE, CAR_ORDER, getSpawnPosition } from './Config.js';
import { HealthBars } from '../ui/HealthBars.js';
import { StunFX } from '../rendering/StunFX.js';
import { CollisionImpactFX } from '../rendering/CollisionImpactFX.js';
import { createChromaticAberrationPass } from '../rendering/ChromaticAberrationPass.js';
import { audioManager } from '../audio/AudioManager.js';
import { sampleEngineAudio } from '../audio/SampleEngineAudio.js';
import { getAllEngineSampleURLs } from '../audio/AudioConfig.js';
import { playCollisionSFX, playVictimImpactSFX } from '../audio/CollisionSFX.js';
import { ImpactText } from '../rendering/ImpactText.js';
import { announcerSFX } from '../audio/AnnouncerSFX.js';
import { DebugMode } from '../debug/DebugMode.js';
import { ScoreManager } from './ScoreManager.js';
import { PortalSystem } from './PortalSystem.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { RemotePlayerManager } from '../network/RemotePlayerManager.js';
import { MobileControls } from '../ui/MobileControls.js';

const MAX_DT = 1 / 30; // cap delta to avoid spiral of death
const FIXED_DT = 1 / 60; // fixed timestep for deterministic game logic

/**
 * Game — top-level orchestrator.
 *
 * Owns all subsystems: rendering, physics, collision, abilities, game state.
 * Provides a clean API for main.js to hook into UI flow.
 *
 * Usage:
 *   const game = new Game();
 *   game.setPlayer('PLAYER123', 'FANG');
 *   game.start();                // begin lobby → countdown → play loop
 *   game.useAbility();           // called on Space press
 *   game.on('stateChange', …);   // listen to round transitions
 */
export class Game {
  constructor() {
    // ── Core systems ──
    this.sceneManager = new SceneManager();
    this.physicsWorld = new PhysicsWorld();
    this.gameState = new GameState();

    // ── All car bodies in play (player + future bots) ──
    this.carBodies = [];
    this.abilities = new Map(); // CarBody → AbilitySystem

    // ── Collision handler ──
    this.collisionHandler = new CollisionHandler(
      this.physicsWorld.world,
      () => this.carBodies,
      this.physicsWorld.floorBody,
    );

    // ── Power-up manager ──
    this.powerUpManager = new PowerUpManager(
      this.sceneManager.scene,
      this.physicsWorld.world,
      () => this.carBodies,
      () => this.localPlayer,
    );
    // Wire obstacle references for missile destruction
    this.powerUpManager.obstacleBodies = this.physicsWorld.obstacleBodies;
    this.powerUpManager.obstacleGroups = this.sceneManager.arena.obstacleGroups;

    // ── Name tags ──
    this.nameTags = new NameTags();

    // ── Health bars ──
    this.healthBars = new HealthBars();

    // ── Bot manager ──
    this.botManager = new BotManager({
      scene: this.sceneManager.scene,
      world: this.physicsWorld.world,
      carBodies: this.carBodies,
      abilities: this.abilities,
      powerUpManager: this.powerUpManager,
      carMaterial: this.physicsWorld._carMaterial,
    });

    // ── Tire smoke particles ──
    this.tireSmokeFX = new TireSmokeFX(this.sceneManager.scene);

    // ── Dynamic hazards (lava, eruptions, geysers) ──
    this.dynamicHazards = new DynamicHazards(this.sceneManager.arena);
    this.dynamicHazards._camera = this.sceneManager.camera;
    this.dynamicHazards.on('kill', (carBody) => this._onPlayerFell({ victim: carBody }));
    this.dynamicHazards.on('geyserErupt', (e) => this._onGeyserErupt(e));
    this.dynamicHazards.on('eruptionBlast', () => this._onEruptionBlast());
    this.dynamicHazards.on('damage', (e) => {
      // In multiplayer, sync environmental damage (lava/geyser) to server
      if (this.networkManager?.isMultiplayer && e.amount > 0) {
        if (e.target === this.localPlayer) {
          this.networkManager.sendEnvDamage(e.amount);
        } else if (this.networkManager.isHost && this.botManager.isBot(e.target)) {
          // Host reports lava/env damage for its local bots
          this.networkManager.sendEnvDamage(e.amount, e.target.playerId);
        }
      }
    });

    // ── Arena group for car tilt raycasting ──
    this._arenaGroup = this.sceneManager.arena.arenaGroup;
    this._tiltFloorMesh = this.sceneManager.arena.floorMesh || null;

    // ── Score manager ──
    this.scoreManager = new ScoreManager();

    // ── Portal system (initialized after scene is ready) ──
    this.portalSystem = null;

    // ── Multiplayer ──
    this.networkManager = null;       // NetworkManager (null if offline)
    this.remotePlayerManager = null;  // RemotePlayerManager

    // ── Local player ──
    this.localPlayer = null;   // CarBody
    this.localAbility = null;  // AbilitySystem
    this.playerNickname = '';
    this.playerCarType = '';

    // ── Respawn car select callback (set by main.js) ──
    this._onRespawnCarSelect = null; // (callback) => show car select overlay

    // ── Input ──
    this.input = { forward: false, backward: false, left: false, right: false };
    this._inputEnabled = false;

    // ── Mobile controls (auto-detected, hidden on desktop) ──
    this.mobileControls = new MobileControls({
      onInput: (input) => {
        if (!this._inputEnabled) return;
        this.input.forward = input.forward;
        this.input.backward = input.backward;
        this.input.left = input.left;
        this.input.right = input.right;
      },
      onAbility: () => this.useAbility(),
      onPowerUp: () => this.usePowerUp(),
    });

    // ── Camera ──
    this._camDesired = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._lookAtSmoothed = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camRight = new THREE.Vector3();    // for lateral offset
    this._camTiltQuat = new THREE.Quaternion(); // reusable for camera roll
    this._currentFOV = CAR_FEEL.camera.baseFOV;
    this._currentSteerOffset = 0;            // smoothed lateral shift
    this._currentCamTilt = 0;                // smoothed roll tilt

    // ── Camera shake (from geyser/eruption) ──
    this._cameraShakeIntensity = 0;
    this._cameraShakeTimer = 0;
    this._cameraShakeDuration = 0; // total duration for decay calc

    // ── Respawn state ──
    this._isDead = false; // true while local player is falling / waiting to respawn
    this._lastEliminationTime = 0; // timestamp guard to prevent double elimination triggers

    // ── Clock ──
    this._clock = new THREE.Clock();
    this._running = false;
    this._accumulator = 0; // fixed-timestep accumulator

    // ── Event listeners ──
    this._listeners = {};

    // ── HUD overlay elements ──
    this._countdownEl = null;
    this._timerEl = null;
    this._buildOverlayElements();

    // ── Wire game state events ──
    this.gameState.on('stateChange', (e) => this._onStateChange(e));

    // ── Stun visual FX ──
    this.stunFX = new StunFX(this.sceneManager.scene);

    // ── Collision impact FX (car-to-car: sparks, flash, shockwave) ──
    this.collisionImpactFX = new CollisionImpactFX(this.sceneManager.scene);

    // ── Comic impact text overlay ("POW", "BOOM", etc.) ──
    this.impactText = new ImpactText();

    // ── Chromatic aberration post-processing pass ──
    this._chromaticPass = createChromaticAberrationPass();
    // Insert before the OutputPass (last pass)
    const composer = this.sceneManager.composer;
    composer.insertPass(this._chromaticPass, composer.passes.length - 1);
    this._chromaticStrength = 0;
    this._chromaticDecayRate = 0;

    // ── Hit-freeze / slowmo state ──
    this._hitFreezeTimer = 0;     // remaining freeze time (pauses physics)
    this._slowmoTimer = 0;        // remaining slowmo time
    this._slowmoRampTimer = 0;    // ramp-back to 1.0 time
    this._timeScale = 1.0;        // current game time scale (1.0 = normal)

    // ── Wire collision events ──
    this.collisionHandler.on('damage', (e) => this._onDamage(e));
    this.collisionHandler.on('eliminated', (e) => this._onEliminated(e));
    this.collisionHandler.on('fell', (e) => this._onPlayerFell(e));
    this.collisionHandler.on('trail-hit', (e) => {
      this._emit('trail-hit', e);
      if (e.victim?.body) {
        const pos = e.victim.body.position;
        const word = this._pickImpactWord('trail', 'light');
        if (word) {
          this.impactText.show({ word, tier: 'light', x: pos.x, y: pos.y + 0.5, z: pos.z });
          announcerSFX.play(word);
        }
      }
    });
    this.collisionHandler.on('obstacle-hit', (e) => this._onObstacleHit(e));
    this.collisionHandler.on('car-impact', (e) => this._onCarImpact(e));

    // ── Debug mode ──
    this.debug = new DebugMode(this);

    // ── Wire power-up damage events (missiles, turrets, glitch bomb) ──
    this.powerUpManager.on('damage', (e) => this._onDamage(e));
    this.powerUpManager.on('powerup-hit', (e) => this._onPowerupHit(e));

    // ── Wire hazard damage/elimination events ──
    this.dynamicHazards.on('damage', (e) => this._onDamage(e));
    this.dynamicHazards.on('eliminated', (e) => this._onEliminated(e));
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

  // ── Player setup ──────────────────────────────────────────────────────

  /**
   * Spawn the local player car on the arena.
   * Can be called multiple times (car change).
   */
  async setPlayer(nickname, carType) {
    this.playerNickname = nickname;
    this.playerCarType = carType;

    // Remove previous
    if (this.localPlayer) {
      this._removeCarBody(this.localPlayer);
    }

    // Spawn
    const carBody = await this._spawnCar(carType, nickname, 'local');
    this.localPlayer = carBody;

    // Register in score manager
    this.scoreManager.registerPlayer('local', nickname);

    // Initialize camera at correct position behind car to avoid first-frame jump
    this._lookAtSmoothed.copy(carBody.mesh.position);
    const cc = CAR_FEEL.camera;
    const spawnFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(carBody.mesh.quaternion);
    spawnFwd.y = 0;
    spawnFwd.normalize();
    const initCamPos = carBody.mesh.position.clone()
      .addScaledVector(spawnFwd, -cc.followDist)
      .setY(carBody.mesh.position.y + cc.height);
    this.sceneManager.camera.position.copy(initCamPos);
    this._currentFOV = cc.baseFOV;
    this._currentSteerOffset = 0;
    this._currentCamTilt = 0;

    // Ability
    const ability = new AbilitySystem(carType, carBody, {
      scene: this.sceneManager.scene,
      world: this.physicsWorld.world,
      getOtherBodies: () => this.carBodies.filter((cb) => cb !== carBody),
    });
    this.abilities.set(carBody, ability);
    this.localAbility = ability;

    this._emit('playerSpawned', { carBody, carType });

    // Pre-load engine audio samples while bots are spawning.
    // Done here (not in start()) because setPlayer is already async and awaited
    // by the caller — keeping start() synchronous avoids clock/timing issues.
    audioManager.init();
    await audioManager.preloadAll(getAllEngineSampleURLs());
    announcerSFX.preload(); // fire-and-forget: clips load in background

    // Fill remaining slots with bots (skip in multiplayer if not host — host fills bots)
    this.botManager.removeAll();
    this.nameTags.clear();
    if (!this.networkManager?.isMultiplayer || this.networkManager.isHost) {
      await this.botManager.fillSlots();
    }

    // Register bots in score manager (and on server if multiplayer host)
    // Also set _abilityRef so the binary state protocol can encode ability flags for guests
    for (const bot of this.botManager.bots) {
      this.scoreManager.registerPlayer(bot.carBody.playerId, bot.carBody.nickname);
      bot.carBody._abilityRef = this.abilities.get(bot.carBody);
      if (this.networkManager?.isMultiplayer && this.networkManager.isHost) {
        this.networkManager.sendRegisterBot(bot.carBody.playerId, bot.carBody.nickname, bot.carBody.carType);
      }
    }

    // Wire elimination callback on every car (catches ALL damage sources)
    const onElim = (e) => this._onEliminated(e);
    carBody.onEliminated = onElim;
    for (const bot of this.botManager.bots) {
      bot.carBody.onEliminated = onElim;
    }

    // Initialize portal system
    if (!this.portalSystem) {
      this.portalSystem = new PortalSystem(this.sceneManager.scene, {
        getLocalPlayer: () => this.localPlayer,
        getPlayerNickname: () => this.playerNickname,
        getPlayerCarType: () => this.playerCarType,
        getScoreManager: () => this.scoreManager,
      });
    }

    // Register name tags and health bars for all cars
    this.nameTags.add(carBody, true); // local player
    this.healthBars.add(carBody, true);
    for (const bot of this.botManager.bots) {
      this.nameTags.add(bot.carBody, false);
      this.healthBars.add(bot.carBody, false);
    }
  }

  // ── Multiplayer ───────────────────────────────────────────────────────

  /**
   * Connect to a multiplayer room via PartyKit.
   * Call after setPlayer(). Sets up NetworkManager, RemotePlayerManager,
   * and wires all network events.
   */
  async connectMultiplayer(roomId) {
    // Cleanup previous connection if any (e.g., redirect after ROOM_FULL)
    if (this.networkManager) {
      this.networkManager.disconnect();
    }
    if (this.remotePlayerManager) {
      this.remotePlayerManager.removeAll();
    }

    this.networkManager = new NetworkManager(this);
    this.remotePlayerManager = new RemotePlayerManager(this);

    // ── Remap local player ID from 'local' to server-assigned connection ID ──
    // This is critical: without it, all clients use 'local' as their entity ID
    // and every client would discard every other client's state updates.

    // Wire network manager to subsystems
    this.collisionHandler._networkManager = this.networkManager;
    this.powerUpManager._networkManager = this.networkManager;
    if (this.portalSystem) this.portalSystem._networkManager = this.networkManager;

    // Connect to server
    const roomState = await this.networkManager.connect(
      roomId,
      this.playerNickname,
      this.playerCarType,
    );

    // Remap local player's playerId from 'local' to the server connection ID
    const serverPlayerId = this.networkManager.localPlayerId;
    if (this.localPlayer) {
      this.localPlayer.playerId = serverPlayerId;
    }
    this.scoreManager.removePlayer('local');
    this.scoreManager.registerPlayer(serverPlayerId, this.playerNickname);

    // Store ability ref on carBodies for binary protocol encoding (flags)
    if (this.localPlayer && this.localAbility) {
      this.localPlayer._abilityRef = this.localAbility;
    }
    for (const [carBody, ability] of this.abilities) {
      carBody._abilityRef = ability;
    }

    // Spawn remote players that are already in the room
    for (const p of roomState.players) {
      if (p.id === serverPlayerId) continue;
      await this.remotePlayerManager.addPlayer(p.id, p.nickname, p.carType);
      this.scoreManager.registerPlayer(p.id, p.nickname);
    }

    // Sync initial scores from ROOM_STATE so leaderboard is correct immediately
    const initialScores = roomState.players.map(p => ({
      playerId: p.id,
      nickname: p.nickname,
      score: p.score || 0,
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      streak: p.streak || 0,
    }));
    this.scoreManager.syncFromServer(initialScores);

    // If we ARE the host, register bots on the server now that connection is live
    // (setPlayer() ran before connectMultiplayer, so sendRegisterBot was skipped)
    if (this.networkManager.isHost) {
      for (const bot of this.botManager.bots) {
        this.networkManager.sendRegisterBot(bot.carBody.playerId, bot.carBody.nickname, bot.carBody.carType);
      }
    }

    // If we are not the host, remove local bots + clean up their name tags/health bars
    if (!this.networkManager.isHost) {
      for (const bot of this.botManager.bots) {
        this.nameTags.remove(bot.carBody);
        this.healthBars.remove(bot.carBody);
        this.scoreManager.removePlayer(bot.carBody.playerId);
      }
      this.botManager.removeAll();
    }

    // ── Wire network events (store handlers for cleanup) ──
    // Clean up any existing handlers from a previous connection
    if (this._networkHandlers?.length) this._cleanupNetworkHandlers();
    this._networkHandlers = [];
    const _on = (event, fn) => {
      this.networkManager.on(event, fn);
      this._networkHandlers.push({ event, fn });
    };

    // Remote player state updates (20Hz binary) — MUST be synchronous (no await)
    // Unknown players are queued and created in the next frame by RemotePlayerManager
    _on('remotePlayerState', ({ playerId, carType, state }) => {
      // Skip our own state
      if (playerId === serverPlayerId) return;

      // Skip if this is a local bot (we're the host simulating it)
      // Also skip bot-prefixed IDs while we're host (bots may still be loading)
      if (this.networkManager.isHost) {
        if (this._findLocalCarByPlayerId(playerId)) return;
        if (playerId.startsWith('bot_')) return;
      }

      // Push state — if player doesn't exist yet, it gets queued for creation
      this.remotePlayerManager.updatePlayerState(playerId, state, carType);
    });

    // New player joined — fire-and-forget async (don't block message handler)
    _on('playerJoined', ({ id, nickname, carType }) => {
      this.remotePlayerManager.addPlayer(id, nickname, carType).then(() => {
        this.scoreManager.registerPlayer(id, nickname);
        if (this.networkManager.isHost) {
          const humanCount = this._countHumanPlayers();
          this.botManager.adjustBotCount(humanCount);
        }
      });
    });

    // Player left
    _on('playerLeft', ({ id }) => {
      // If it's a local bot (host-simulated), remove from botManager directly
      if (this.networkManager.isHost && id.startsWith('bot_')) {
        const botIdx = this.botManager.bots.findIndex(b => b.carBody.playerId === id);
        if (botIdx !== -1) {
          const bot = this.botManager.bots[botIdx];
          this.nameTags.remove(bot.carBody);
          this.healthBars.remove(bot.carBody);
          const cbIdx = this.carBodies.indexOf(bot.carBody);
          if (cbIdx !== -1) this.carBodies.splice(cbIdx, 1);
          this.botManager.bots.splice(botIdx, 1);
        }
      } else {
        this.remotePlayerManager.removePlayer(id);
      }
      this.scoreManager.removePlayer(id);
    });

    // Server-authoritative damage
    _on('damageDealt', ({ targetId, amount, sourceId, wasAbility, newHp, scoreDelta }) => {
      // Apply to local player
      if (targetId === this.networkManager.localPlayerId) {
        if (this.localPlayer && !this.localPlayer.isEliminated) {
          // Use server-reported HP to prevent desync; fallback to local calculation
          if (newHp !== undefined && newHp !== null) {
            this.localPlayer.hp = newHp;
          } else {
            this.localPlayer.hp = Math.max(0, this.localPlayer.hp - amount);
          }
          this._emit('damage', {
            target: this.localPlayer,
            amount,
            source: sourceId ? this._findCarByPlayerId(sourceId) : null,
            tier: amount >= 30 ? 'devastating' : amount >= 15 ? 'heavy' : 'light',
            wasAbility,
          });
          // Server says HP=0 but local elimination hasn't fired yet — trigger it
          if (this.localPlayer.hp <= 0 && !this.localPlayer.isEliminated) {
            this.localPlayer.hp = 0;
            this.localPlayer.isEliminated = true;
            const killer = sourceId ? this._findCarByPlayerId(sourceId) : null;
            this._onEliminated({ victim: this.localPlayer, killer, wasAbility });
          }
        }
        return;
      }

      // Real-time score feedback: credit attacker immediately (server-authoritative delta)
      if (scoreDelta && sourceId) {
        const isLocalAttacker = sourceId === this.networkManager.localPlayerId
          || this._findLocalCarByPlayerId(sourceId);
        if (isLocalAttacker) {
          this.scoreManager.addServerDelta(sourceId, scoreDelta);
        }
      }

      // Local bot (host) — damage already applied locally; sync HP from server to prevent drift
      const localCar = this._findLocalCarByPlayerId(targetId);
      if (localCar) {
        if (newHp !== undefined && newHp !== null) {
          localCar.hp = newHp;
        }
        this.healthBars.flashDamage(localCar);
        // Server says bot HP=0 but local elimination hasn't fired — trigger it
        if (localCar.hp <= 0 && !localCar.isEliminated) {
          localCar.hp = 0;
          localCar.isEliminated = true;
          const killer = sourceId ? this._findCarByPlayerId(sourceId) : null;
          this._onEliminated({ victim: localCar, killer, wasAbility });
        }
      } else {
        // Apply to remote player (only if NOT a local bot)
        const remote = this.remotePlayerManager.getPlayer(targetId);
        if (remote) {
          if (newHp !== undefined && newHp !== null) {
            remote.hp = newHp;
          } else {
            remote.hp = Math.max(0, remote.hp - amount);
          }
          this.healthBars.flashDamage(remote);
        }
      }
    });

    // Server-authoritative elimination
    _on('playerEliminated', ({ playerId, killerId }) => {
      if (playerId === this.networkManager.localPlayerId) {
        // Local player eliminated by server authority
        if (this.localPlayer && !this.localPlayer.isEliminated) {
          // Guard against double elimination within 1500ms window (accounts for high-latency MP)
          if (Date.now() - this._lastEliminationTime < 1500) return;
          this._lastEliminationTime = Date.now();
          this.localPlayer.hp = 0;
          this.localPlayer.isEliminated = true;
          const killer = killerId ? this._findCarByPlayerId(killerId) : null;
          this._onEliminated({ victim: this.localPlayer, killer, wasAbility: false });
        }
        return;
      }

      // Local bot eliminated (host) — takes priority over remote entry
      const localCar = this._findLocalCarByPlayerId(playerId);
      if (localCar && !localCar.isEliminated) {
        localCar.hp = 0;
        localCar.isEliminated = true;
        const killer = killerId ? this._findCarByPlayerId(killerId) : null;
        this._onEliminated({ victim: localCar, killer, wasAbility: false });
      } else if (!localCar) {
        // Remote player eliminated (only if NOT a local bot)
        const remote = this.remotePlayerManager.getPlayer(playerId);
        if (remote) {
          remote.hp = 0;
          remote.isEliminated = true;
          remote.mesh.visible = false;
        }
      }
    });

    // Power-up events
    _on('powerupSpawned', ({ id, powerupType, position }) => {
      this.powerUpManager.onNetworkSpawn(id, powerupType, position);
    });

    _on('powerupTaken', ({ id, playerId, powerupType }) => {
      this.powerUpManager.onNetworkTaken(id, playerId, powerupType);
    });

    _on('pickupDenied', ({ powerupId }) => {
      this.powerUpManager.onNetworkPickupDenied(powerupId);
    });

    _on('powerupUsed', ({ playerId, powerupType, pos }) => {
      this.powerUpManager.onNetworkUsed(playerId, powerupType, pos);
    });

    // Remote obstacle destruction
    _on('obstacleDestroyed', ({ x, y, z }) => {
      this.powerUpManager.onNetworkObstacleDestroyed(x, y, z);
    });

    // Ability used by remote player
    _on('abilityUsed', ({ playerId, abilityType, pos }) => {
      // Visual-only feedback for remote abilities (minimal for now)
    });

    // Remote player respawn — fire-and-forget
    _on('playerRespawn', ({ playerId, carType, pos }) => {
      if (playerId === this.networkManager.localPlayerId) return;
      this.remotePlayerManager.respawnPlayer(playerId, carType, pos);
    });

    // Host changed — fire-and-forget
    _on('hostChanged', ({ newHostId }) => {
      if (newHostId === this.networkManager.localPlayerId) {
        // Guard against concurrent fillSlots calls
        if (this._fillingSlotsPromise) return;
        this._fillingSlotsPromise = this.botManager.fillSlots().then(() => {
          for (const bot of this.botManager.bots) {
            this.scoreManager.registerPlayer(bot.carBody.playerId, bot.carBody.nickname);
            this.networkManager.sendRegisterBot(bot.carBody.playerId, bot.carBody.nickname, bot.carBody.carType);
            bot.carBody.onEliminated = (e) => this._onEliminated(e);
            bot.carBody._abilityRef = this.abilities.get(bot.carBody);
          }
        }).finally(() => {
          this._fillingSlotsPromise = null;
        });
      }
    });

    // Score updates from server
    _on('scoreUpdate', ({ scores }) => {
      this.scoreManager.syncFromServer(scores);
    });

    // Disconnected — clean up and notify user
    _on('disconnected', () => {
      if (this.remotePlayerManager) {
        this.remotePlayerManager.removeAll();
      }
      this._cleanupNetworkHandlers();
      this._emit('disconnected');
    });
  }

  /** Remove all registered network event handlers to prevent leaks on reconnect. */
  _cleanupNetworkHandlers() {
    if (this._networkHandlers && this.networkManager) {
      for (const { event, fn } of this._networkHandlers) {
        this.networkManager.off(event, fn);
      }
    }
    this._networkHandlers = [];
  }

  /** Count human (non-bot) players including local + remote */
  _countHumanPlayers() {
    let count = 1; // local player
    for (const [, entry] of this.remotePlayerManager._players) {
      if (!entry.playerId.startsWith('bot_')) count++;
    }
    return count;
  }

  /** Find any car (local, local bot, or remote) by playerId */
  _findCarByPlayerId(playerId) {
    if (this.localPlayer && playerId === this.localPlayer.playerId) {
      return this.localPlayer;
    }
    // Check local bots
    for (const bot of this.botManager.bots) {
      if (bot.carBody.playerId === playerId) return bot.carBody;
    }
    // Check remote players
    return this.remotePlayerManager?.getPlayer(playerId) || null;
  }

  /** Find a locally-simulated car (local player or local bot) by playerId */
  _findLocalCarByPlayerId(playerId) {
    if (this.localPlayer && playerId === this.localPlayer.playerId) {
      return this.localPlayer;
    }
    for (const bot of this.botManager.bots) {
      if (bot.carBody.playerId === playerId) return bot.carBody;
    }
    return null;
  }

  // ── Game loop control ─────────────────────────────────────────────────

  /** Start the animation loop and move to LOBBY (or straight to countdown). */
  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    this._animate();

    // Resume audio context (may be suspended on mobile until user gesture)
    audioManager.resume();

    // Audio samples are already preloaded in setPlayer() (which is async and awaited).
    // Add engine sounds for all existing cars now that samples are cached.
    for (const cb of this.carBodies) {
      sampleEngineAudio.addCar(cb, cb === this.localPlayer);
    }

    // Endless mode: start playing immediately
    setTimeout(() => this.gameState.startPlaying(), 200);
  }

  useAbility() {
    if (this.localAbility && this.gameState.isPlaying) {
      this.localAbility.use();
    }
  }

  usePowerUp() {
    if (this.localPlayer && this.gameState.isPlaying) {
      this.powerUpManager.use(this.localPlayer);
    }
  }

  enableInput() {
    if (this._inputEnabled) return;
    this._inputEnabled = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  disableInput() {
    this._inputEnabled = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.input.forward = this.input.backward = this.input.left = this.input.right = false;
  }

  // ── Input handlers (arrow-function bound) ─────────────────────────────

  _onKeyDown = (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    this.input.forward = true; break;
      case 'KeyS': case 'ArrowDown':  this.input.backward = true; break;
      case 'KeyA': case 'ArrowLeft':  this.input.left = true; break;
      case 'KeyD': case 'ArrowRight': this.input.right = true; break;
      case 'Space': this.useAbility(); break;
      case 'KeyE': case 'ShiftLeft': case 'ShiftRight': this.usePowerUp(); break;
      default: return;
    }
    e.preventDefault();
  };

  _onKeyUp = (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    this.input.forward = false; break;
      case 'KeyS': case 'ArrowDown':  this.input.backward = false; break;
      case 'KeyA': case 'ArrowLeft':  this.input.left = false; break;
      case 'KeyD': case 'ArrowRight': this.input.right = false; break;
      default: return;
    }
    e.preventDefault();
  };

  // ── Main animation loop (fixed timestep + visual interpolation) ────────

  _animate = () => {
    if (!this._running) return;
    requestAnimationFrame(this._animate);

    // ── Network send: runs at wall-clock rate, BEFORE any time scaling ──
    // This ensures sends happen at consistent 30Hz regardless of hit-freeze,
    // slowmo, or debug time scale.
    if (this.networkManager?.isMultiplayer && this.localPlayer && !this.localPlayer.isEliminated) {
      const didSend = this.networkManager.tickAndMaybeSend(this.localPlayer);
      if (this.networkManager.isHost) {
        this.networkManager.sendBotStates(this.botManager.bots, didSend);
      }
    }

    let frameDt = this._clock.getDelta();
    if (frameDt > MAX_DT) frameDt = MAX_DT;

    // Apply debug time scale
    frameDt *= this.debug.timeScale;

    // ── Hit-freeze: pause physics entirely for a brief moment ──
    if (this._hitFreezeTimer > 0) {
      this._hitFreezeTimer -= frameDt;
      // During freeze: still interpolate remote players and update VFX
      if (this.remotePlayerManager) {
        this.remotePlayerManager.interpolateAll(frameDt, 0);
      }
      this._updateImpactEffects(frameDt);
      this.nameTags.update(this.sceneManager.camera, window.innerWidth, window.innerHeight);
      this.healthBars.update(this.sceneManager.camera, window.innerWidth, window.innerHeight);
      this.sceneManager.update();
      return;
    }

    // ── Slowmo: reduce time scale temporarily after devastating hit ──
    if (this._slowmoTimer > 0) {
      this._slowmoTimer -= frameDt;
      this._timeScale = COLLISION_IMPACT.slowmo.scale;
      if (this._slowmoTimer <= 0) {
        this._slowmoRampTimer = COLLISION_IMPACT.slowmo.rampBack;
      }
    } else if (this._slowmoRampTimer > 0) {
      this._slowmoRampTimer -= frameDt;
      const t = Math.max(0, this._slowmoRampTimer / COLLISION_IMPACT.slowmo.rampBack);
      this._timeScale = COLLISION_IMPACT.slowmo.scale + (1 - COLLISION_IMPACT.slowmo.scale) * (1 - t);
      if (this._slowmoRampTimer <= 0) this._timeScale = 1.0;
    } else {
      this._timeScale = 1.0;
    }

    // Apply slowmo to frame delta
    frameDt *= this._timeScale;

    // Game state timers (safe to run at render rate — only drives countdowns/UI)
    this.gameState.update(frameDt);

    // ── Fixed-timestep game logic ──
    if (this.gameState.isPlaying) {
      this._accumulator += frameDt;
      while (this._accumulator >= FIXED_DT) {
        // Save previous positions INSIDE the loop so _prevPos is always
        // exactly 1 step behind current — required for correct interpolation
        // when 2+ steps run in a single frame.
        for (const cb of this.carBodies) {
          cb._prevPosX = cb.body.position.x;
          cb._prevPosY = cb.body.position.y;
          cb._prevPosZ = cb.body.position.z;
          cb._prevYaw = cb._yaw;
        }
        this._fixedUpdate(FIXED_DT);
        this._accumulator -= FIXED_DT;
      }
    }

    // ── Render update (runs at display refresh rate) ──
    const alpha = this.gameState.isPlaying
      ? this._accumulator / FIXED_DT
      : 0;
    this._renderUpdate(frameDt, alpha);
  };

  // ── Deterministic game logic at fixed 1/60s timestep ─────────────────

  _fixedUpdate(dt) {
    // Apply controls to local player (skip while dead/falling)
    if (this.localPlayer && !this._isDead) {
      this.localPlayer.applyControls(this.input, dt);
    }

    // Update bot brains — only if offline or if we are the host
    const isMultiplayer = this.networkManager?.isMultiplayer;
    if (!isMultiplayer || this.networkManager.isHost) {
      this.botManager.update(dt);
    }

    // Debug: apply player input to sync cars (multi-vehicle comparison)
    this.debug.fixedUpdate(dt);

    // Update all abilities
    for (const [, ability] of this.abilities) {
      ability.update(dt);
    }

    // Update remote player kinematic bodies BEFORE physics step
    // so collision detection uses current positions
    if (this.remotePlayerManager) {
      this.remotePlayerManager.updatePhysicsBodies();
    }

    // Step physics (single fixed step — no internal accumulator needed)
    this.physicsWorld.step(dt);

    // Floor safety net (runs at fixed rate — no dt scaling needed)
    // Project onto face normals of the octagon (not vertex directions) to get
    // perpendicular distance to each edge. The apothem = R * cos(π/8).
    const _octRadius = ARENA.diameter / 2;
    const _octSides = 8;
    const _octApothem = _octRadius * Math.cos(Math.PI / _octSides);
    for (const cb of this.carBodies) {
      if (cb.isEliminated && !cb.mesh.visible) continue;

      if (cb._isRemote) {
        // Remote players: visual-only floor clamp to prevent clipping (don't modify body)
        if (cb.mesh && cb.mesh.position.y < 0) {
          cb.mesh.position.y = 0.6;
        }
        continue;
      }

      const pos = cb.body.position;

      // Project position onto each face outward normal — max is distance to nearest edge
      let maxProj = -Infinity;
      for (let i = 0; i < _octSides; i++) {
        // Face normal = midpoint angle between vertex i and vertex i+1
        const a = ((i + 0.5) / _octSides) * Math.PI * 2 - Math.PI / 8;
        const nx = Math.cos(a);
        const nz = Math.sin(a);
        const proj = pos.x * nx + pos.z * nz;
        if (proj > maxProj) maxProj = proj;
      }
      const onArena = maxProj < _octApothem - 0.5;

      if (onArena && pos.y < 0 && pos.y > RESPAWN.fallOffY) {
        pos.y += (0.6 - pos.y) * 0.3;
        if (pos.y > 0.55) pos.y = 0.6;
        cb.body.velocity.y = Math.max(cb.body.velocity.y, 0);
      }
    }

    // Dynamic hazards (lava pool, eruptions, geysers) — skip in sandbox
    // Filter out remote entries — hazards only affect locally-simulated cars
    if (!this.debug._sandboxActive) {
      const localCars = this.carBodies.filter(cb => !cb._isRemote);
      this.dynamicHazards.update(dt, localCars);
    }

    // Collision detection (after physics step)
    this.collisionHandler.update();

    // Per-frame obstacle overlap enforcement (safety net for pass-through)
    // Skip remote entries — their positions come from network, not physics
    const localCarsForOverlap = this.carBodies.filter(cb => !cb._isRemote);
    const overlapHits = this.physicsWorld.enforceObstacleOverlaps(localCarsForOverlap);
    for (const hit of overlapHits) {
      this._applyOverlapStun(hit);
    }

    // Power-up spawns, pickups, projectile physics, collision
    this.powerUpManager.update(dt);

    // Portal system (ramp launches, trigger checks)
    if (this.portalSystem) this.portalSystem.update(dt);

    // Network sends moved to _animate() — wall-clock throttled, unaffected
    // by game time scale (slowmo / hit-freeze).
  }

  // ── Visual update at display refresh rate ────────────────────────────

  _renderUpdate(frameDt, alpha) {
    if (this.gameState.isPlaying) {
      // Sync meshes with interpolation between prev and current physics state
      for (const cb of this.carBodies) {
        if (cb._isRemote) continue; // remote players handled by RemotePlayerManager
        if (cb.isEliminated && !cb.mesh.visible) continue;

        cb._arenaGroup = this._arenaGroup;
        cb._tiltFloorMesh = this._tiltFloorMesh;
        cb._updateVisualTilt();
        cb.syncMesh(frameDt, alpha);

        // Animate wheel rotation, steering, and contra-steer
        animateWheels(cb.mesh, cb._currentSpeed, frameDt, cb._steerAngle, cb.driftMode);
      }

      // Tire smoke particles (after mesh sync so wheel positions are current)
      // Filter remote entries — they don't have the tire smoke wheel data
      this.tireSmokeFX.update(frameDt, this.carBodies.filter(cb => !cb._isRemote));

      // Interpolate remote players (multiplayer)
      if (this.remotePlayerManager) {
        this.remotePlayerManager.interpolateAll(frameDt, alpha);
      }

      // Stun visual FX (debris, stars, wobble, flash)
      this.stunFX.update(frameDt);

      // Collision impact VFX (sparks, emissive flash, screen flash, shockwave)
      this._updateImpactEffects(frameDt);
    }

    // Update audio systems (listener position = camera, engine crossfade, voice priorities)
    // Use camera position as the audio listener — this way, free camera mode,
    // spectator view, and any camera distance changes affect spatial audio correctly.
    const cam = this.sceneManager.camera;
    audioManager.setListenerPosition(cam.position.x, cam.position.z);
    sampleEngineAudio.update(frameDt);

    // Camera — debug free cam / sync override / normal follow
    if (this.debug._freeCamActive) {
      // Free camera is updated in debug.update()
    } else if (this.debug._syncActive) {
      this.debug.updateSyncCamera(frameDt);
    } else {
      this._updateCamera(frameDt);
    }

    // Update name tag and health bar positions
    this.nameTags.update(
      this.sceneManager.camera,
      window.innerWidth,
      window.innerHeight,
    );
    this.healthBars.update(
      this.sceneManager.camera,
      window.innerWidth,
      window.innerHeight,
    );
    this.impactText.update(
      this.sceneManager.camera,
      window.innerWidth,
      window.innerHeight,
      frameDt,
    );

    // Debug overlay
    this.debug.update();

    // Render
    this.sceneManager.update();
  }

  // ── Camera ────────────────────────────────────────────────────────────

  _updateCamera(dt) {
    if (!this.localPlayer) return;
    const cam = this.sceneManager.camera;
    const cc = CAR_FEEL.camera;
    const car = this.localPlayer;
    const carPos = car.mesh.position;
    const carQuat = car.mesh.quaternion;

    // Speed ratio for dynamic effects
    const absSpeed = Math.abs(car._currentSpeed);
    const speedRatio = Math.min(absSpeed / Math.max(car.maxSpeed, 1), 1);

    // Forward & right vectors — use velocity direction while airborne or stunned
    // so the camera doesn't spin with the car
    if (car._geyserAirborne || car._isStunned) {
      const vx = car.body.velocity.x;
      const vz = car.body.velocity.z;
      const hSpeed = Math.sqrt(vx * vx + vz * vz);
      if (hSpeed > 0.5) {
        this._camForward.set(vx / hSpeed, 0, vz / hSpeed);
      }
      // else: keep previous _camForward (camera holds steady)
    } else {
      this._camForward.set(0, 0, -1).applyQuaternion(carQuat);
      this._camForward.y = 0;
      this._camForward.normalize();
    }
    this._camRight.set(-this._camForward.z, 0, this._camForward.x);

    // ── Follow distance: pulls back at speed ──
    const followDist = cc.followDist + cc.speedPullback * speedRatio;

    // ── Lateral offset: camera shifts to outside of turn ──
    const steerInput = car._steerInput; // -1 / 0 / +1
    const targetOffset = -steerInput * cc.steerOffsetMax * speedRatio;
    this._currentSteerOffset += (targetOffset - this._currentSteerOffset)
      * Math.min(1, cc.steerOffsetSmoothing * dt);

    // ── Desired position: behind + above + lateral offset ──
    this._camDesired.copy(carPos)
      .addScaledVector(this._camForward, -followDist)
      .addScaledVector(this._camRight, this._currentSteerOffset)
      .setY(carPos.y + cc.height);

    // ── Smooth follow (tighter when airborne so camera locks on) ──
    const followBase = car._geyserAirborne ? 0.15 : cc.followSmoothing;
    const followLerp = Math.min(1, followBase * dt * 60);
    cam.position.lerp(this._camDesired, followLerp);

    // ── Look-at: ahead of car ──
    this._lookAt.copy(carPos).addScaledVector(this._camForward, cc.lookAhead);
    this._lookAtSmoothed.lerp(this._lookAt, followLerp);
    cam.lookAt(this._lookAtSmoothed);

    // ── FOV: widens at speed for drama ──
    const targetFOV = cc.baseFOV + cc.maxFOVBoost * speedRatio;
    this._currentFOV += (targetFOV - this._currentFOV)
      * Math.min(1, cc.fovSmoothing * dt);
    if (Math.abs(cam.fov - this._currentFOV) > 0.05) {
      cam.fov = this._currentFOV;
      cam.updateProjectionMatrix();
    }

    // ── Camera tilt: slight roll into turns (via quaternion, not euler) ──
    const targetTilt = steerInput * cc.steerTiltMax * speedRatio;
    this._currentCamTilt += (targetTilt - this._currentCamTilt)
      * Math.min(1, cc.steerTiltSmoothing * dt);
    if (Math.abs(this._currentCamTilt) > 0.001) {
      // Apply roll around the camera's local forward (Z) axis after lookAt
      this._camTiltQuat.setFromAxisAngle(this._camForward, this._currentCamTilt);
      cam.quaternion.premultiply(this._camTiltQuat);
    }

    // ── Camera shake (geyser + eruption) ──
    if (this._cameraShakeTimer > 0) {
      this._cameraShakeTimer -= dt;
      const decay = this._cameraShakeDuration > 0
        ? Math.max(0, this._cameraShakeTimer / this._cameraShakeDuration)
        : 0;
      const shakeX = (Math.random() - 0.5) * 2 * this._cameraShakeIntensity * decay;
      const shakeY = (Math.random() - 0.5) * 2 * this._cameraShakeIntensity * decay;
      cam.position.x += shakeX;
      cam.position.y += shakeY;
    }
  }

  // ── Spawn helpers ─────────────────────────────────────────────────────

  async _spawnCar(carType, nickname, playerId, spawnSlot = 0) {
    const mesh = await buildCar(carType);
    this.sceneManager.scene.add(mesh);

    const carBody = new CarBody(carType, mesh, this.physicsWorld.world, {
      carMaterial: this.physicsWorld._carMaterial,
    });
    carBody.playerId = playerId;
    carBody.nickname = nickname;

    // Spawn at octagon vertex (slot 0-7), facing center
    const sp = getSpawnPosition(spawnSlot);
    carBody.setPosition(sp.x, sp.y, sp.z, sp.yaw);

    this.carBodies.push(carBody);

    // Start engine sound — local player check works for both single-player ('local')
    // and multiplayer (server-assigned ID matches networkManager.localPlayerId)
    const isLocalPlayer = playerId === 'local'
      || (this.networkManager?.localPlayerId && playerId === this.networkManager.localPlayerId);
    sampleEngineAudio.addCar(carBody, isLocalPlayer);

    return carBody;
  }

  _removeCarBody(carBody) {
    // Stop engine sound
    sampleEngineAudio.removeCar(carBody);

    this.sceneManager.scene.remove(carBody.mesh);
    this.physicsWorld.world.removeBody(carBody.body);

    const ability = this.abilities.get(carBody);
    if (ability) {
      ability.dispose();
      this.abilities.delete(carBody);
    }

    const idx = this.carBodies.indexOf(carBody);
    if (idx !== -1) this.carBodies.splice(idx, 1);
  }

  // ── Central eruption camera shake ──────────────────────────────────

  _onEruptionBlast() {
    if (!this.localPlayer) return;
    const pos = this.localPlayer.body.position;
    const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);

    const shakeCfg = ARENA.eruption.fx.cameraShake;
    let intensity = shakeCfg.intensity;

    // Distance-based falloff (but always some shake since it's the volcano)
    if (dist > shakeCfg.falloffEnd) {
      intensity *= 0.15; // minimum shake even at distance
    } else if (dist > shakeCfg.falloffStart) {
      const t = (dist - shakeCfg.falloffStart) / (shakeCfg.falloffEnd - shakeCfg.falloffStart);
      intensity *= 1 - t * 0.85; // fade to 15% at max distance
    }

    this._cameraShakeIntensity = intensity;
    this._cameraShakeDuration = shakeCfg.duration / 1000;
    this._cameraShakeTimer = this._cameraShakeDuration;
  }

  // ── Overlap-based stun (safety net for pass-through) ───────────────

  _applyOverlapStun({ carBody, speed, nx, nz }) {
    // Below stun threshold: soft bounce only
    if (speed < OBSTACLE_STUN.minStunSpeed) {
      carBody.body.velocity.x = nx * OBSTACLE_STUN.bounceForce;
      carBody.body.velocity.z = nz * OBSTACLE_STUN.bounceForce;
      carBody._currentSpeed *= 0.5;
      carBody._internalVelX = carBody.body.velocity.x;
      carBody._internalVelZ = carBody.body.velocity.z;
      carBody._lastSetVelX = carBody.body.velocity.x;
      carBody._lastSetVelZ = carBody.body.velocity.z;
      return;
    }

    // Apply stun state
    const speedT = Math.min(speed / OBSTACLE_STUN.speedForMaxStun, 1);
    const stunDuration = OBSTACLE_STUN.minDuration
      + speedT * (OBSTACLE_STUN.maxDuration - OBSTACLE_STUN.minDuration);

    carBody._isStunned = true;
    carBody._stunTimer = stunDuration;
    carBody._stunSpinRate = (Math.random() > 0.5 ? 1 : -1) * OBSTACLE_STUN.spinRate;
    carBody._currentSpeed *= (1 - OBSTACLE_STUN.speedKill);

    // Trigger same visual FX as collision-based stun
    const hitX = carBody.body.position.x - nx * 1.0;
    const hitZ = carBody.body.position.z - nz * 1.0;
    const hitY = carBody.body.position.y;
    this._onObstacleHit({
      carBody, speed, stunDuration,
      hitX, hitY, hitZ,
      normalX: nx, normalZ: nz,
    });
  }

  // ── Obstacle hit (stun) ────────────────────────────────────────────

  _onObstacleHit(e) {
    // Visual FX (debris, stars, wobble, flash)
    this.stunFX.onObstacleHit(e);

    // Camera shake (local player only)
    if (e.carBody === this.localPlayer) {
      const shakeCfg = OBSTACLE_STUN.cameraShake;
      this._cameraShakeIntensity = shakeCfg.intensity;
      this._cameraShakeDuration = shakeCfg.duration / 1000;
      this._cameraShakeTimer = this._cameraShakeDuration;
    }

    // Comic impact text
    if (e.hitX !== undefined) {
      const obsTier = e.speed > 20 ? 'heavy' : 'light';
      const word = this._pickImpactWord('obstacle', obsTier);
      if (word) {
        this.impactText.show({ word, tier: obsTier, x: e.hitX, y: e.hitY || 1.0, z: e.hitZ });
        announcerSFX.play(word);
      }
    }
  }

  // ── Impact text helper ──────────────────────────────────────────────

  _pickImpactWord(type, tier) {
    const list = IMPACT_TEXT.words[type]?.[tier];
    if (!list || list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  // ── Car-to-car impact (VFX + SFX + hit-freeze) ─────────────────────

  _onCarImpact(e) {
    const { tier, x, y, z, nx, nz, carA, carB, damageA, damageB } = e;
    const cfg = COLLISION_IMPACT;

    // Determine if local player is involved (for screen effects)
    const localInvolved = carA === this.localPlayer || carB === this.localPlayer;

    // The victim is whichever took more damage (for emissive flash)
    const victim = damageA >= damageB ? carB : carA;

    // ── 1. Visual FX: sparks, emissive flash, screen flash, shockwave ──
    this.collisionImpactFX.trigger({
      tier, x, y, z, nx, nz, victim,
      isLocalPlayer: localInvolved,
    });

    // ── 2. Audio: procedural crash SFX ──
    playCollisionSFX(tier, x, z);

    // ── 3. Camera shake (local player only) ──
    if (localInvolved) {
      const shakeCfg = cfg.cameraShake[tier];
      this._cameraShakeIntensity = shakeCfg.intensity;
      this._cameraShakeDuration = shakeCfg.duration / 1000;
      this._cameraShakeTimer = this._cameraShakeDuration;
    }

    // ── 4. Chromatic aberration pulse (heavy + devastating, local only) ──
    if (localInvolved && cfg.chromatic[tier]) {
      const ca = cfg.chromatic[tier];
      this._chromaticStrength = ca.strength;
      this._chromaticDecayRate = ca.strength / ca.duration;
    }

    // ── 5. Hit freeze (pause physics briefly) ──
    if (localInvolved) {
      const freezeDuration = cfg.hitFreeze[tier];
      this._hitFreezeTimer = freezeDuration;
    }

    // ── 6. Comic impact text + announcer ──
    {
      const word = this._pickImpactWord('car', tier);
      if (word) {
        this.impactText.show({ word, tier, x, y: y || 1.0, z });
        announcerSFX.play(word);
      }
    }

    // ── 7. Slowmo (devastating only, after freeze ends) ──
    if (localInvolved && tier === 'devastating') {
      this._slowmoTimer = cfg.slowmo.duration;
      this._slowmoRampTimer = 0;
    }
  }

  // ── Impact effects per-frame update (chromatic aberration + VFX) ────

  _updateImpactEffects(dt) {
    // Chromatic aberration decay
    if (this._chromaticStrength > 0) {
      this._chromaticStrength -= this._chromaticDecayRate * dt;
      if (this._chromaticStrength < 0.0001) this._chromaticStrength = 0;
      this._chromaticPass.uniforms.strength.value = this._chromaticStrength;
    }

    // Collision impact VFX update (sparks, emissive flashes, screen flash, shockwaves)
    this.collisionImpactFX.update(dt);
  }

  // ── Missile / Turret hit impact (VFX + SFX) ────────────────────────

  _onPowerupHit({ attacker, victim, type, x, y, z }) {
    if (!this.localPlayer) return;

    const isMissile = type === 'MISSILE' || type === 'HOMING_MISSILE';
    const isTurret = type === 'AUTO_TURRET';
    const isVictim = victim === this.localPlayer;
    const isAttacker = attacker === this.localPlayer;
    const localInvolved = isVictim || isAttacker;

    // Determine config key
    const cfgKey = type === 'HOMING_MISSILE' ? 'homing' : isTurret ? 'turret' : 'missile';
    const cfg = MISSILE_IMPACT[cfgKey];
    if (!cfg) return;

    // ── 1. Camera shake ──
    if (isVictim && cfg.shakeVictim) {
      this._cameraShakeIntensity = cfg.shakeVictim.intensity;
      this._cameraShakeDuration = cfg.shakeVictim.duration / 1000;
      this._cameraShakeTimer = this._cameraShakeDuration;
    } else if (isAttacker && cfg.shakeAttacker) {
      this._cameraShakeIntensity = cfg.shakeAttacker.intensity;
      this._cameraShakeDuration = cfg.shakeAttacker.duration / 1000;
      this._cameraShakeTimer = this._cameraShakeDuration;
    }

    // ── 2. Emissive flash on victim car ──
    if (cfg.emissiveFlash && victim?.mesh) {
      this.collisionImpactFX.triggerEmissiveFlash(
        victim, cfg.emissiveFlash.intensity, cfg.emissiveFlash.duration,
      );
    }

    // ── 3. Screen flash (attacker sees it dim, victim sees it bright) ──
    if (isVictim && cfg.screenFlash) {
      this.collisionImpactFX.triggerScreenFlash(
        cfg.screenFlash.color, cfg.screenFlash.alpha, cfg.screenFlash.duration,
      );
    } else if (isAttacker && cfg.screenFlash) {
      this.collisionImpactFX.triggerScreenFlash(
        cfg.screenFlash.color, cfg.screenFlash.alpha * 0.5, cfg.screenFlash.duration,
      );
    }

    // ── 4. Damage vignette (victim only) ──
    if (isVictim && cfg.vignette) {
      this.collisionImpactFX.triggerVignette(cfg.vignette.alpha, cfg.vignette.duration);
    }

    // ── 5. Chromatic aberration (victim only, missiles) ──
    if (isVictim && cfg.chromatic) {
      this._chromaticStrength = cfg.chromatic.strength;
      this._chromaticDecayRate = cfg.chromatic.strength / cfg.chromatic.duration;
    }

    // ── 6. Hit freeze (missiles only, local player involved) ──
    if (localInvolved && cfg.hitFreeze > 0) {
      this._hitFreezeTimer = cfg.hitFreeze;
    }

    // ── 7. Shockwave ring (missiles only) ──
    if (isMissile && cfg.shockwave && x !== undefined) {
      this.collisionImpactFX.triggerShockwave(x, y || 0.5, z, cfg.shockwave);
    }

    // ── 8. Victim-specific metallic crunch SFX ──
    if (isVictim) {
      playVictimImpactSFX(isTurret ? 'turret' : 'missile');
    }

    // ── 9. Comic impact text + announcer ──
    if (x !== undefined) {
      const textType = isTurret ? 'turret' : 'missile';
      const textTier = type === 'HOMING_MISSILE' ? 'devastating' : isTurret ? 'light' : 'heavy';
      const word = this._pickImpactWord(textType, textTier);
      if (word) {
        this.impactText.show({ word, tier: textTier, x, y: y || 1.0, z });
        announcerSFX.play(word);
      }
    }
  }

  // ── Geyser eruption camera shake ───────────────────────────────────

  _onGeyserErupt({ x, z }) {
    if (!this.localPlayer) return;
    const pos = this.localPlayer.body.position;
    const dx = pos.x - x;
    const dz = pos.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const shakeCfg = ARENA.geysers.fx.cameraShake;
    if (dist < shakeCfg.maxDistance) {
      const falloff = 1 - (dist / shakeCfg.maxDistance);
      this._cameraShakeIntensity = shakeCfg.intensity * falloff;
      this._cameraShakeDuration = shakeCfg.duration / 1000;
      this._cameraShakeTimer = this._cameraShakeDuration;
    }
  }

  // ── Damage & Elimination ──────────────────────────────────────────────

  _onDamage(e) {
    // Flash the health bar
    this.healthBars.flashDamage(e.target);

    // Score: credit the attacker (skip in multiplayer — server handles scores)
    if (!this.networkManager?.isMultiplayer && e.source && e.amount > 0 && !e._vfxOnly) {
      this.scoreManager.onDamage(e.source.playerId, e.amount);
    }

    this._emit('damage', e);
  }

  _onEliminated({ victim, killer, wasAbility }) {
    // Guard: may be called from multiple paths (CarBody.onEliminated + event listeners)
    if (victim._eliminationHandled) return;

    // Timestamp-based guard to prevent double elimination trigger within 1500ms (high-latency MP)
    if (Date.now() - this._lastEliminationTime < 1500 && victim === this.localPlayer) return;
    this._lastEliminationTime = Date.now();

    victim._eliminationHandled = true;

    const isLocal = victim === this.localPlayer;
    const isBot = this.botManager.isBot(victim);

    // Score: credit kill or environmental death (skip in multiplayer — server handles)
    if (!this.networkManager?.isMultiplayer) {
      if (killer) {
        this.scoreManager.onKill(killer.playerId, victim.playerId);
      } else {
        this.scoreManager.onDeath(victim.playerId);
      }
    }

    // Disable controls for local player
    if (isLocal) this._isDead = true;

    // Drop held power-up
    this.powerUpManager.drop(victim);

    this._emit('eliminated', { victim, killer, wasAbility });

    // ── Endless respawn flow ──
    // Hide mesh after death-cam, then respawn
    setTimeout(() => {
      victim.mesh.visible = false;
      sampleEngineAudio.removeCar(victim);

      if (isBot) {
        // Bot: auto-assign random car and respawn after a short delay
        const randomCar = CAR_ORDER[Math.floor(Math.random() * CAR_ORDER.length)];
        setTimeout(() => {
          this._respawnCar(victim, randomCar, isBot);
          // Notify server so bot's HP/eliminated state resets
          if (this.networkManager?.isMultiplayer && this.networkManager.isHost) {
            const pos = victim.body.position;
            this.networkManager.sendRegisterBot(victim.playerId, victim.nickname, randomCar);
          }
        }, 500);
      } else if (isLocal) {
        // Human player: show car select overlay, then respawn with chosen car
        if (typeof this._onRespawnCarSelect === 'function') {
          try {
            this._onRespawnCarSelect((chosenCarType) => {
              this._respawnWithNewCar(chosenCarType);
            });
          } catch (_err) {
            // Fallback if car select UI fails — respawn with current car after delay
            setTimeout(() => {
              this._respawnCar(victim, this.playerCarType, false);
            }, RESPAWN.invincibilityDuration * 1000);
          }
        } else {
          // Fallback: _onRespawnCarSelect not set (e.g., guest) — respawn with current car after delay
          setTimeout(() => {
            this._respawnCar(victim, this.playerCarType, false);
          }, RESPAWN.invincibilityDuration * 1000);
        }
      }
    }, RESPAWN.deathCamDuration * 1000);
  }

  /** Respawn the local player with a new car type (after car select). */
  async _respawnWithNewCar(carType) {
    // Safety: clear any lingering invincibility blink to prevent invisible mesh
    if (this._blinkInterval) {
      clearInterval(this._blinkInterval);
      this._blinkInterval = null;
      if (this.localPlayer?.mesh) {
        this.localPlayer.mesh.visible = true;
      }
    }

    const oldCar = this.localPlayer;

    // Remove old car
    this.nameTags.remove(oldCar);
    this.healthBars.remove(oldCar);
    this._removeCarBody(oldCar);

    // Spawn new car
    this.playerCarType = carType;
    const angle = Math.random() * Math.PI * 2;
    const r = ARENA.lava.radius + 5 + Math.random() * (ARENA.diameter / 2 - ARENA.lava.radius - 10);
    // Use server-assigned ID in multiplayer, 'local' in single-player
    const pid = this.networkManager?.isMultiplayer
      ? this.networkManager.localPlayerId
      : 'local';
    const carBody = await this._spawnCar(carType, this.playerNickname, pid);
    this.localPlayer = carBody;

    carBody.setPosition(Math.cos(angle) * r, 0.6, Math.sin(angle) * r, angle + Math.PI);
    carBody.syncMesh();

    // Re-setup ability
    const ability = new AbilitySystem(carType, carBody, {
      scene: this.sceneManager.scene,
      world: this.physicsWorld.world,
      getOtherBodies: () => this.carBodies.filter((cb) => cb !== carBody),
    });
    this.abilities.set(carBody, ability);
    this.localAbility = ability;
    carBody._abilityRef = ability;

    // Wire elimination callback
    carBody.onEliminated = (e) => this._onEliminated(e);

    // Re-register name tag and health bar
    this.nameTags.add(carBody, true);
    this.healthBars.add(carBody, true);

    // Re-initialize camera to follow new car (avoid first-frame jump)
    this._lookAtSmoothed.copy(carBody.mesh.position);
    const cc = CAR_FEEL.camera;
    const spawnFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(carBody.mesh.quaternion);
    spawnFwd.y = 0;
    spawnFwd.normalize();
    const initCamPos = carBody.mesh.position.clone()
      .addScaledVector(spawnFwd, -cc.followDist)
      .setY(carBody.mesh.position.y + cc.height);
    this.sceneManager.camera.position.copy(initCamPos);
    this._currentFOV = cc.baseFOV;
    this._currentSteerOffset = 0;
    this._currentCamTilt = 0;

    // Respawn flash
    this._showRespawnFlash();

    // Invincibility blink
    carBody.isInvincible = true;
    AbilitySystem.setInvincible(carBody, true);
    this._startInvincibilityBlink(carBody);

    setTimeout(() => {
      carBody.isInvincible = false;
      AbilitySystem.setInvincible(carBody, false);
      carBody.mesh.visible = true;
      this._enableInput();
    }, RESPAWN.invincibilityDuration * 1000);

    this._emit('playerSpawned', { carBody, carType });

    // Notify server of respawn
    if (this.networkManager?.isMultiplayer) {
      const pos = carBody.body.position;
      this.networkManager.sendPlayerRespawn(carType, [pos.x, pos.y, pos.z]);
      this.networkManager.sendChangeCar(carType);
    }
  }

  /** Respawn an existing car (bot or fallback) in place. */
  _respawnCar(carBody, newCarType, isBot) {
    // Safety: clear any lingering invincibility blink to prevent invisible mesh
    if (this._blinkInterval) {
      clearInterval(this._blinkInterval);
      this._blinkInterval = null;
      if (this.localPlayer?.mesh) {
        this.localPlayer.mesh.visible = true;
      }
    }

    const angle = Math.random() * Math.PI * 2;
    const r = ARENA.lava.radius + 5 + Math.random() * (ARENA.diameter / 2 - ARENA.lava.radius - 10);

    carBody.resetState();
    carBody.resetHP();
    carBody._eliminationEmitted = false;
    carBody._eliminationHandled = false;
    sampleEngineAudio.resetCar(carBody);
    const ability = this.abilities.get(carBody);
    if (ability) ability.forceReset();

    carBody.setPosition(Math.cos(angle) * r, 0.6, Math.sin(angle) * r, angle + Math.PI);
    carBody.syncMesh();
    carBody.mesh.visible = true;

    // Re-add engine sound
    sampleEngineAudio.addCar(carBody, !isBot);

    if (isBot) {
      this.botManager.resetBrain(carBody);
    } else {
      this._showRespawnFlash();
      this._enableInput();
    }

    // Invincibility blink
    carBody.isInvincible = true;
    AbilitySystem.setInvincible(carBody, true);
    this._startInvincibilityBlink(carBody);

    setTimeout(() => {
      carBody.isInvincible = false;
      AbilitySystem.setInvincible(carBody, false);
      carBody.mesh.visible = true;
    }, RESPAWN.invincibilityDuration * 1000);
  }

  // ── Respawn (fall off edge — NOT eliminated, just damage + respawn) ──

  _onPlayerFell({ victim }) {
    // In endless mode: if eliminated (HP=0), handle as full elimination (with car select)
    if (victim.isEliminated) {
      this._onEliminated({ victim, killer: victim._lastHitBy || null, wasAbility: false });
      return;
    }

    // Otherwise: quick respawn (same car, no car select needed — just fell off)
    const isLocal = victim === this.localPlayer;
    const isBot = this.botManager.isBot(victim);

    if (isLocal) this._isDead = true;
    this.powerUpManager.drop(victim);

    // Apply fall damage locally as optimistic estimate (server will sync exact newHp later).
    // In SP, takeDamage was already called by CollisionHandler; in MP it wasn't,
    // so we apply it here to get the correct HP before respawn repositioning.
    if (this.networkManager?.isMultiplayer && !victim.isEliminated) {
      victim.hp = Math.max(0, victim.hp - DAMAGE.FALL_DAMAGE);
    }

    // Check if fall damage killed the victim
    if (victim.hp <= 0 || victim.isEliminated) {
      victim.hp = 0;
      victim.isEliminated = true;
      this._onEliminated({ victim, killer: victim._lastHitBy || null, wasAbility: false });
      return;
    }

    // Preserve HP after fall damage (don't reset to max)
    const hpAfterFall = victim.hp;

    setTimeout(() => {
      this._respawnCar(victim, victim.carType, isBot);
      // Restore fall-damaged HP instead of full HP
      victim.hp = hpAfterFall;
      victim._isFalling = false;
      if (isLocal) this._enableInput();
    }, RESPAWN.deathCamDuration * 1000);
  }

  _startInvincibilityBlink(carBody) {
    // Clear any previous blink interval to prevent overlapping blinks
    if (this._blinkInterval) {
      clearInterval(this._blinkInterval);
      this._blinkInterval = null;
      if (this.localPlayer?.mesh) {
        this.localPlayer.mesh.visible = true;
      }
    }

    let blinkCount = 0;
    const maxBlinks = 12; // ~1.5s at 8Hz
    this._blinkInterval = setInterval(() => {
      if (blinkCount >= maxBlinks || !carBody.isInvincible) {
        clearInterval(this._blinkInterval);
        this._blinkInterval = null;
        if (carBody.mesh) {
          carBody.mesh.visible = true;
        }
        return;
      }
      carBody.mesh.visible = !carBody.mesh.visible;
      blinkCount++;
    }, 125);
  }

  _showRespawnFlash() {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position:fixed;inset:0;z-index:60;
      background:white;pointer-events:none;
      opacity:0.7;transition:opacity 0.4s ease-out;
    `;
    document.body.appendChild(flash);
    // Trigger fade out on next frame
    requestAnimationFrame(() => {
      flash.style.opacity = '0';
      flash.addEventListener('transitionend', () => flash.remove());
    });
  }

  /** Centralized method to re-enable input after respawn/death. */
  _enableInput() {
    this._isDead = false;
    // Clear any pending input state to prevent ghost inputs
    this.input.forward = this.input.backward = this.input.left = this.input.right = false;
  }

  // ── Round state handlers ──────────────────────────────────────────────

  _onStateChange({ from, to }) {
    if (to === GAME_STATES.PLAYING) {
      this._onEnterPlaying();
    }
    this._emit('stateChange', { from, to });
  }

  _onEnterPlaying() {
    this._enableInput();
    this.enableInput();
    // Hide legacy overlays
    if (this._countdownEl) this._countdownEl.style.display = 'none';
    if (this._timerEl) this._timerEl.style.display = 'none';
  }

  // ── Overlay HUD elements ──────────────────────────────────────────────

  _buildOverlayElements() {
    // Countdown text (center screen) — kept for potential "SMASH!" style entry
    const cd = document.createElement('div');
    cd.style.cssText = `
      position:fixed;inset:0;z-index:50;
      display:none;align-items:center;justify-content:center;
      font:clamp(4rem,15vw,10rem) 'Luckiest Guy',cursive;
      color:#ff6600;text-shadow:0 4px 0 #1a0e08, 0 0 30px rgba(255,68,0,0.6), 0 0 80px rgba(255,34,0,0.3);
      pointer-events:none;
    `;
    document.body.appendChild(cd);
    this._countdownEl = cd;

    // Timer — hidden in endless mode
    this._timerEl = null;
  }

  // ── Getters ───────────────────────────────────────────────────────────

  get scene() { return this.sceneManager.scene; }
  get camera() { return this.sceneManager.camera; }
}
