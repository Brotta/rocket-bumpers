import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CAR_FEEL, DAMAGE, OBSTACLE_STUN, ARENA, PHYSICS, CAR_ORDER, CARS, POWERUPS, POWERUP_WEIGHTS, GAME_STATES, COLLISION_GROUPS, BOTS, PLAYERS, getSpawnPosition } from '../core/Config.js';
import { AbilitySystem } from '../physics/AbilitySystem.js';
import { CarBody } from '../physics/CarBody.js';
import { buildCar } from '../rendering/CarFactory.js';
import { PERSONALITIES, randomPersonality } from '../ai/BotPersonalities.js';
import { sampleEngineAudio } from '../audio/SampleEngineAudio.js';
import { audioManager } from '../audio/AudioManager.js';
import { AUDIO_BUS, AUDIO_VOLUMES, SPATIAL, GEAR_DEFAULTS, RPM_CROSSFADE_FRACTIONS, CAR_ENGINE_PROFILES } from '../audio/AudioConfig.js';

/**
 * DebugMode — all-in-one debug overlay for Rocket Bumpers.
 *
 * Features:
 *   1.  Hitbox wireframe visualization
 *   2.  Real-time parameter tweaking panel
 *   3.  Click-to-teleport
 *   4.  God mode
 *   5.  Spawn controls
 *   6.  Debug map toggle (flat, no obstacles/hazards)
 *   7.  Sandbox mode (flat map, no enemies, no timer)
 *   8.  Entity spawner (click to place missiles, geysers, obstacles)
 *   9.  Multi-vehicle sync input (compare car handling side-by-side)
 *   10. FX visibility toggles (tire smoke, stun FX, geyser FX)
 *   11. Slow motion time scale
 *   12. Free camera (orbit controls)
 *   13. Physics debug overlay (static bodies wireframe)
 *   14. Bot AI visualizer
 *   15. Performance stats panel
 *   16. Collision logger
 *   17. Bot spawner (click to place)
 *   18. Power-up box spawner (click to place)
 *   19. Instant elimination/respawn
 *
 * Toggle with ' (apostrophe) key.
 */

const POWERUP_TYPES = Object.keys(POWERUPS);

