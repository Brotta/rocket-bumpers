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
import { CARS, GAME_STATES, ARENA, ROUND, RESPAWN, CAR_FEEL, OBSTACLE_STUN } from './Config.js';
import { StunFX } from '../rendering/StunFX.js';
import { engineAudio } from '../audio/EngineAudio.js';

const MAX_DT = 1 / 30; // cap delta to avoid spiral of death

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
    );

    // ── Name tags ──
    this.nameTags = new NameTags();

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

    // ── Arena group for car tilt raycasting ──
    this._arenaGroup = this.sceneManager.arena.arenaGroup;
    this._tiltFloorMesh = this.sceneManager.arena.floorMesh || null;

    // ── Local player ──
    this.localPlayer = null;   // CarBody
    this.localAbility = null;  // AbilitySystem
    this.playerNickname = '';

    // ── Input ──
    this.input = { forward: false, backward: false, left: false, right: false };
    this._inputEnabled = false;

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

    // ── Clock ──
    this._clock = new THREE.Clock();
    this._running = false;

    // ── Event listeners ──
    this._listeners = {};

    // ── HUD overlay elements ──
    this._countdownEl = null;
    this._timerEl = null;
    this._buildOverlayElements();

    // ── Wire game state events ──
    this.gameState.on('stateChange', (e) => this._onStateChange(e));
    this.gameState.on('countdownTick', (e) => this._onCountdownTick(e));
    this.gameState.on('roundTimeUpdate', (e) => this._onRoundTimeUpdate(e));

    // ── Stun visual FX ──
    this.stunFX = new StunFX(this.sceneManager.scene);

    // ── Wire collision events → re-emit ──
    this.collisionHandler.on('hit', (e) => this._emit('hit', e));
    this.collisionHandler.on('ko', (e) => this._emit('ko', e));
    this.collisionHandler.on('self-ko', (e) => this._emit('self-ko', e));
    this.collisionHandler.on('fell', (e) => this._onPlayerFell(e));
    this.collisionHandler.on('trail-hit', (e) => this._emit('trail-hit', e));
    this.collisionHandler.on('obstacle-hit', (e) => this._onObstacleHit(e));
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
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

    // Remove previous
    if (this.localPlayer) {
      this._removeCarBody(this.localPlayer);
    }

    // Spawn
    const carBody = await this._spawnCar(carType, nickname, 'local');
    this.localPlayer = carBody;

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

    // Fill remaining slots with bots
    this.botManager.removeAll();
    this.nameTags.clear();
    await this.botManager.fillSlots();

    // Register name tags for all cars
    this.nameTags.add(carBody, true); // local player
    for (const bot of this.botManager.bots) {
      this.nameTags.add(bot.carBody, false);
    }
  }

  // ── Game loop control ─────────────────────────────────────────────────

  /** Start the animation loop and move to LOBBY (or straight to countdown). */
  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    this._animate();

    // Initialize audio (user has interacted by this point — safe for autoplay)
    this.dynamicHazards.initAudio();
    this.dynamicHazards.resumeAudio();
    engineAudio.init();

    // Add engine sounds for all existing cars
    for (const cb of this.carBodies) {
      engineAudio.addCar(cb, cb === this.localPlayer);
    }

    // Auto-start round after a short lobby
    setTimeout(() => this.gameState.startRound(), 500);
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

  // ── Main animation loop ───────────────────────────────────────────────

  _animate = () => {
    if (!this._running) return;
    requestAnimationFrame(this._animate);

    let dt = this._clock.getDelta();
    if (dt > MAX_DT) dt = MAX_DT;

    // Game state timers
    this.gameState.update(dt);

    // Physics + abilities (only during PLAYING)
    if (this.gameState.isPlaying) {
      // Apply controls to local player (skip while dead/falling)
      if (this.localPlayer && !this._isDead) {
        this.localPlayer.applyControls(this.input, dt);
      }

      // Update bot brains (produces input + calls applyControls internally)
      this.botManager.update(dt);

      // Update all abilities
      for (const [, ability] of this.abilities) {
        ability.update(dt);
      }

      // Step physics
      this.physicsWorld.step(dt);

      // Sync all meshes + floor safety net + visual tilt + wheel animation
      for (const cb of this.carBodies) {
        const pos = cb.body.position;
        const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);

        // Safety net: prevent tunneling through floor within arena bounds
        // Use soft correction to avoid visual jitter from hard Y snaps
        if (dist < ARENA.diameter / 2 - 1 && pos.y < 0 && pos.y > RESPAWN.fallOffY) {
          pos.y += (0.6 - pos.y) * 0.3; // soft push toward 0.6 instead of hard snap
          if (pos.y > 0.55) pos.y = 0.6; // clamp once close enough
          cb.body.velocity.y = Math.max(cb.body.velocity.y, 0);
        }

        // Update visual tilt then sync mesh
        cb._arenaGroup = this._arenaGroup;
        cb._tiltFloorMesh = this._tiltFloorMesh;
        cb._updateVisualTilt();
        cb.syncMesh(dt);

        // Animate wheel rotation, steering, and contra-steer
        animateWheels(cb.mesh, cb._currentSpeed, dt, cb._steerAngle, cb.driftMode);
      }

      // Tire smoke particles (after mesh sync so wheel positions are current)
      this.tireSmokeFX.update(dt, this.carBodies);

      // Stun visual FX (debris, stars, wobble, flash)
      this.stunFX.update(dt);

      // Dynamic hazards (lava pool, eruptions, geysers)
      this.dynamicHazards.update(dt, this.carBodies);

      // Collision detection (after physics step)
      this.collisionHandler.update();

      // Per-frame obstacle overlap enforcement (safety net for pass-through)
      const overlapHits = this.physicsWorld.enforceObstacleOverlaps(this.carBodies);
      for (const hit of overlapHits) {
        this._applyOverlapStun(hit);
      }

      // Power-up spawns, pickups, animations
      this.powerUpManager.update(dt);
    } else if (this.gameState.isCountdown) {
      // During countdown: keep rendering but no controls / physics
      // Cars are locked, just sync visuals with tilt
      for (const cb of this.carBodies) {
        cb._arenaGroup = this._arenaGroup;
        cb._tiltFloorMesh = this._tiltFloorMesh;
        cb._updateVisualTilt();
        cb.syncMesh(dt);
      }
    }

    // Update engine audio (pitch follows speed, spatial attenuation for bots)
    if (this.localPlayer) {
      const lp = this.localPlayer.body.position;
      engineAudio.setListenerPosition(lp.x, lp.z);
    }
    engineAudio.update(dt);

    // Camera always follows
    this._updateCamera();

    // Update name tag positions
    this.nameTags.update(
      this.sceneManager.camera,
      window.innerWidth,
      window.innerHeight,
    );

    // Render
    this.sceneManager.update();
  };

  // ── Camera ────────────────────────────────────────────────────────────

  _updateCamera() {
    if (!this.localPlayer) return;
    const cam = this.sceneManager.camera;
    const cc = CAR_FEEL.camera;
    const car = this.localPlayer;
    const carPos = car.mesh.position;
    const carQuat = car.mesh.quaternion;

    // Speed ratio for dynamic effects
    const absSpeed = Math.abs(car._currentSpeed);
    const speedRatio = Math.min(absSpeed / Math.max(car.maxSpeed, 1), 1);

    // Forward & right vectors — use velocity direction while airborne
    // so the camera doesn't spin with the car
    if (car._geyserAirborne) {
      const vx = car.body.velocity.x;
      const vz = car.body.velocity.z;
      const hSpeed = Math.sqrt(vx * vx + vz * vz);
      if (hSpeed > 0.5) {
        this._camForward.set(vx / hSpeed, 0, vz / hSpeed);
      }
      // else: keep previous _camForward (no meaningful direction)
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
      * Math.min(1, cc.steerOffsetSmoothing * (1 / 60));

    // ── Desired position: behind + above + lateral offset ──
    this._camDesired.copy(carPos)
      .addScaledVector(this._camForward, -followDist)
      .addScaledVector(this._camRight, this._currentSteerOffset)
      .setY(carPos.y + cc.height);

    // ── Smooth follow (tighter when airborne so camera locks on) ──
    const followLerp = car._geyserAirborne ? 0.15 : cc.followSmoothing;
    cam.position.lerp(this._camDesired, followLerp);

    // ── Look-at: ahead of car ──
    this._lookAt.copy(carPos).addScaledVector(this._camForward, cc.lookAhead);
    this._lookAtSmoothed.lerp(this._lookAt, followLerp);
    cam.lookAt(this._lookAtSmoothed);

    // ── FOV: widens at speed for drama ──
    const targetFOV = cc.baseFOV + cc.maxFOVBoost * speedRatio;
    this._currentFOV += (targetFOV - this._currentFOV)
      * Math.min(1, cc.fovSmoothing * (1 / 60));
    if (Math.abs(cam.fov - this._currentFOV) > 0.05) {
      cam.fov = this._currentFOV;
      cam.updateProjectionMatrix();
    }

    // ── Camera tilt: slight roll into turns (via quaternion, not euler) ──
    const targetTilt = steerInput * cc.steerTiltMax * speedRatio;
    this._currentCamTilt += (targetTilt - this._currentCamTilt)
      * Math.min(1, cc.steerTiltSmoothing * (1 / 60));
    if (Math.abs(this._currentCamTilt) > 0.001) {
      // Apply roll around the camera's local forward (Z) axis after lookAt
      this._camTiltQuat.setFromAxisAngle(this._camForward, this._currentCamTilt);
      cam.quaternion.premultiply(this._camTiltQuat);
    }

    // ── Camera shake (geyser + eruption) ──
    if (this._cameraShakeTimer > 0) {
      this._cameraShakeTimer -= 1 / 60;
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

  async _spawnCar(carType, nickname, playerId) {
    const mesh = await buildCar(carType);
    this.sceneManager.scene.add(mesh);

    const carBody = new CarBody(carType, mesh, this.physicsWorld.world, {
      carMaterial: this.physicsWorld._carMaterial,
    });
    carBody.playerId = playerId;
    carBody.nickname = nickname;

    // Random spawn position on flat arena (avoid lava center)
    const angle = Math.random() * Math.PI * 2;
    const r = ARENA.lava.radius + 5 + Math.random() * (ARENA.diameter / 2 - ARENA.lava.radius - 10);
    carBody.setPosition(Math.cos(angle) * r, 0.6, Math.sin(angle) * r);
    carBody._yaw = angle + Math.PI; // face center

    this.carBodies.push(carBody);

    // Start engine sound (if audio initialized)
    engineAudio.addCar(carBody, playerId === 'local');

    return carBody;
  }

  _removeCarBody(carBody) {
    // Stop engine sound
    engineAudio.removeCar(carBody);

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

  // ── Respawn ───────────────────────────────────────────────────────────

  _onPlayerFell({ victim }) {
    const isLocal = victim === this.localPlayer;
    const isBot = this.botManager.isBot(victim);

    // Mark local player as dead (disables controls, camera keeps following)
    if (isLocal) this._isDead = true;

    // Drop held power-up
    this.powerUpManager.drop(victim);

    // No respawn during last 10s of the round
    const remaining = this.gameState.remainingTime;
    if (remaining <= ROUND.noRespawnLastSeconds) {
      // Stay dead until round ends — hide mesh after death cam
      setTimeout(() => {
        victim.mesh.visible = false;
      }, RESPAWN.deathCamDuration * 1000);
      return;
    }

    // After death-cam delay (2s): teleport and respawn
    setTimeout(() => {
      const angle = Math.random() * Math.PI * 2;
      const r = ARENA.lava.radius + 5 + Math.random() * (ARENA.diameter / 2 - ARENA.lava.radius - 10);

      // Invalidate any pending power-up/ability timeouts and reset mass/speed
      victim.resetState();
      const ability = this.abilities.get(victim);
      if (ability) ability.forceReset();

      victim.setPosition(Math.cos(angle) * r, 0.6, Math.sin(angle) * r);
      victim._yaw = angle + Math.PI;
      victim.body.velocity.set(0, 0, 0);
      victim.body.angularVelocity.set(0, 0, 0);
      victim.syncMesh();

      // Respawn flash (local player only)
      if (isLocal) this._showRespawnFlash();

      // Reset bot brain after respawn
      if (isBot) this.botManager.resetBrain(victim);

      // Invincibility blink (1.5s)
      victim.isInvincible = true;
      victim.mesh.visible = true;
      AbilitySystem.setInvincible(victim, true);
      this._startInvincibilityBlink(victim);

      setTimeout(() => {
        victim.isInvincible = false;
        AbilitySystem.setInvincible(victim, false);
        victim.mesh.visible = true;
        // Restore control
        if (isLocal) this._isDead = false;
      }, RESPAWN.invincibilityDuration * 1000);
    }, RESPAWN.deathCamDuration * 1000);
  }

  _startInvincibilityBlink(carBody) {
    let blinkCount = 0;
    const maxBlinks = 12; // ~1.5s at 8Hz
    const interval = setInterval(() => {
      if (blinkCount >= maxBlinks || !carBody.isInvincible) {
        carBody.mesh.visible = true;
        clearInterval(interval);
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

  // ── Round state handlers ──────────────────────────────────────────────

  _onStateChange({ from, to }) {
    if (to === GAME_STATES.COUNTDOWN) {
      this._onEnterCountdown();
    } else if (to === GAME_STATES.PLAYING) {
      this._onEnterPlaying();
    } else if (to === GAME_STATES.RESULTS) {
      this._onEnterResults();
    }
    this._emit('stateChange', { from, to });
  }

  _onEnterCountdown() {
    // Reset death state for new round
    this._isDead = false;

    // Lock all cars at spawn positions
    this.disableInput();

    // Reset scores, power-ups, and all mutable state for new round
    for (const cb of this.carBodies) {
      cb.score = 0;
      cb.resetState(); // invalidates stale timeouts, resets mass/speed/flags
      const ability = this.abilities.get(cb);
      if (ability) ability.forceReset();
    }
    this.powerUpManager.reset();
    this.dynamicHazards.reset();

    // Reposition bots for new round
    this.botManager.resetForNewRound();

    if (this._countdownEl) this._countdownEl.style.display = 'flex';
  }

  _onEnterPlaying() {
    this.enableInput();
    if (this._countdownEl) this._countdownEl.style.display = 'none';
    if (this._timerEl) this._timerEl.style.display = 'block';
  }

  _onEnterResults() {
    this.disableInput();
    if (this._timerEl) this._timerEl.style.display = 'none';

    // Emit results with sorted scores
    const results = this.carBodies
      .map((cb) => ({ nickname: cb.nickname, carType: cb.carType, score: cb.score }))
      .sort((a, b) => b.score - a.score);
    this._emit('roundEnd', { results });
  }

  _onCountdownTick({ seconds }) {
    if (!this._countdownEl) return;
    if (seconds > 0) {
      this._countdownEl.textContent = String(seconds);
    } else {
      this._countdownEl.textContent = 'SMASH!';
      setTimeout(() => {
        if (this._countdownEl) this._countdownEl.style.display = 'none';
      }, 600);
    }
  }

  _onRoundTimeUpdate({ remaining }) {
    if (!this._timerEl) return;
    const sec = Math.ceil(remaining);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    this._timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;

    // Urgency color in last 10s
    this._timerEl.style.color = remaining <= 10 ? '#f44' : '#fff';
  }

  // ── Overlay HUD elements ──────────────────────────────────────────────

  _buildOverlayElements() {
    // Countdown text (center screen)
    const cd = document.createElement('div');
    cd.style.cssText = `
      position:fixed;inset:0;z-index:50;
      display:none;align-items:center;justify-content:center;
      font:bold clamp(4rem,15vw,10rem) 'Courier New',monospace;
      color:#ff6600;text-shadow:0 0 30px #ff4400,0 0 80px #ff2200;
      pointer-events:none;
    `;
    document.body.appendChild(cd);
    this._countdownEl = cd;

    // Round timer (top center)
    const tm = document.createElement('div');
    tm.style.cssText = `
      position:fixed;top:16px;left:50%;transform:translateX(-50%);
      font:bold 28px 'Courier New',monospace;color:#fff;
      text-shadow:0 0 8px #000;pointer-events:none;z-index:10;
      display:none;
    `;
    document.body.appendChild(tm);
    this._timerEl = tm;
  }

  // ── Getters ───────────────────────────────────────────────────────────

  get scene() { return this.sceneManager.scene; }
  get camera() { return this.sceneManager.camera; }
}