export class DebugMode {
  constructor(game) {
    this.game = game;
    this.scene = game.sceneManager.scene;
    this.camera = game.sceneManager.camera;
    this.enabled = false;

    // ── State ──
    this._godMode = false;
    this._showHitboxes = false;
    this._debugMap = false;
    this._teleportMode = false;
    this._sandboxActive = false;

    // ── Multi-vehicle sync ──
    this._syncCars = [];       // CarBody[] — cars controlled by player input
    this._syncActive = false;

    // ── Entity spawner ──
    this._spawnerMode = null;  // null | 'missile' | 'homing' | 'geyser' | 'bot_*' | 'powerup_*'
    this._spawnerHandler = null;

    // ── Hitbox wireframes ──
    this._hitboxMeshes = [];
    this._hitboxMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5,
    });
    this._hitboxObstacleMat = new THREE.MeshBasicMaterial({
      color: 0xff8800, wireframe: true, transparent: true, opacity: 0.4,
    });
    this._hitboxMissileMat = new THREE.MeshBasicMaterial({
      color: 0xff0000, wireframe: true, transparent: true, opacity: 0.6,
    });
    this._hitboxTrailMat = new THREE.MeshBasicMaterial({
      color: 0xff44ff, wireframe: true, transparent: true, opacity: 0.5,
    });

    // ── Debug map state ──
    this._hiddenObstacles = [];
    this._hazardsDisabled = false;

    // ── Sandbox map state ──
    this._sandboxFloorMesh = null;
    this._sandboxFloorBody = null;
    this._sandboxGridMesh = null;
    this._hiddenSceneChildren = [];
    this._origFloorBody = null;
    this._origLavaBody = null;
    this._origBackground = null;
    this._origFog = null;

    // ── Teleport ──
    this._raycaster = new THREE.Raycaster();
    this._mouseNDC = new THREE.Vector2();
    this._teleportMarker = null;

    // ── Time scale ──
    this._timeScale = 1.0;

    // ── Free camera ──
    this._freeCamActive = false;
    this._freeCamSavedPos = new THREE.Vector3();
    this._freeCamSavedQuat = new THREE.Quaternion();
    this._freeCamTheta = 0;
    this._freeCamPhi = Math.PI / 4;
    this._freeCamDist = 30;
    this._freeCamTarget = new THREE.Vector3(0, 0, 0);
    this._freeCamDragging = false;
    this._freeCamLastMouse = { x: 0, y: 0 };

    // ── Physics debug overlay ──
    this._physicsOverlayActive = false;
    this._physicsOverlayMeshes = [];

    // ── Bot AI visualizer ──
    this._aiVizActive = false;
    this._aiVizLines = [];
    this._aiVizLabels = [];

    // ── Performance stats ──
    this._perfStatsActive = false;
    this._perfDisplay = null;

    // ── Collision logger ──
    this._collisionLogActive = false;
    this._collisionLog = [];
    this._collisionLogMax = 8;
    this._collisionLogDisplay = null;
    this._onDamageForLog = (e) => this._logCollision(e);

    // ── Bot spawner ──
    this._selectedBotCarType = CAR_ORDER[0];

    // ── Power-up spawner ──
    this._selectedPowerupType = 'RANDOM';

    // ── 99-missile debug mode (per ammo type) ──
    this._debugAmmoLeft = { MISSILE: 0, HOMING_MISSILE: 0 };
    this._debugAmmoBtns = { MISSILE: null, HOMING_MISSILE: null };
    this._debugAmmoListenerInstalled = false;

    // ── Audio debug ──
    this._audioDebugActive = false;
    this._audioDebugHUD = null;

    // ── UI ──
    this._panel = null;
    this._buildUI();

    // ── Key binding ──
    window.addEventListener('keydown', (e) => {
      if (e.key === '\'') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle() {
    this.enabled = !this.enabled;
    this._panel.style.display = this.enabled ? 'block' : 'none';
    if (!this.enabled) {
      this._setHitboxes(false);
      this._setTeleportMode(false);
      this._setSpawnerMode(null);
    }
  }

  /** Time scale getter — Game._animate reads this to scale dt */
  get timeScale() { return this._timeScale; }

  // ── Per-frame update (call from game loop) ──

  update() {
    if (!this.enabled && !this._syncActive && !this._sandboxActive
        && !this._freeCamActive && !this._aiVizActive && !this._perfStatsActive
        && !this._collisionLogActive && !this._physicsOverlayActive
        && !this._audioDebugActive) return;

    // God mode
    if (this._godMode && this.game.localPlayer) {
      const lp = this.game.localPlayer;
      lp.hp = lp.maxHp;
      lp.isEliminated = false;
      lp.isInvincible = true;
    }

    // Sandbox: freeze timer
    if (this._sandboxActive) {
      this.game.gameState.timer = 0;
    }

    // Hitboxes
    if (this._showHitboxes) {
      this._updateHitboxes();
    }

    // Physics overlay
    if (this._physicsOverlayActive) {
      this._updatePhysicsOverlay();
    }

    // Bot AI visualizer
    if (this._aiVizActive) {
      this._updateAIViz();
    }

    // Performance stats
    if (this._perfStatsActive) {
      this._updatePerfStats();
    }

    // Collision log
    if (this._collisionLogActive) {
      this._updateCollisionLogDisplay();
    }

    // Free camera
    if (this._freeCamActive) {
      this._updateFreeCamera();
    }

    // Audio debug HUD
    if (this._audioDebugActive) {
      this._updateAudioDebugHUD();
    }

    // Info display
    if (this.enabled) {
      this._updateInfoDisplay();
    }
  }

  // ── Called from Game._fixedUpdate — apply sync input to mirror cars ──

  fixedUpdate(dt) {
    if (!this._syncActive || this._syncCars.length === 0) return;
    const input = this.game.input;
    for (const cb of this._syncCars) {
      if (cb.isEliminated) continue;
      cb.applyControls(input, dt);
    }
  }

  // =====================================================================
  //  UI PANEL
  // =====================================================================

  _buildUI() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      position:fixed;top:50px;left:16px;width:330px;max-height:90vh;
      overflow-y:auto;background:rgba(0,0,0,0.88);color:#0f0;
      font:12px 'Courier New',monospace;padding:12px;border-radius:8px;
      border:1px solid #0f0;z-index:1000;display:none;
      user-select:none;
    `;
    panel.innerHTML = `<div style="font-size:14px;font-weight:bold;margin-bottom:8px;color:#0f0;border-bottom:1px solid #0f04;padding-bottom:6px;">DEBUG MODE <span style="font-size:10px;color:#0f08">['] to toggle</span></div>`;

    // ── Toggles ──
    this._addSection(panel, 'TOGGLES');
    this._addToggle(panel, 'God Mode', false, (v) => {
      this._godMode = v;
      if (!v && this.game.localPlayer) this.game.localPlayer.isInvincible = false;
    });
    this._addToggle(panel, 'Show Hitboxes', false, (v) => this._setHitboxes(v));
    this._addToggle(panel, 'Teleport (click)', false, (v) => this._setTeleportMode(v));
    this._addToggle(panel, 'Debug Map (flat)', false, (v) => this._setDebugMap(v));
    this._addToggle(panel, 'Show FX: Tire Smoke', true, (v) => {
      if (this.game.tireSmokeFX) this.game.tireSmokeFX._points.visible = v;
    });
    this._addToggle(panel, 'Show FX: Stun', true, (v) => {
      if (this.game.stunFX) this.game.stunFX._debrisMesh.visible = v;
      this._stunFXVisible = v;
    });
    this._addToggle(panel, 'Show FX: Geyser', true, (v) => {
      this._geyserFXVisible = v;
      const gfx = this.game.dynamicHazards?._arena?.geyserFX;
      if (gfx) {
        gfx._dropletMesh.visible = v;
        gfx._splashRing.visible = v && gfx._splashActive;
        for (const slot of gfx._slots) {
          slot.steamPoints.visible = v && slot.steamActive;
          slot.fountainPoints.visible = v && slot.fountainActive;
        }
      }
    });
    this._stunFXVisible = true;
    this._geyserFXVisible = true;

    // ── Slow Motion ──
    this._addSection(panel, 'TIME SCALE');
    this._addSlider(panel, 'timeScale', 0.1, 2.0, 1.0, 0.05, (v) => { this._timeScale = v; });

    // ── Free Camera ──
    this._addSection(panel, 'FREE CAMERA');
    this._addToggle(panel, 'Free Camera (orbit)', false, (v) => this._setFreeCamera(v));

    // ── Physics Debug Overlay ──
    this._addSection(panel, 'PHYSICS OVERLAY');
    this._addToggle(panel, 'Show Physics Bodies', false, (v) => this._setPhysicsOverlay(v));

    // ── Bot AI Visualizer ──
    this._addSection(panel, 'BOT AI VISUALIZER');
    this._addToggle(panel, 'Show Bot AI', false, (v) => this._setAIViz(v));

    // ── Performance Stats ──
    this._addSection(panel, 'PERFORMANCE STATS');
    this._addToggle(panel, 'Show Perf Stats', false, (v) => this._setPerfStats(v));

    // ── Collision Logger ──
    this._addSection(panel, 'COLLISION LOG');
    this._addToggle(panel, 'Show Collision Log', false, (v) => this._setCollisionLog(v));

    // ── Swap Car ──
    this._addSection(panel, 'SWAP CAR');
    this._swapCarLabel = document.createElement('div');
    this._swapCarLabel.style.cssText = 'color:#0f0;font-size:11px;margin:2px 0;text-align:center;';
    this._swapCarLabel.textContent = `Current: ${this.game.localPlayer?.carType || '?'}`;
    panel.appendChild(this._swapCarLabel);
    {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;margin:3px 0;';
      const prevBtn = document.createElement('button');
      prevBtn.textContent = '◀ Prev';
      prevBtn.style.cssText = `flex:1;padding:4px;background:#0f02;color:#0f0;border:1px solid #0f04;border-radius:3px;cursor:pointer;font:11px 'Courier New',monospace;`;
      prevBtn.addEventListener('mouseenter', () => { prevBtn.style.background = '#0f04'; });
      prevBtn.addEventListener('mouseleave', () => { prevBtn.style.background = '#0f02'; });
      prevBtn.addEventListener('click', () => this._swapCar(-1));
      const nextBtn = document.createElement('button');
      nextBtn.textContent = 'Next ▶';
      nextBtn.style.cssText = `flex:1;padding:4px;background:#0f02;color:#0f0;border:1px solid #0f04;border-radius:3px;cursor:pointer;font:11px 'Courier New',monospace;`;
      nextBtn.addEventListener('mouseenter', () => { nextBtn.style.background = '#0f04'; });
      nextBtn.addEventListener('mouseleave', () => { nextBtn.style.background = '#0f02'; });
      nextBtn.addEventListener('click', () => this._swapCar(1));
      row.appendChild(prevBtn);
      row.appendChild(nextBtn);
      panel.appendChild(row);
    }

    this._addSection(panel, 'SANDBOX MODE');
    this._addButton(panel, 'Enter Sandbox (flat, no enemies, no timer)', () => this._enterSandbox());
    this._addButton(panel, 'Exit Sandbox', () => this._exitSandbox());

    // ── Entity Spawner ──
    this._addSection(panel, 'ENTITY SPAWNER (click to place)');
    this._addButton(panel, 'Spawn: Missile (click)', () => this._setSpawnerMode('missile'));
    this._addButton(panel, 'Spawn: Homing Missile (click)', () => this._setSpawnerMode('homing'));
    this._addButton(panel, 'Spawn: Geyser (click)', () => this._setSpawnerMode('geyser'));
    this._addButton(panel, 'Stop Spawner', () => this._setSpawnerMode(null));

    // ── Bot Spawner ──
    this._addSection(panel, 'BOT SPAWNER (click to place)');
    const botRow = document.createElement('div');
    botRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;';
    const botSelect = document.createElement('select');
    botSelect.style.cssText = 'flex:1;background:#0f02;color:#0f0;border:1px solid #0f04;font:11px monospace;padding:2px;';
    for (const ct of CAR_ORDER) {
      const opt = document.createElement('option');
      opt.value = ct; opt.textContent = ct;
      botSelect.appendChild(opt);
    }
    botSelect.addEventListener('change', () => { this._selectedBotCarType = botSelect.value; });
    botRow.appendChild(botSelect);
    panel.appendChild(botRow);
    this._addButton(panel, 'Spawn Bot at Click', () => this._setSpawnerMode('bot'));
    this._addButton(panel, 'Remove All Bots', () => {
      this.game.botManager.removeAll();
      this.game.nameTags.clear();
      this.game.healthBars.clear();
      if (this.game.localPlayer) {
        this.game.nameTags.add(this.game.localPlayer, true);
        this.game.healthBars.add(this.game.localPlayer, true);
      }
    });

    // ── Power-up Spawner ──
    this._addSection(panel, 'POWER-UP SPAWNER (click to place)');
    const puRow = document.createElement('div');
    puRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;';
    const puSelect = document.createElement('select');
    puSelect.style.cssText = 'flex:1;background:#0f02;color:#0f0;border:1px solid #0f04;font:11px monospace;padding:2px;';
    const randOpt = document.createElement('option');
    randOpt.value = 'RANDOM'; randOpt.textContent = 'RANDOM';
    puSelect.appendChild(randOpt);
    for (const pt of POWERUP_TYPES) {
      const opt = document.createElement('option');
      opt.value = pt; opt.textContent = pt;
      puSelect.appendChild(opt);
    }
    puSelect.addEventListener('change', () => { this._selectedPowerupType = puSelect.value; });
    puRow.appendChild(puSelect);
    panel.appendChild(puRow);
    this._addButton(panel, 'Spawn Power-up Box at Click', () => this._setSpawnerMode('powerup'));

    // ── Glitch Bomb Tester ──
    this._addSection(panel, 'GLITCH BOMB TESTER');
    this._addButton(panel, 'Simulate Glitch on Self', () => {
      const pm = this.game.powerUpManager;
      if (pm) pm.applyGlitchToSelf();
    });
    this._addButton(panel, 'Give Glitch Bomb to Player', () => {
      const lp = this.game.localPlayer;
      const pm = this.game.powerUpManager;
      if (lp && pm) {
        pm._held.set(lp, 'GLITCH_BOMB');
        pm._emit('pickup', { car: lp, type: 'GLITCH_BOMB', pedestalIndex: -1 });
      }
    });

    // ── 99 Missiles ──
    this._addSection(panel, 'MISSILE DEBUG');
    for (const ammoType of ['MISSILE', 'HOMING_MISSILE']) {
      const btn = document.createElement('button');
      btn.style.cssText = `
        display:block;width:100%;margin:3px 0;padding:4px 8px;
        background:#0f02;color:#0f0;border:1px solid #0f04;
        border-radius:3px;cursor:pointer;font:11px 'Courier New',monospace;
        text-align:left;
      `;
      btn.addEventListener('mouseenter', () => { btn.style.background = '#0f04'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = '#0f02'; });
      btn.addEventListener('click', () => this._giveNinetyNineMissiles(ammoType));
      this._debugAmmoBtns[ammoType] = btn;
      this._updateMissileBtnLabel(ammoType);
      panel.appendChild(btn);
    }

    // ── Instant Elimination / Respawn ──
    this._addSection(panel, 'ELIMINATION / RESPAWN');
    this._addButton(panel, 'Eliminate Player', () => {
      const lp = this.game.localPlayer;
      if (lp && !lp.isEliminated) lp.takeDamage(lp.hp + 1, null, false);
    });
    this._addButton(panel, 'Respawn Player (center)', () => {
      const lp = this.game.localPlayer;
      if (!lp) return;
      lp.hp = lp.maxHp;
      lp.isEliminated = false;
      lp.mesh.visible = true;
      lp.resetState();
      lp.setPosition(0, 0.6, 0);
      lp._yaw = 0;
      lp.body.quaternion.setFromEuler(0, 0, 0);
    });
    this._addButton(panel, 'Eliminate All Bots', () => {
      for (const bot of this.game.botManager.bots) {
        if (!bot.carBody.isEliminated) {
          bot.carBody.takeDamage(bot.carBody.hp + 1, this.game.localPlayer, false);
        }
      }
    });
    this._addButton(panel, 'Respawn All Bots', () => {
      for (let i = 0; i < this.game.botManager.bots.length; i++) {
        const bot = this.game.botManager.bots[i];
        const cb = bot.carBody;
        cb.hp = cb.maxHp;
        cb.isEliminated = false;
        cb.mesh.visible = true;
        cb.resetState();
        const sp = getSpawnPosition(i + 1);
        cb.setPosition(sp.x, sp.y, sp.z, sp.yaw);
        bot.brain.reset();
      }
    });

    // ── Multi-Vehicle Sync ──
    this._addSection(panel, 'MULTI-VEHICLE SYNC INPUT');
    this._syncCarSelect = {};
    const syncRow = document.createElement('div');
    syncRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;';
    for (const carType of CAR_ORDER) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:2px;font-size:10px;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'accent-color:#0f0;cursor:pointer;';
      this._syncCarSelect[carType] = cb;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(carType));
      syncRow.appendChild(label);
    }
    panel.appendChild(syncRow);
    this._addButton(panel, 'Start Sync Test (line up selected cars)', () => this._startSyncTest());
    this._addButton(panel, 'Remove Sync Cars', () => this._removeSyncCars());

    // ── Spawn Controls ──
    this._addSection(panel, 'SPAWN CONTROLS');
    this._addButton(panel, 'Reset Position (center)', () => this._resetPosition());
    this._addButton(panel, 'Reset Velocity', () => this._resetVelocity());
    this._addSlider(panel, 'Spawn Angle', 0, 360, 0, 1, (v) => this._spawnAngle = v);
    this._spawnAngle = 0;
    this._addButton(panel, 'Spawn at Angle', () => this._spawnAtAngle());
    this._addButton(panel, 'Apply Forward Impulse (20)', () => this._applyImpulse(20));
    this._addButton(panel, 'Apply Forward Impulse (40)', () => this._applyImpulse(40));

    // ── Audio Debug ──
    this._addSection(panel, 'AUDIO DEBUG');
    this._addToggle(panel, 'Audio Debug HUD (on-screen)', false, (v) => this._setAudioDebug(v));

    // Gear simulation sliders (live tweak)
    this._addSlider(panel, 'shiftDropFrac', 0.2, 0.8, GEAR_DEFAULTS.shiftDropFrac, 0.05,
      (v) => { GEAR_DEFAULTS.shiftDropFrac = v; });
    this._addSlider(panel, 'shiftDuration', 0.02, 0.5, GEAR_DEFAULTS.shiftDuration, 0.01,
      (v) => { GEAR_DEFAULTS.shiftDuration = v; });
    this._addSlider(panel, 'rpmSmoothingUp', 1, 20, GEAR_DEFAULTS.rpmSmoothingUp, 0.5,
      (v) => { GEAR_DEFAULTS.rpmSmoothingUp = v; });
    this._addSlider(panel, 'rpmSmoothingDown', 1, 20, GEAR_DEFAULTS.rpmSmoothingDown, 0.5,
      (v) => { GEAR_DEFAULTS.rpmSmoothingDown = v; });
    this._addSlider(panel, 'throttleSmoothUp', 1, 20, GEAR_DEFAULTS.throttleSmoothingUp, 0.5,
      (v) => { GEAR_DEFAULTS.throttleSmoothingUp = v; });
    this._addSlider(panel, 'throttleSmoothDown', 1, 20, GEAR_DEFAULTS.throttleSmoothingDown, 0.5,
      (v) => { GEAR_DEFAULTS.throttleSmoothingDown = v; });
    this._addSlider(panel, 'downshiftHysteresis', 0, 0.15, GEAR_DEFAULTS.downshiftHysteresis, 0.01,
      (v) => { GEAR_DEFAULTS.downshiftHysteresis = v; });

    // RPM crossfade fractions
    this._addSlider(panel, 'rpmCrossfade lowFrac', 0.1, 0.5, RPM_CROSSFADE_FRACTIONS.lowFrac, 0.05,
      (v) => { RPM_CROSSFADE_FRACTIONS.lowFrac = v; });
    this._addSlider(panel, 'rpmCrossfade highFrac', 0.4, 0.9, RPM_CROSSFADE_FRACTIONS.highFrac, 0.05,
      (v) => { RPM_CROSSFADE_FRACTIONS.highFrac = v; });

    // Volume controls
    this._addSlider(panel, 'ENGINE bus vol', 0, 1, AUDIO_VOLUMES[AUDIO_BUS.ENGINE], 0.05,
      (v) => { AUDIO_VOLUMES[AUDIO_BUS.ENGINE] = v; audioManager.setBusVolume(AUDIO_BUS.ENGINE, v); });
    this._addSlider(panel, 'SFX bus vol', 0, 1, AUDIO_VOLUMES[AUDIO_BUS.SFX], 0.05,
      (v) => { AUDIO_VOLUMES[AUDIO_BUS.SFX] = v; audioManager.setBusVolume(AUDIO_BUS.SFX, v); });
    this._addSlider(panel, 'MUSIC bus vol', 0, 1, AUDIO_VOLUMES[AUDIO_BUS.MUSIC], 0.05,
      (v) => { AUDIO_VOLUMES[AUDIO_BUS.MUSIC] = v; audioManager.setBusVolume(AUDIO_BUS.MUSIC, v); });
    this._addSlider(panel, 'Master vol', 0, 1, AUDIO_VOLUMES.master, 0.05,
      (v) => { AUDIO_VOLUMES.master = v; audioManager.setMasterVolume(v); });
    this._addSlider(panel, 'localBoost', 0, 3, SPATIAL.localBoost, 0.1,
      (v) => { SPATIAL.localBoost = v; });

    // Spatial audio
    this._addSlider(panel, 'spatial refDist', 1, 20, SPATIAL.refDistance, 1,
      (v) => { SPATIAL.refDistance = v; });
    this._addSlider(panel, 'spatial maxDist', 10, 100, SPATIAL.maxDistance, 5,
      (v) => { SPATIAL.maxDistance = v; });
    this._addSlider(panel, 'LOD full dist', 5, 40, SPATIAL.lodFull, 5,
      (v) => { SPATIAL.lodFull = v; });
    this._addSlider(panel, 'LOD medium dist', 10, 60, SPATIAL.lodMedium, 5,
      (v) => { SPATIAL.lodMedium = v; });

    // ── Info Display ──
    this._addSection(panel, 'PLAYER STATE');
    this._infoDisplay = document.createElement('div');
    this._infoDisplay.style.cssText = 'color:#0f0;font-size:11px;line-height:1.5;white-space:pre;';
    panel.appendChild(this._infoDisplay);

    // ── Car Feel ──
    this._addSection(panel, 'CAR FEEL');
    this._addSlider(panel, 'maxSteerAngle', 0.01, 0.3, CAR_FEEL.maxSteerAngle, 0.005,
      (v) => { CAR_FEEL.maxSteerAngle = v; });
    this._addSlider(panel, 'steerSpeed', 0.01, 0.5, CAR_FEEL.steerSpeed, 0.01,
      (v) => { CAR_FEEL.steerSpeed = v; });
    this._addSlider(panel, 'steerReturnSpeed', 0.01, 0.5, CAR_FEEL.steerReturnSpeed, 0.01,
      (v) => { CAR_FEEL.steerReturnSpeed = v; });
    this._addSlider(panel, 'steerAtSpeed', 0, 1, CAR_FEEL.steerAtSpeed, 0.05,
      (v) => { CAR_FEEL.steerAtSpeed = v; });
    this._addSlider(panel, 'lateralFriction', 0.5, 0.99, CAR_FEEL.lateralFriction, 0.01,
      (v) => { CAR_FEEL.lateralFriction = v; });
    this._addSlider(panel, 'groundFriction', 0.9, 0.999, CAR_FEEL.groundFriction, 0.001,
      (v) => { CAR_FEEL.groundFriction = v; });
    this._addSlider(panel, 'drag', 0.97, 0.999, CAR_FEEL.drag, 0.001,
      (v) => { CAR_FEEL.drag = v; });
    this._addSlider(panel, 'brakeDecel', 5, 60, CAR_FEEL.brakeDecel, 1,
      (v) => { CAR_FEEL.brakeDecel = v; });

    // ── Drift ──
    this._addSection(panel, 'DRIFT');
    this._addSlider(panel, 'driftLateralFric', 0.3, 0.95, CAR_FEEL.driftLateralFriction, 0.01,
      (v) => { CAR_FEEL.driftLateralFriction = v; });
    this._addSlider(panel, 'driftSteerMult', 1, 3, CAR_FEEL.driftSteerMultiplier, 0.1,
      (v) => { CAR_FEEL.driftSteerMultiplier = v; });
    this._addSlider(panel, 'driftDragOverride', 0.95, 0.999, CAR_FEEL.driftDragOverride, 0.001,
      (v) => { CAR_FEEL.driftDragOverride = v; });

    // ── Physics ──
    this._addSection(panel, 'PHYSICS');
    this._addSlider(panel, 'maxVelocity', 10, 100, PHYSICS.maxVelocity, 1,
      (v) => { PHYSICS.maxVelocity = v; });

    // ── Camera ──
    this._addSection(panel, 'CAMERA');
    this._addSlider(panel, 'followDist', 2, 20, CAR_FEEL.camera.followDist, 0.5,
      (v) => { CAR_FEEL.camera.followDist = v; });
    this._addSlider(panel, 'height', 1, 15, CAR_FEEL.camera.height, 0.5,
      (v) => { CAR_FEEL.camera.height = v; });
    this._addSlider(panel, 'lookAhead', 0, 15, CAR_FEEL.camera.lookAhead, 0.5,
      (v) => { CAR_FEEL.camera.lookAhead = v; });
    this._addSlider(panel, 'baseFOV', 20, 90, CAR_FEEL.camera.baseFOV, 1,
      (v) => { CAR_FEEL.camera.baseFOV = v; });
    this._addSlider(panel, 'speedPullback', 0, 15, CAR_FEEL.camera.speedPullback, 0.5,
      (v) => { CAR_FEEL.camera.speedPullback = v; });

    // ── Damage ──
    this._addSection(panel, 'DAMAGE');
    this._addSlider(panel, 'BASE_DAMAGE', 1, 30, DAMAGE.BASE_DAMAGE, 1,
      (v) => { DAMAGE.BASE_DAMAGE = v; });
    this._addSlider(panel, 'MAX_HP', 10, 500, DAMAGE.MAX_HP, 10,
      (v) => { DAMAGE.MAX_HP = v; });
    this._addSlider(panel, 'LAVA_DPS', 0, 100, DAMAGE.LAVA_DPS, 5,
      (v) => { DAMAGE.LAVA_DPS = v; });
    this._addSlider(panel, 'OBSTACLE_DAMAGE', 0, 30, DAMAGE.OBSTACLE_DAMAGE, 1,
      (v) => { DAMAGE.OBSTACLE_DAMAGE = v; });

    // ── Obstacle Stun ──
    this._addSection(panel, 'OBSTACLE STUN');
    this._addSlider(panel, 'minStunSpeed', 1, 20, OBSTACLE_STUN.minStunSpeed, 1,
      (v) => { OBSTACLE_STUN.minStunSpeed = v; });
    this._addSlider(panel, 'maxDuration', 0.2, 5, OBSTACLE_STUN.maxDuration, 0.1,
      (v) => { OBSTACLE_STUN.maxDuration = v; });
    this._addSlider(panel, 'bounceForce', 0, 15, OBSTACLE_STUN.bounceForce, 0.5,
      (v) => { OBSTACLE_STUN.bounceForce = v; });

    document.body.appendChild(panel);
    this._panel = panel;
    this._makeDraggable(panel);
  }

  // ── UI helpers ──

  /**
   * Make a fixed-position element draggable by clicking and dragging anywhere on it.
   * Pointer events are re-enabled on the element so interactive children (sliders, checkboxes) still work.
   */
  _makeDraggable(el) {
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    const onPointerDown = (e) => {
      // Don't drag when interacting with inputs
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      el.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Switch to left/top positioning (clear right/bottom)
      el.style.left = (origLeft + dx) + 'px';
      el.style.top = (origTop + dy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = '';
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  _addSection(parent, title) {
    const el = document.createElement('div');
    el.style.cssText = 'color:#0f0;font-weight:bold;margin-top:10px;margin-bottom:4px;font-size:11px;border-bottom:1px solid #0f03;padding-bottom:2px;';
    el.textContent = `── ${title} ──`;
    parent.appendChild(el);
  }

  _addToggle(parent, label, initial, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;margin:3px 0;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = initial;
    cb.style.cssText = 'margin-right:6px;accent-color:#0f0;cursor:pointer;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cursor = 'pointer';
    row.appendChild(cb);
    row.appendChild(lbl);
    row.addEventListener('click', (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
      onChange(cb.checked);
    });
    parent.appendChild(row);
  }

  _updateMissileBtnLabel(type) {
    const btn = this._debugAmmoBtns[type];
    if (!btn) return;
    const n = this._debugAmmoLeft[type];
    const label = type === 'HOMING_MISSILE' ? 'Homing Missiles' : 'Missiles';
    btn.textContent = n > 0
      ? `99 ${label}: ON (${n} left) — click to refill`
      : `Give 99 ${label} to Player`;
  }

  _giveNinetyNineMissiles(type = 'MISSILE') {
    const lp = this.game.localPlayer;
    const pm = this.game.powerUpManager;
    if (!lp || !pm) return;

    this._debugAmmoLeft[type] = 99;
    pm._held.set(lp, type);
    pm._emit('pickup', { car: lp, type, pedestalIndex: -1 });

    if (!this._debugAmmoListenerInstalled) {
      pm.on('used', ({ car, type: usedType }) => {
        if (car !== this.game.localPlayer) return;
        if (!(usedType in this._debugAmmoLeft)) return;
        if (this._debugAmmoLeft[usedType] <= 0) return;
        this._debugAmmoLeft[usedType]--;
        if (this._debugAmmoLeft[usedType] > 0) {
          pm._held.set(car, usedType);
          pm._emit('pickup', { car, type: usedType, pedestalIndex: -1 });
        }
        this._updateMissileBtnLabel(usedType);
      });
      this._debugAmmoListenerInstalled = true;
    }
    this._updateMissileBtnLabel(type);
  }

  _addButton(parent, label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      display:block;width:100%;margin:3px 0;padding:4px 8px;
      background:#0f02;color:#0f0;border:1px solid #0f04;
      border-radius:3px;cursor:pointer;font:11px 'Courier New',monospace;
      text-align:left;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = '#0f04'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0f02'; });
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
  }

  _addSlider(parent, label, min, max, initial, step, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;margin:2px 0;gap:6px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'flex:0 0 120px;font-size:10px;overflow:hidden;text-overflow:ellipsis;';
    lbl.textContent = label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.value = initial; slider.step = step;
    slider.style.cssText = 'flex:1;height:14px;accent-color:#0f0;cursor:pointer;';
    const val = document.createElement('span');
    val.style.cssText = 'flex:0 0 50px;font-size:10px;text-align:right;color:#0f0;';
    val.textContent = Number(initial).toFixed(3);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      val.textContent = v.toFixed(3);
      onChange(v);
    });
    row.appendChild(lbl); row.appendChild(slider); row.appendChild(val);
    parent.appendChild(row);
  }

  // =====================================================================
  //  INFO DISPLAY
  // =====================================================================

  _updateInfoDisplay() {
    const lp = this.game.localPlayer;
    if (!lp || !this._infoDisplay) return;
    const pos = lp.body.position;
    const vel = lp.body.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const yawDeg = ((lp._yaw * 180 / Math.PI) % 360).toFixed(1);
    let text =
      `pos:   ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}\n` +
      `vel:   ${vel.x.toFixed(1)}, ${vel.z.toFixed(1)}  (${speed.toFixed(1)} u/s)\n` +
      `yaw:   ${yawDeg} deg\n` +
      `speed: ${lp._currentSpeed.toFixed(1)} u/s\n` +
      `steer: ${lp._steerAngle.toFixed(3)} rad\n` +
      `hp:    ${lp.hp.toFixed(0)} / ${lp.maxHp}\n` +
      `stun:  ${lp._isStunned ? lp._stunTimer.toFixed(2) + 's' : 'no'}\n` +
      `drift: ${lp.driftMode ? 'ON' : 'off'}  shield: ${lp.hasShield ? 'ON' : 'off'}\n` +
      `time:  ${this._timeScale.toFixed(2)}x`;
    if (this._syncActive) {
      text += `\n\n── SYNC CARS (${this._syncCars.length}) ──`;
      for (const sc of this._syncCars) {
        const sp = Math.abs(sc._currentSpeed).toFixed(1);
        text += `\n${sc.carType}: ${sp} u/s  steer:${sc._steerAngle.toFixed(3)}`;
      }
    }
    this._infoDisplay.textContent = text;
  }

  // =====================================================================
  //  AUDIO DEBUG
  // =====================================================================

  _setAudioDebug(on) {
    this._audioDebugActive = on;
    if (on) {
      if (!this._audioDebugHUD) {
        const hud = document.createElement('div');
        hud.style.cssText = `
          position:fixed; top:50%; right:16px; transform:translateY(-50%);
          z-index:1000;
          background:rgba(0,0,0,0.88); color:#0f0; font-family:'Courier New',monospace;
          font-size:11px; padding:10px 14px; border-radius:6px;
          white-space:pre; line-height:1.6;
          border:1px solid #0f0; min-width:340px;
          user-select:none; max-height:90vh; overflow-y:auto;
        `;
        document.body.appendChild(hud);
        this._makeDraggable(hud);
        // After first drag, clear transform so left/top positioning works cleanly
        hud.addEventListener('pointerdown', () => { hud.style.transform = 'none'; }, { once: true });
        this._audioDebugHUD = hud;
      }
      this._audioDebugHUD.style.display = 'block';
    } else if (this._audioDebugHUD) {
      this._audioDebugHUD.style.display = 'none';
    }
  }

  _updateAudioDebugHUD() {
    if (!this._audioDebugHUD) return;
    const lp = this.game.localPlayer;
    if (!lp) { this._audioDebugHUD.textContent = 'No local player'; return; }

    // Get engine voice data from sampleEngineAudio
    const voice = sampleEngineAudio._engines.get(lp);
    if (!voice) { this._audioDebugHUD.textContent = 'No engine voice for local player'; return; }

    const { gearSim, layers, carGain, profile } = voice;
    const rpm = gearSim.rpm;
    const throttle = gearSim.throttle;
    const gear = gearSim.gear;
    const totalGears = profile.gears.length;

    // Speed info
    const absSpeed = Math.abs(lp._currentSpeed);
    const effectiveMax = Math.max(lp.maxSpeed * lp.speedMultiplier, 1);
    const speedFrac = Math.min(absSpeed / effectiveMax, 1);

    // RPM bar (visual)
    const rpmFrac = (rpm - profile.idleRPM) / (profile.redlineRPM - profile.idleRPM);
    const rpmBarLen = 25;
    const rpmFilled = Math.round(rpmFrac * rpmBarLen);
    const rpmBar = '[' + '#'.repeat(rpmFilled) + '-'.repeat(rpmBarLen - rpmFilled) + ']';

    // Throttle bar
    const thrBarLen = 15;
    const thrFilled = Math.round(throttle * thrBarLen);
    const thrBar = '[' + '#'.repeat(thrFilled) + '-'.repeat(thrBarLen - thrFilled) + ']';

    // Per-layer gains and detune
    const layerKeys = ['on_low', 'off_low', 'on_high', 'off_high'];
    let layerInfo = '';
    for (const key of layerKeys) {
      const layer = layers[key];
      if (!layer) {
        layerInfo += `  ${key.padEnd(9)}: [NO SAMPLE]\n`;
        continue;
      }
      const g = layer.gainNode.gain.value;
      const d = layer.source.detune.value;
      const active = g > 0.001 ? '\x1b[32m*\x1b[0m' : ' ';
      // Use simple chars for active indicator
      const indicator = g > 0.001 ? '>>>' : '   ';
      layerInfo += `  ${indicator} ${key.padEnd(9)}: gain=${g.toFixed(3)}  detune=${d.toFixed(0)}c  (rec@${layer.sampleRPM}rpm)\n`;
    }

    // RPM crossfade thresholds for this car
    const rpmRange = profile.redlineRPM - profile.idleRPM;
    const crossLow = profile.idleRPM + RPM_CROSSFADE_FRACTIONS.lowFrac * rpmRange;
    const crossHigh = profile.idleRPM + RPM_CROSSFADE_FRACTIONS.highFrac * rpmRange;

    // Gear boundaries
    let gearBounds = '';
    for (let i = 0; i < profile.gears.length; i++) {
      const topSpeed = (profile.gears[i].maxSpeedFrac * effectiveMax).toFixed(1);
      const isCurrent = i === gearSim._currentGear;
      gearBounds += isCurrent ? `[G${i + 1}:${topSpeed}]` : ` G${i + 1}:${topSpeed} `;
    }

    // Shift state
    const shiftState = gearSim._shiftTimer > 0
      ? `SHIFTING (${gearSim._shiftTimer.toFixed(3)}s left, ${gearSim._shiftFromRPM.toFixed(0)}->${gearSim._shiftTargetRPM.toFixed(0)})`
      : 'idle';

    // Camera/listener distance
    const camDist = audioManager.distanceToListener(lp.body.position.x, lp.body.position.z);

    // Voice count
    const totalVoices = audioManager._voices.size;

    const text =
      `=== AUDIO DEBUG === ${lp.carType} (${profile.sampleSet})\n` +
      `\n` +
      `SPEED: ${absSpeed.toFixed(1)}/${effectiveMax.toFixed(1)} u/s (${(speedFrac * 100).toFixed(1)}%)\n` +
      `GEAR:  ${gear}/${totalGears}   ${gearBounds}\n` +
      `SHIFT: ${shiftState}\n` +
      `RPM:   ${rpm.toFixed(0)} ${rpmBar} (${profile.idleRPM}-${profile.redlineRPM})\n` +
      `THRTL: ${throttle.toFixed(3)} ${thrBar}  accelInput=${lp._accelInput}\n` +
      `\n` +
      `RPM CROSSFADE: low=${crossLow.toFixed(0)} high=${crossHigh.toFixed(0)}\n` +
      `\n` +
      `LAYERS:\n` +
      layerInfo +
      `\n` +
      `CAR GAIN:  ${carGain.gain.value.toFixed(3)}  (localBoost=${SPATIAL.localBoost})\n` +
      `CAM DIST:  ${camDist.toFixed(1)}u  (ref=${SPATIAL.refDistance} max=${SPATIAL.maxDistance})\n` +
      `VOICES:    ${totalVoices} registered\n` +
      `\n` +
      `GEAR PARAMS: drop=${GEAR_DEFAULTS.shiftDropFrac} dur=${GEAR_DEFAULTS.shiftDuration}s\n` +
      `RPM SMOOTH:  up=${GEAR_DEFAULTS.rpmSmoothingUp} dn=${GEAR_DEFAULTS.rpmSmoothingDown}\n` +
      `THR SMOOTH:  up=${GEAR_DEFAULTS.throttleSmoothingUp} dn=${GEAR_DEFAULTS.throttleSmoothingDown}`;

    this._audioDebugHUD.textContent = text;
  }

  // =====================================================================
  //  HITBOX VISUALIZATION
  // =====================================================================

  _setHitboxes(on) {
    this._showHitboxes = on;
    if (!on) {
      for (const h of this._hitboxMeshes) {
        this.scene.remove(h.mesh);
        h.mesh.geometry.dispose();
      }
      this._hitboxMeshes = [];
    }
  }

  _updateHitboxes() {
    // Remove stale
    for (let i = this._hitboxMeshes.length - 1; i >= 0; i--) {
      const h = this._hitboxMeshes[i];
      if (h.type === 'car' && !this.game.carBodies.includes(h.source)) {
        this.scene.remove(h.mesh); h.mesh.geometry.dispose();
        this._hitboxMeshes.splice(i, 1);
      }
    }

    // Cars
    for (const cb of this.game.carBodies) {
      if (cb.isEliminated) continue;
      let existing = this._hitboxMeshes.find(h => h.source === cb && h.type === 'car');
      if (!existing) {
        const geo = new THREE.BoxGeometry(2.0, 1.2, 1.2);
        const mesh = new THREE.Mesh(geo, this._hitboxMaterial);
        this.scene.add(mesh);
        existing = { mesh, source: cb, type: 'car' };
        this._hitboxMeshes.push(existing);
      }
      existing.mesh.position.copy(cb.body.position);
      existing.mesh.quaternion.copy(cb.body.quaternion);
    }

    // Obstacles
    for (const ob of this.game.physicsWorld.obstacleBodies) {
      let existing = this._hitboxMeshes.find(h => h.source === ob && h.type === 'obstacle');
      if (!existing) {
        const r = ob._obstacleRadius || 2;
        const geo = new THREE.CylinderGeometry(r, r, 5, 8);
        const mesh = new THREE.Mesh(geo, this._hitboxObstacleMat);
        this.scene.add(mesh);
        existing = { mesh, source: ob, type: 'obstacle' };
        this._hitboxMeshes.push(existing);
      }
      existing.mesh.position.copy(ob.position);
    }

    // Missiles
    const projectiles = this.game.powerUpManager._projectiles;
    for (let i = this._hitboxMeshes.length - 1; i >= 0; i--) {
      const h = this._hitboxMeshes[i];
      if (h.type === 'missile' && !projectiles.includes(h.source)) {
        this.scene.remove(h.mesh); h.mesh.geometry.dispose();
        this._hitboxMeshes.splice(i, 1);
      }
    }
    for (const p of projectiles) {
      if (!p.alive) continue;
      let existing = this._hitboxMeshes.find(h => h.source === p && h.type === 'missile');
      if (!existing) {
        const geo = new THREE.SphereGeometry(1.5, 8, 6);
        const mesh = new THREE.Mesh(geo, this._hitboxMissileMat);
        this.scene.add(mesh);
        existing = { mesh, source: p, type: 'missile' };
        this._hitboxMeshes.push(existing);
      }
      existing.mesh.position.set(p.x, p.y, p.z);
    }

    // Trail fire
    const trailBodies = AbilitySystem._activeTrailBodies;
    if (trailBodies) {
      for (let i = this._hitboxMeshes.length - 1; i >= 0; i--) {
        const h = this._hitboxMeshes[i];
        if (h.type === 'trail' && (!trailBodies.has(h.source) || !h.source._isTrailFire)) {
          this.scene.remove(h.mesh); h.mesh.geometry.dispose();
          this._hitboxMeshes.splice(i, 1);
        }
      }
      for (const wb of trailBodies) {
        if (!wb._isTrailFire) continue;
        let existing = this._hitboxMeshes.find(h => h.source === wb && h.type === 'trail');
        if (!existing) {
          const geo = new THREE.SphereGeometry(1.2, 6, 4);
          const mesh = new THREE.Mesh(geo, this._hitboxTrailMat);
          this.scene.add(mesh);
          existing = { mesh, source: wb, type: 'trail' };
          this._hitboxMeshes.push(existing);
        }
        existing.mesh.position.copy(wb.position);
      }
    }
  }

  // =====================================================================
  //  TELEPORT
  // =====================================================================

  _setTeleportMode(on) {
    this._teleportMode = on;
    if (on) {
      this._setSpawnerMode(null); // disable spawner if active
      this._teleportHandler = (e) => this._handleTeleportClick(e);
      window.addEventListener('click', this._teleportHandler);
      document.body.style.cursor = 'crosshair';
      if (!this._teleportMarker) {
        const geo = new THREE.RingGeometry(0.8, 1.2, 16);
        geo.rotateX(-Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x00ff00, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
        });
        this._teleportMarker = new THREE.Mesh(geo, mat);
        this._teleportMarker.visible = false;
        this.scene.add(this._teleportMarker);
      }
    } else {
      if (this._teleportHandler) {
        window.removeEventListener('click', this._teleportHandler);
        this._teleportHandler = null;
      }
      document.body.style.cursor = '';
      if (this._teleportMarker) this._teleportMarker.visible = false;
    }
  }

  _handleTeleportClick(e) {
    if (!this.game.localPlayer || this._panel.contains(e.target)) return;
    const target = this._raycastGround(e);
    if (!target) return;
    const lp = this.game.localPlayer;
    lp.body.position.set(target.x, 0.6, target.z);
    lp.body.velocity.set(0, 0, 0);
    lp._currentSpeed = 0;
    lp._internalVelX = 0; lp._internalVelZ = 0;
    lp._lastSetVelX = 0; lp._lastSetVelZ = 0;
    lp._smoothPosX = target.x; lp._smoothPosZ = target.z;
    lp._prevPosX = target.x; lp._prevPosY = 0.6; lp._prevPosZ = target.z;
    this._teleportMarker.position.set(target.x, 0.62, target.z);
    this._teleportMarker.visible = true;
    setTimeout(() => { if (this._teleportMarker) this._teleportMarker.visible = false; }, 300);
  }

  _raycastGround(e) {
    this._mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouseNDC, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
    const target = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(plane, target) ? target : null;
  }

  // =====================================================================
  //  SPAWN CONTROLS
  // =====================================================================

  _resetPosition() {
    const lp = this.game.localPlayer;
    if (!lp) return;
    lp.setPosition(0, 0.6, 0);
    lp._yaw = 0;
    lp.body.quaternion.setFromEuler(0, 0, 0);
  }

  _resetVelocity() {
    const lp = this.game.localPlayer;
    if (!lp) return;
    lp.body.velocity.set(0, 0, 0);
    lp._currentSpeed = 0;
    lp._internalVelX = 0; lp._internalVelZ = 0;
    lp._lastSetVelX = 0; lp._lastSetVelZ = 0;
  }

  _spawnAtAngle() {
    const lp = this.game.localPlayer;
    if (!lp) return;
    const rad = (this._spawnAngle * Math.PI) / 180;
    const r = 30;
    lp.setPosition(Math.cos(rad) * r, 0.6, Math.sin(rad) * r);
    lp._yaw = rad + Math.PI;
    lp.body.quaternion.setFromEuler(0, lp._yaw, 0);
  }

  _applyImpulse(strength) {
    const lp = this.game.localPlayer;
    if (!lp) return;
    const fwdX = -Math.sin(lp._yaw);
    const fwdZ = -Math.cos(lp._yaw);
    lp.body.velocity.x = fwdX * strength;
    lp.body.velocity.z = fwdZ * strength;
    lp._currentSpeed = strength;
    lp._internalVelX = lp.body.velocity.x;
    lp._internalVelZ = lp.body.velocity.z;
    lp._lastSetVelX = lp.body.velocity.x;
    lp._lastSetVelZ = lp.body.velocity.z;
  }

  // =====================================================================
  //  SWAP CAR (cycle through car types in-place)
  // =====================================================================

  async _swapCar(direction) {
    const lp = this.game.localPlayer;
    if (!lp) return;

    // Find current index in CAR_ORDER
    const currentIdx = CAR_ORDER.indexOf(lp.carType);
    const nextIdx = (currentIdx + direction + CAR_ORDER.length) % CAR_ORDER.length;
    const newCarType = CAR_ORDER[nextIdx];

    // Save current state
    const pos = lp.body.position;
    const savedX = pos.x, savedY = pos.y, savedZ = pos.z;
    const savedYaw = lp._yaw;
    const savedNickname = lp.nickname;
    const wasGodMode = lp.isInvincible && this._godMode;

    // Remove old car (engine audio, mesh, physics, ability)
    this.game.nameTags.remove(lp);
    this.game.healthBars.remove(lp);
    this.game._removeCarBody(lp);

    // Build new car
    const mesh = await buildCar(newCarType);
    this.scene.add(mesh);

    const carBody = new CarBody(newCarType, mesh, this.game.physicsWorld.world, {
      carMaterial: this.game.physicsWorld._carMaterial,
    });
    carBody.playerId = 'local';
    carBody.nickname = savedNickname;
    carBody.setPosition(savedX, savedY, savedZ, savedYaw);
    this.game.carBodies.push(carBody);

    // Engine audio
    sampleEngineAudio.addCar(carBody, true);

    // Ability system
    const ability = new AbilitySystem(newCarType, carBody, {
      scene: this.scene,
      world: this.game.physicsWorld.world,
      getOtherBodies: () => this.game.carBodies.filter((cb) => cb !== carBody),
    });
    this.game.abilities.set(carBody, ability);
    this.game.localAbility = ability;

    // Update game reference
    this.game.localPlayer = carBody;

    // Wire elimination callback
    carBody.onEliminated = (e) => this.game._onEliminated(e);

    // Re-add name tag and health bar
    this.game.nameTags.add(carBody, true);
    this.game.healthBars.add(carBody, true);

    // Restore god mode
    if (wasGodMode) carBody.isInvincible = true;

    // Update label
    if (this._swapCarLabel) {
      this._swapCarLabel.textContent = `Current: ${newCarType}`;
    }
  }

  // =====================================================================
  //  SANDBOX MODE (flat map, no enemies, no timer)
  // =====================================================================

  _enterSandbox() {
    if (this._sandboxActive) return;
    this._sandboxActive = true;

    const SIZE = 300;

    // Remove all bots
    this.game.botManager.removeAll();
    this.game.nameTags.clear();
    this.game.healthBars.clear();

    // Re-add local player tags
    if (this.game.localPlayer) {
      this.game.nameTags.add(this.game.localPlayer, true);
      this.game.healthBars.add(this.game.localPlayer, true);
    }

    // ── Hide ALL existing arena visuals ──
    this._hiddenSceneChildren = [];
    const keep = new Set();
    // Keep car meshes
    for (const cb of this.game.carBodies) keep.add(cb.mesh);
    // Keep hitbox/debug meshes
    for (const h of this._hitboxMeshes) keep.add(h.mesh);
    if (this._teleportMarker) keep.add(this._teleportMarker);
    // Keep FX objects so they remain visible in sandbox
    if (this.game.tireSmokeFX) keep.add(this.game.tireSmokeFX._points);
    if (this.game.stunFX) keep.add(this.game.stunFX._debrisMesh);
    const gfx = this.game.dynamicHazards?._arena?.geyserFX;
    if (gfx) {
      keep.add(gfx._dropletMesh);
      keep.add(gfx._splashRing);
      for (const slot of gfx._slots) {
        keep.add(slot.steamPoints);
        keep.add(slot.fountainPoints);
      }
    }
    // Keep physics overlay meshes
    for (const m of this._physicsOverlayMeshes) keep.add(m);
    // Keep AI viz lines
    for (const l of this._aiVizLines) keep.add(l);

    for (const child of [...this.scene.children]) {
      if (keep.has(child)) continue;
      if (child.isCamera) continue;
      if (child.visible) {
        child.visible = false;
        this._hiddenSceneChildren.push(child);
      }
    }

    // ── Stop arena animation updates ──
    this.game.sceneManager._sandboxMode = true;

    // ── Remove physics floor + lava ──
    const pw = this.game.physicsWorld;
    this._origFloorBody = pw.floorBody;
    this._origLavaBody = pw.lavaBody;
    if (pw.floorBody) pw.world.removeBody(pw.floorBody);
    if (pw.lavaBody) pw.world.removeBody(pw.lavaBody);

    // Remove obstacles from physics
    this._hiddenObstacles = [...pw.obstacleBodies];
    for (const ob of this._hiddenObstacles) pw.world.removeBody(ob);
    pw.obstacleBodies.length = 0;

    // Disable hazards
    this._hazardsDisabled = true;
    this._origLavaDPS = DAMAGE.LAVA_DPS;
    this._origGeyserDmg = DAMAGE.GEYSER_DAMAGE;
    DAMAGE.LAVA_DPS = 0;
    DAMAGE.GEYSER_DAMAGE = 0;
    this.game.dynamicHazards.reset();

    // ── Create sandbox floor (visual) ──
    const floorGeo = new THREE.PlaneGeometry(SIZE, SIZE);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a, roughness: 0.8, metalness: 0.1,
    });
    this._sandboxFloorMesh = new THREE.Mesh(floorGeo, floorMat);
    this._sandboxFloorMesh.position.y = 0;
    this._sandboxFloorMesh.receiveShadow = true;
    this.scene.add(this._sandboxFloorMesh);

    // Grid helper
    this._sandboxGridMesh = new THREE.GridHelper(SIZE, SIZE / 5, 0x444444, 0x333333);
    this._sandboxGridMesh.position.y = 0.01;
    this.scene.add(this._sandboxGridMesh);

    // ── Create sandbox floor (physics) ──
    const halfSize = SIZE / 2;
    const floorShape = new CANNON.Box(new CANNON.Vec3(halfSize, 0.05, halfSize));
    this._sandboxFloorBody = new CANNON.Body({
      mass: 0,
      shape: floorShape,
      material: pw._arenaMaterial,
      collisionFilterGroup: COLLISION_GROUPS.ARENA,
      collisionFilterMask: COLLISION_GROUPS.CAR | COLLISION_GROUPS.PICKUP | COLLISION_GROUPS.TRAIL,
    });
    this._sandboxFloorBody.position.set(0, -0.05, 0);
    pw.world.addBody(this._sandboxFloorBody);
    pw.floorBody = this._sandboxFloorBody;
    pw.lavaBody = null;

    // ── Sandbox lighting ──
    this._sandboxAmbient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this._sandboxAmbient);
    this._sandboxDirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this._sandboxDirLight.position.set(30, 50, 20);
    this.scene.add(this._sandboxDirLight);

    // ── Clean background ──
    this._origBackground = this.scene.background;
    this._origFog = this.scene.fog;
    this.scene.background = new THREE.Color(0x111111);
    this.scene.fog = null;

    // ── Update tilt raycasting to use sandbox floor ──
    this.game._tiltFloorMesh = this._sandboxFloorMesh;
    this.game._arenaGroup = new THREE.Group();
    this.game._arenaGroup.add(this._sandboxFloorMesh.clone());
    this.scene.add(this.game._arenaGroup);

    // ── Ensure PLAYING state, freeze timer ──
    if (!this.game.gameState.isPlaying) {
      this.game.gameState.state = GAME_STATES.PLAYING;
    }

    // Expand projectile OOB limit to sandbox size
    this._origOobLimit = this.game.powerUpManager._oobLimit;
    this.game.powerUpManager._oobLimit = SIZE;

    // Position player at center
    if (this.game.localPlayer) {
      this.game.localPlayer.setPosition(0, 0.6, 0);
      this.game.localPlayer._yaw = 0;
    }
  }

  _exitSandbox() {
    if (!this._sandboxActive) return;
    this._sandboxActive = false;

    // ── Remove sandbox visuals ──
    if (this._sandboxFloorMesh) {
      this.scene.remove(this._sandboxFloorMesh);
      this._sandboxFloorMesh.geometry.dispose();
      this._sandboxFloorMesh.material.dispose();
      this._sandboxFloorMesh = null;
    }
    if (this._sandboxGridMesh) {
      this.scene.remove(this._sandboxGridMesh);
      this._sandboxGridMesh.geometry.dispose();
      this._sandboxGridMesh = null;
    }
    if (this._sandboxAmbient) {
      this.scene.remove(this._sandboxAmbient);
      this._sandboxAmbient = null;
    }
    if (this._sandboxDirLight) {
      this.scene.remove(this._sandboxDirLight);
      this._sandboxDirLight = null;
    }
    // Remove cloned arena group for tilt
    if (this.game._arenaGroup && this.game._arenaGroup !== this.game.sceneManager.arena.arenaGroup) {
      this.scene.remove(this.game._arenaGroup);
    }

    // ── Remove sandbox physics floor ──
    const pw = this.game.physicsWorld;
    if (this._sandboxFloorBody) {
      pw.world.removeBody(this._sandboxFloorBody);
      this._sandboxFloorBody = null;
    }

    // ── Restore original physics ──
    if (this._origFloorBody) {
      pw.world.addBody(this._origFloorBody);
      pw.floorBody = this._origFloorBody;
      this._origFloorBody = null;
    }
    if (this._origLavaBody) {
      pw.world.addBody(this._origLavaBody);
      pw.lavaBody = this._origLavaBody;
      this._origLavaBody = null;
    }

    // Restore obstacles
    for (const ob of this._hiddenObstacles) {
      pw.world.addBody(ob);
      pw.obstacleBodies.push(ob);
    }
    this._hiddenObstacles = [];

    // Restore hazards
    if (this._hazardsDisabled) {
      DAMAGE.LAVA_DPS = this._origLavaDPS;
      DAMAGE.GEYSER_DAMAGE = this._origGeyserDmg;
      this._hazardsDisabled = false;
    }

    // ── Restore arena visuals ──
    for (const child of this._hiddenSceneChildren) {
      child.visible = true;
    }
    this._hiddenSceneChildren = [];

    // Restore background/fog
    if (this._origBackground) {
      this.scene.background = this._origBackground;
      this._origBackground = null;
    }
    if (this._origFog) {
      this.scene.fog = this._origFog;
      this._origFog = null;
    }

    // Restore projectile OOB limit
    if (this._origOobLimit !== undefined) {
      this.game.powerUpManager._oobLimit = this._origOobLimit;
    }

    // Restore arena references
    this.game._arenaGroup = this.game.sceneManager.arena.arenaGroup;
    this.game._tiltFloorMesh = this.game.sceneManager.arena.floorMesh || null;

    // Re-enable arena animation
    this.game.sceneManager._sandboxMode = false;

    // Refill bots
    this.game.botManager.fillSlots().then(() => {
      for (const bot of this.game.botManager.bots) {
        this.game.nameTags.add(bot.carBody, false);
        this.game.healthBars.add(bot.carBody, false);
        sampleEngineAudio.addCar(bot.carBody, false);
      }
    });
  }

  // =====================================================================
  //  ENTITY SPAWNER (click to place)
  // =====================================================================

  _setSpawnerMode(mode) {
    // Clean up previous
    if (this._spawnerHandler) {
      window.removeEventListener('click', this._spawnerHandler);
      this._spawnerHandler = null;
    }
    if (!mode) {
      this._spawnerMode = null;
      document.body.style.cursor = '';
      return;
    }
    this._setTeleportMode(false); // disable teleport if active
    this._spawnerMode = mode;
    document.body.style.cursor = 'cell';
    this._spawnerHandler = (e) => this._handleSpawnerClick(e);
    window.addEventListener('click', this._spawnerHandler);
  }

  _handleSpawnerClick(e) {
    if (this._panel.contains(e.target)) return;
    const target = this._raycastGround(e);
    if (!target) return;

    switch (this._spawnerMode) {
      case 'missile':
        this._spawnMissileAt(target.x, target.z, false);
        break;
      case 'homing':
        this._spawnMissileAt(target.x, target.z, true);
        break;
      case 'geyser':
        this._spawnGeyserAt(target.x, target.z);
        break;
      case 'bot':
        this._spawnBotAt(target.x, target.z);
        break;
      case 'powerup':
        this._spawnPowerupAt(target.x, target.z);
        break;
    }
  }

  _spawnMissileAt(x, z, isHoming) {
    const lp = this.game.localPlayer;
    if (!lp) return;
    const yaw = Math.atan2(-x, -z);
    const pm = this.game.powerUpManager;
    const origX = lp.body.position.x;
    const origZ = lp.body.position.z;
    const origYaw = lp._yaw;
    lp.body.position.x = x;
    lp.body.position.z = z;
    lp._yaw = yaw;
    pm._fireMissile(lp, isHoming);
    lp.body.position.x = origX;
    lp.body.position.z = origZ;
    lp._yaw = origYaw;
  }

  _spawnGeyserAt(x, z) {
    const hazards = this.game.dynamicHazards;
    for (const g of hazards._geysers) {
      if (g.state === 'idle' || g.state === 'cooldown') {
        g.x = x;
        g.z = z;
        g.state = 'warning';
        g.timer = ARENA.geysers.warningTime;
        hazards._arena.geyserStartWarning(g.slotIndex, x, z);
        if (hazards._audio) hazards._audio.startWarning(g.slotIndex, x, z);
        return;
      }
    }
  }

  // =====================================================================
  //  BOT SPAWNER (click to place)
  // =====================================================================

  async _spawnBotAt(x, z) {
    const carType = this._selectedBotCarType;
    const bm = this.game.botManager;
    const availableNames = BOTS.names.filter(
      n => !bm.bots.some(b => b.carBody.nickname === n)
    );
    const name = availableNames.length > 0
      ? availableNames[Math.floor(Math.random() * availableNames.length)]
      : `Bot${bm.bots.length + 1}`;

    const slotIndex = this.game.carBodies.length;
    await bm._spawnBot(name, carType, slotIndex);

    // Reposition to click location
    const bot = bm.bots[bm.bots.length - 1];
    const yaw = Math.atan2(-x, -z); // face center
    bot.carBody.setPosition(x, 0.6, z, yaw);
    bot.carBody.body.quaternion.setFromEuler(0, yaw, 0);

    this.game.nameTags.add(bot.carBody, false);
    this.game.healthBars.add(bot.carBody, false);
  }

  // =====================================================================
  //  POWER-UP BOX SPAWNER (click to place)
  // =====================================================================

  _spawnPowerupAt(x, z) {
    const pm = this.game.powerUpManager;
    const wantedType = this._selectedPowerupType === 'RANDOM'
      ? POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)]
      : this._selectedPowerupType;

    // Build a real pedestal entry with all required visual objects
    // so the PowerUpManager update/pickup code works without errors.
    const ringGeo = new THREE.TorusGeometry(1.0, 0.08, 8, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xff6600, emissiveIntensity: 2,
      transparent: true, opacity: 0.7,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, 0.8, z);
    ring.rotation.x = Math.PI / 2;
    this.scene.add(ring);

    const light = new THREE.PointLight(0xff6600, 0.4, 8);
    light.position.set(x, 1.6, z);
    this.scene.add(light);

    const pedestal = {
      index: pm._pedestals.length,
      x, z, y: 0, angle: 0,
      pedestalMesh: null, ringMesh: ring, ringMat, glowLight: light,
      active: false, type: null, pickupMesh: null, respawnAt: 0,
      _isDebugSpawned: true,
    };
    pm._pedestals.push(pedestal);

    // Use the real _spawnPickup to create the floating box with correct model
    pm._spawnPickup(pedestal);

    // Override the randomly-chosen type with what the user selected
    pedestal.type = wantedType;
  }

  // =====================================================================
  //  MULTI-VEHICLE SYNC INPUT
  // =====================================================================

  async _startSyncTest() {
    const selectedTypes = [];
    for (const carType of CAR_ORDER) {
      if (this._syncCarSelect[carType].checked) {
        selectedTypes.push(carType);
      }
    }
    if (selectedTypes.length === 0) return;

    this._removeSyncCars();

    if (!this._sandboxActive) this._enterSandbox();

    const spacing = 4;
    const totalWidth = (selectedTypes.length - 1) * spacing;
    const startX = -totalWidth / 2;
    const spawnZ = 20;
    const yaw = Math.PI;

    for (let i = 0; i < selectedTypes.length; i++) {
      const carType = selectedTypes[i];
      const x = startX + i * spacing;

      const carBody = await this.game._spawnCar(carType, `SYNC_${carType}`, `sync_${i}`);
      carBody.setPosition(x, 0.6, spawnZ);
      carBody._yaw = yaw;
      carBody.body.quaternion.setFromEuler(0, yaw, 0);

      carBody.isInvincible = true;

      this.game.nameTags.add(carBody, false);
      this.game.healthBars.add(carBody, false);

      this._syncCars.push(carBody);
    }

    if (this.game.localPlayer) {
      const lpX = startX - spacing;
      this.game.localPlayer.setPosition(lpX, 0.6, spawnZ);
      this.game.localPlayer._yaw = yaw;
      this.game.localPlayer.body.quaternion.setFromEuler(0, yaw, 0);
    }

    this._syncActive = true;
  }

  _removeSyncCars() {
    for (const cb of this._syncCars) {
      this.game._removeCarBody(cb);
      this.game.nameTags.remove(cb);
      this.game.healthBars.remove(cb);
    }
    this._syncCars = [];
    this._syncActive = false;
  }

  // =====================================================================
  //  SYNC CAMERA (bird's-eye view framing all sync cars + player)
  // =====================================================================

  updateSyncCamera(dt) {
    const cam = this.camera;
    const allCars = [...this._syncCars];
    if (this.game.localPlayer) allCars.push(this.game.localPlayer);
    if (allCars.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const cb of allCars) {
      const p = cb.body.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    const spanX = maxX - minX + 20;
    const spanZ = maxZ - minZ + 20;
    const span = Math.max(spanX, spanZ, 30);

    const fovRad = (cam.fov * Math.PI) / 180;
    const aspect = cam.aspect;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const neededH = span / (2 * Math.tan(Math.min(fovRad, hFov) / 2));
    const targetH = Math.max(neededH * 0.6, 15);

    const targetX = cx;
    const targetZ = cz + span * 0.4;
    const targetY = targetH;

    const lerpFactor = Math.min(1, 3 * dt);
    cam.position.x += (targetX - cam.position.x) * lerpFactor;
    cam.position.y += (targetY - cam.position.y) * lerpFactor;
    cam.position.z += (targetZ - cam.position.z) * lerpFactor;

    cam.lookAt(cx, 0, cz);
  }

  // =====================================================================
  //  FREE CAMERA (orbit controls)
  // =====================================================================

  _setFreeCamera(on) {
    this._freeCamActive = on;
    if (on) {
      // Save current camera state
      this._freeCamSavedPos.copy(this.camera.position);
      this._freeCamSavedQuat.copy(this.camera.quaternion);
      // Initialize orbit from current camera
      const lp = this.game.localPlayer;
      if (lp) {
        this._freeCamTarget.copy(lp.body.position);
      } else {
        this._freeCamTarget.set(0, 0, 0);
      }
      const offset = this.camera.position.clone().sub(this._freeCamTarget);
      this._freeCamDist = offset.length();
      this._freeCamTheta = Math.atan2(offset.x, offset.z);
      this._freeCamPhi = Math.acos(Math.min(1, offset.y / this._freeCamDist));

      // Mouse handlers
      this._freeCamMouseDown = (e) => {
        if (e.button === 2 || e.button === 1) { // right or middle
          this._freeCamDragging = true;
          this._freeCamLastMouse = { x: e.clientX, y: e.clientY };
          e.preventDefault();
        }
      };
      this._freeCamMouseMove = (e) => {
        if (!this._freeCamDragging) return;
        const dx = e.clientX - this._freeCamLastMouse.x;
        const dy = e.clientY - this._freeCamLastMouse.y;
        this._freeCamTheta -= dx * 0.005;
        this._freeCamPhi = Math.max(0.1, Math.min(Math.PI - 0.1, this._freeCamPhi + dy * 0.005));
        this._freeCamLastMouse = { x: e.clientX, y: e.clientY };
      };
      this._freeCamMouseUp = () => { this._freeCamDragging = false; };
      this._freeCamWheel = (e) => {
        this._freeCamDist = Math.max(5, Math.min(200, this._freeCamDist + e.deltaY * 0.05));
        e.preventDefault();
      };
      this._freeCamContext = (e) => e.preventDefault();

      window.addEventListener('mousedown', this._freeCamMouseDown);
      window.addEventListener('mousemove', this._freeCamMouseMove);
      window.addEventListener('mouseup', this._freeCamMouseUp);
      window.addEventListener('wheel', this._freeCamWheel, { passive: false });
      window.addEventListener('contextmenu', this._freeCamContext);
    } else {
      // Restore and clean up
      window.removeEventListener('mousedown', this._freeCamMouseDown);
      window.removeEventListener('mousemove', this._freeCamMouseMove);
      window.removeEventListener('mouseup', this._freeCamMouseUp);
      window.removeEventListener('wheel', this._freeCamWheel);
      window.removeEventListener('contextmenu', this._freeCamContext);
      this._freeCamDragging = false;
    }
  }

  _updateFreeCamera() {
    const cam = this.camera;
    // Pan target with WASD-like movement using arrow keys? No — just orbit around target
    // Target follows local player loosely
    const lp = this.game.localPlayer;
    if (lp && !this._freeCamDragging) {
      this._freeCamTarget.lerp(lp.body.position, 0.02);
    }

    const x = this._freeCamTarget.x + this._freeCamDist * Math.sin(this._freeCamPhi) * Math.sin(this._freeCamTheta);
    const y = this._freeCamTarget.y + this._freeCamDist * Math.cos(this._freeCamPhi);
    const z = this._freeCamTarget.z + this._freeCamDist * Math.sin(this._freeCamPhi) * Math.cos(this._freeCamTheta);

    cam.position.set(x, y, z);
    cam.lookAt(this._freeCamTarget);
  }

  // =====================================================================
  //  PHYSICS DEBUG OVERLAY
  // =====================================================================

  _setPhysicsOverlay(on) {
    this._physicsOverlayActive = on;
    if (!on) {
      for (const m of this._physicsOverlayMeshes) {
        this.scene.remove(m);
        m.geometry.dispose();
      }
      this._physicsOverlayMeshes = [];
    }
  }

  _updatePhysicsOverlay() {
    const pw = this.game.physicsWorld;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ffff, wireframe: true, transparent: true, opacity: 0.3,
    });

    // Only rebuild if body count changed
    const totalBodies = 2 + pw.obstacleBodies.length; // floor + lava + obstacles
    if (this._physicsOverlayMeshes.length === totalBodies) {
      // Just update positions
      let idx = 0;
      if (pw.floorBody && this._physicsOverlayMeshes[idx]) {
        this._physicsOverlayMeshes[idx].position.copy(pw.floorBody.position);
        idx++;
      }
      if (pw.lavaBody && this._physicsOverlayMeshes[idx]) {
        this._physicsOverlayMeshes[idx].position.copy(pw.lavaBody.position);
        idx++;
      }
      for (const ob of pw.obstacleBodies) {
        if (this._physicsOverlayMeshes[idx]) {
          this._physicsOverlayMeshes[idx].position.copy(ob.position);
        }
        idx++;
      }
      mat.dispose();
      return;
    }

    // Rebuild
    for (const m of this._physicsOverlayMeshes) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this._physicsOverlayMeshes = [];

    // Floor body
    if (pw.floorBody) {
      const shape = pw.floorBody.shapes[0];
      let geo;
      if (shape instanceof CANNON.Box) {
        const he = shape.halfExtents;
        geo = new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
      } else {
        geo = new THREE.PlaneGeometry(120, 120);
        geo.rotateX(-Math.PI / 2);
      }
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.position.copy(pw.floorBody.position);
      this.scene.add(mesh);
      this._physicsOverlayMeshes.push(mesh);
    }

    // Lava body
    if (pw.lavaBody) {
      const shape = pw.lavaBody.shapes[0];
      let geo;
      if (shape instanceof CANNON.Cylinder) {
        geo = new THREE.CylinderGeometry(shape.radiusTop, shape.radiusBottom, shape.height, 16);
      } else if (shape instanceof CANNON.Box) {
        const he = shape.halfExtents;
        geo = new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
      } else {
        geo = new THREE.CylinderGeometry(10, 10, 1, 16);
      }
      const lavaMat = mat.clone();
      lavaMat.color.set(0xff4400);
      const mesh = new THREE.Mesh(geo, lavaMat);
      mesh.position.copy(pw.lavaBody.position);
      this.scene.add(mesh);
      this._physicsOverlayMeshes.push(mesh);
    }

    // Obstacle bodies
    for (const ob of pw.obstacleBodies) {
      const r = ob._obstacleRadius || 2;
      const geo = new THREE.CylinderGeometry(r, r, 6, 8);
      const obMat = mat.clone();
      obMat.color.set(0xffaa00);
      const mesh = new THREE.Mesh(geo, obMat);
      mesh.position.copy(ob.position);
      this.scene.add(mesh);
      this._physicsOverlayMeshes.push(mesh);
    }

    mat.dispose();
  }

  // =====================================================================
  //  BOT AI VISUALIZER
  // =====================================================================

  _setAIViz(on) {
    this._aiVizActive = on;
    if (!on) {
      for (const l of this._aiVizLines) {
        this.scene.remove(l);
        l.geometry.dispose();
        l.material.dispose();
      }
      this._aiVizLines = [];
      // Remove labels
      for (const lbl of this._aiVizLabels) {
        if (lbl.parentNode) lbl.parentNode.removeChild(lbl);
      }
      this._aiVizLabels = [];
    }
  }

  _updateAIViz() {
    const bots = this.game.botManager.bots;
    const cam = this.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Ensure we have enough lines and labels
    while (this._aiVizLines.length < bots.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xff0000 });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this._aiVizLines.push(line);

      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:fixed;color:#ff0;font:bold 10px monospace;pointer-events:none;z-index:999;text-shadow:0 0 3px #000;';
      document.body.appendChild(lbl);
      this._aiVizLabels.push(lbl);
    }

    // Hide excess
    for (let i = bots.length; i < this._aiVizLines.length; i++) {
      this._aiVizLines[i].visible = false;
      this._aiVizLabels[i].style.display = 'none';
    }

    const _proj = new THREE.Vector3();

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const cb = bot.carBody;
      const brain = bot.brain;
      const line = this._aiVizLines[i];
      const lbl = this._aiVizLabels[i];

      if (cb.isEliminated) {
        line.visible = false;
        lbl.style.display = 'none';
        continue;
      }

      line.visible = true;
      lbl.style.display = 'block';

      // State colors
      const stateColors = {
        ROAM: 0x888888,
        HUNT: 0xffaa00,
        CHARGE: 0xff0000,
        EVADE: 0x00aaff,
        FLEE: 0x00ff00,
        POWERUP_SEEK: 0xff00ff,
      };
      line.material.color.set(stateColors[brain.state] || 0xffffff);

      // Line from bot to target
      const posArr = line.geometry.attributes.position.array;
      posArr[0] = cb.body.position.x;
      posArr[1] = cb.body.position.y + 1.5;
      posArr[2] = cb.body.position.z;

      if (brain._target && !brain._target.isEliminated) {
        posArr[3] = brain._target.body.position.x;
        posArr[4] = brain._target.body.position.y + 1.5;
        posArr[5] = brain._target.body.position.z;
      } else {
        // Point forward if no target
        const fwd = 5;
        posArr[3] = cb.body.position.x - Math.sin(cb._yaw) * fwd;
        posArr[4] = cb.body.position.y + 1.5;
        posArr[5] = cb.body.position.z - Math.cos(cb._yaw) * fwd;
      }
      line.geometry.attributes.position.needsUpdate = true;

      // Project bot position to screen for label
      _proj.set(cb.body.position.x, cb.body.position.y + 2.5, cb.body.position.z);
      _proj.project(cam);
      const sx = ((_proj.x + 1) / 2) * w;
      const sy = ((-_proj.y + 1) / 2) * h;

      if (_proj.z > 1) {
        lbl.style.display = 'none';
      } else {
        lbl.style.left = `${sx}px`;
        lbl.style.top = `${sy}px`;
        const targetName = brain._target ? (brain._target.nickname || brain._target.carType) : '-';
        lbl.textContent = `${cb.nickname} [${brain.state}] → ${targetName}`;
        lbl.style.color = '#' + (stateColors[brain.state] || 0xffffff).toString(16).padStart(6, '0');
      }
    }
  }

  // =====================================================================
  //  PERFORMANCE STATS
  // =====================================================================

  _setPerfStats(on) {
    this._perfStatsActive = on;
    if (on) {
      if (!this._perfDisplay) {
        this._perfDisplay = document.createElement('div');
        this._perfDisplay.style.cssText = `
          position:fixed;top:50px;right:16px;width:220px;
          background:rgba(0,0,0,0.85);color:#0f0;
          font:11px 'Courier New',monospace;padding:10px;border-radius:6px;
          border:1px solid #0f0;z-index:1000;white-space:pre;line-height:1.6;
          user-select:none;
        `;
        document.body.appendChild(this._perfDisplay);
        this._makeDraggable(this._perfDisplay);
      }
      this._perfDisplay.style.display = 'block';
      this._perfFrameTimes = [];
      this._perfLastTime = performance.now();
    } else {
      if (this._perfDisplay) this._perfDisplay.style.display = 'none';
    }
  }

  _updatePerfStats() {
    if (!this._perfDisplay) return;
    const now = performance.now();
    const dt = now - this._perfLastTime;
    this._perfLastTime = now;
    this._perfFrameTimes.push(dt);
    if (this._perfFrameTimes.length > 60) this._perfFrameTimes.shift();

    const avgDt = this._perfFrameTimes.reduce((a, b) => a + b, 0) / this._perfFrameTimes.length;
    const fps = (1000 / avgDt).toFixed(0);
    const minFps = (1000 / Math.max(...this._perfFrameTimes)).toFixed(0);

    const renderer = this.game.sceneManager.renderer;
    const info = renderer.info;
    const r = info.render;
    const m = info.memory;

    const bodies = this.game.physicsWorld.world.bodies.length;
    const cars = this.game.carBodies.length;
    const bots = this.game.botManager.bots.length;

    this._perfDisplay.textContent =
      `── PERFORMANCE ──\n` +
      `FPS:       ${fps} (min ${minFps})\n` +
      `Frame:     ${avgDt.toFixed(1)}ms\n` +
      `Draw calls: ${r.calls}\n` +
      `Triangles:  ${r.triangles}\n` +
      `Points:     ${r.points}\n` +
      `Geometries: ${m.geometries}\n` +
      `Textures:   ${m.textures}\n` +
      `── WORLD ──\n` +
      `Physics:    ${bodies} bodies\n` +
      `Cars:       ${cars} (${bots} bots)\n` +
      `TimeScale:  ${this._timeScale.toFixed(2)}x`;
  }

  // =====================================================================
  //  COLLISION LOGGER
  // =====================================================================

  _setCollisionLog(on) {
    this._collisionLogActive = on;
    if (on) {
      if (!this._collisionLogDisplay) {
        this._collisionLogDisplay = document.createElement('div');
        this._collisionLogDisplay.style.cssText = `
          position:fixed;bottom:16px;right:16px;width:320px;
          background:rgba(0,0,0,0.85);color:#0f0;
          font:10px 'Courier New',monospace;padding:10px;border-radius:6px;
          border:1px solid #0f0;z-index:1000;white-space:pre;line-height:1.5;
          max-height:200px;overflow-y:auto;user-select:none;
        `;
        document.body.appendChild(this._collisionLogDisplay);
        this._makeDraggable(this._collisionLogDisplay);
      }
      this._collisionLogDisplay.style.display = 'block';
      this._collisionLog = [];
      // Listen for damage events
      this.game.on('damage', this._onDamageForLog);
    } else {
      if (this._collisionLogDisplay) this._collisionLogDisplay.style.display = 'none';
      this.game.off('damage', this._onDamageForLog);
    }
  }

  _logCollision(e) {
    const targetName = e.target?.nickname || e.target?.carType || '?';
    const sourceName = e.source?.nickname || e.source?.carType || 'env';
    const entry = `[${new Date().toLocaleTimeString()}] ${sourceName} → ${targetName}: ${e.amount.toFixed(0)} dmg`;
    this._collisionLog.push(entry);
    if (this._collisionLog.length > this._collisionLogMax) {
      this._collisionLog.shift();
    }
  }

  _updateCollisionLogDisplay() {
    if (!this._collisionLogDisplay) return;
    if (this._collisionLog.length === 0) {
      this._collisionLogDisplay.textContent = '── COLLISION LOG ──\n(no hits yet)';
    } else {
      this._collisionLogDisplay.textContent = '── COLLISION LOG ──\n' + this._collisionLog.join('\n');
    }
  }

  // =====================================================================
  //  DEBUG MAP
  // =====================================================================

  _setDebugMap(on) {
    this._debugMap = on;
    if (on) {
      const arena = this.game.sceneManager.arena;
      if (arena.obstacleGroups) {
        for (const og of arena.obstacleGroups) og.group.visible = false;
      }
      this._hiddenObstacles = [...this.game.physicsWorld.obstacleBodies];
      for (const ob of this._hiddenObstacles) {
        this.game.physicsWorld.world.removeBody(ob);
      }
      this.game.physicsWorld.obstacleBodies.length = 0;

      this._hazardsDisabled = true;
      this._origLavaDPS = DAMAGE.LAVA_DPS;
      this._origGeyserDmg = DAMAGE.GEYSER_DAMAGE;
      DAMAGE.LAVA_DPS = 0;
      DAMAGE.GEYSER_DAMAGE = 0;
      this.game.dynamicHazards.reset();

      if (arena._lavaMaterial && arena._lavaMaterial.uniforms) {
        arena._lavaMaterial.uniforms.uEmissiveBoost.value = -10;
      }
    } else {
      const arena = this.game.sceneManager.arena;
      if (arena.obstacleGroups) {
        for (const og of arena.obstacleGroups) og.group.visible = true;
      }
      for (const ob of this._hiddenObstacles) {
        this.game.physicsWorld.world.addBody(ob);
        this.game.physicsWorld.obstacleBodies.push(ob);
      }
      this._hiddenObstacles = [];

      if (this._hazardsDisabled) {
        DAMAGE.LAVA_DPS = this._origLavaDPS;
        DAMAGE.GEYSER_DAMAGE = this._origGeyserDmg;
        this._hazardsDisabled = false;
      }
      if (arena._lavaMaterial && arena._lavaMaterial.uniforms) {
        arena._lavaMaterial.uniforms.uEmissiveBoost.value = 0;
      }
    }
  }
}
