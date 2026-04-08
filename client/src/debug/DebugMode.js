import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CAR_FEEL, DAMAGE, OBSTACLE_STUN, ARENA, PHYSICS, CAR_ORDER, GAME_STATES, COLLISION_GROUPS } from '../core/Config.js';
import { AbilitySystem } from '../physics/AbilitySystem.js';

/**
 * DebugMode — all-in-one debug overlay for Rocket Bumpers.
 *
 * Features:
 *   1. Hitbox wireframe visualization
 *   2. Real-time parameter tweaking panel
 *   3. Click-to-teleport
 *   4. God mode
 *   5. Spawn controls
 *   6. Debug map toggle (flat, no obstacles/hazards)
 *   7. Sandbox mode (flat map, no enemies, no timer)
 *   8. Entity spawner (click to place missiles, geysers, obstacles)
 *   9. Multi-vehicle sync input (compare car handling side-by-side)
 *
 * Toggle with ' (apostrophe) key.
 */
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
    this._spawnerMode = null;  // null | 'missile' | 'homing' | 'geyser' | 'obstacle'
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
    this._sandboxFloorMesh = null;   // THREE.Mesh for sandbox floor
    this._sandboxFloorBody = null;   // CANNON.Body for sandbox floor
    this._sandboxGridMesh = null;    // grid lines
    this._hiddenSceneChildren = [];  // scene children hidden during sandbox
    this._origFloorBody = null;      // original physics floor
    this._origLavaBody = null;       // original physics lava
    this._origBackground = null;
    this._origFog = null;

    // ── Teleport ──
    this._raycaster = new THREE.Raycaster();
    this._mouseNDC = new THREE.Vector2();
    this._teleportMarker = null;

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

  // ── Per-frame update (call from game loop) ──

  update() {
    if (!this.enabled && !this._syncActive && !this._sandboxActive) return;

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

    // ── Sandbox Mode ──
    this._addSection(panel, 'SANDBOX MODE');
    this._addButton(panel, 'Enter Sandbox (flat, no enemies, no timer)', () => this._enterSandbox());
    this._addButton(panel, 'Exit Sandbox', () => this._exitSandbox());

    // ── Entity Spawner ──
    this._addSection(panel, 'ENTITY SPAWNER (click to place)');
    this._addButton(panel, 'Spawn: Missile (click)', () => this._setSpawnerMode('missile'));
    this._addButton(panel, 'Spawn: Homing Missile (click)', () => this._setSpawnerMode('homing'));
    this._addButton(panel, 'Spawn: Geyser (click)', () => this._setSpawnerMode('geyser'));
    this._addButton(panel, 'Stop Spawner', () => this._setSpawnerMode(null));

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
  }

  // ── UI helpers ──

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
      `drift: ${lp.driftMode ? 'ON' : 'off'}  shield: ${lp.hasShield ? 'ON' : 'off'}`;
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
    // Snapshot current children (skip camera and lights we want to keep)
    const keep = new Set();
    // Keep car meshes
    for (const cb of this.game.carBodies) keep.add(cb.mesh);
    // Keep hitbox/debug meshes
    for (const h of this._hitboxMeshes) keep.add(h.mesh);
    if (this._teleportMarker) keep.add(this._teleportMarker);

    for (const child of [...this.scene.children]) {
      if (keep.has(child)) continue;
      if (child.isCamera) continue;
      // Hide arena elements
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
    // Add sandbox floor to arena group for tilt raycasting
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
    }
  }

  _spawnMissileAt(x, z, isHoming) {
    const lp = this.game.localPlayer;
    if (!lp) return;
    // Fire missile from clicked position toward arena center
    const yaw = Math.atan2(-x, -z);
    const pm = this.game.powerUpManager;
    // Temporarily override car position to spawn missile from click location
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
    // Find an idle geyser slot and force it to erupt at this position
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
  //  MULTI-VEHICLE SYNC INPUT
  // =====================================================================

  async _startSyncTest() {
    // Get selected car types
    const selectedTypes = [];
    for (const carType of CAR_ORDER) {
      if (this._syncCarSelect[carType].checked) {
        selectedTypes.push(carType);
      }
    }
    if (selectedTypes.length === 0) return;

    // Remove existing sync cars
    this._removeSyncCars();

    // Enter sandbox if not already
    if (!this._sandboxActive) this._enterSandbox();

    // Spawn cars in a line, spaced 4 units apart, centered at z=0
    const spacing = 4;
    const totalWidth = (selectedTypes.length - 1) * spacing;
    const startX = -totalWidth / 2;
    const spawnZ = 20; // in front of center
    const yaw = Math.PI; // face toward negative Z (toward center)

    for (let i = 0; i < selectedTypes.length; i++) {
      const carType = selectedTypes[i];
      const x = startX + i * spacing;

      const carBody = await this.game._spawnCar(carType, `SYNC_${carType}`, `sync_${i}`);
      carBody.setPosition(x, 0.6, spawnZ);
      carBody._yaw = yaw;
      carBody.body.quaternion.setFromEuler(0, yaw, 0);

      // God mode for sync cars
      carBody.isInvincible = true;

      // Add name tag and health bar
      this.game.nameTags.add(carBody, false);
      this.game.healthBars.add(carBody, false);

      this._syncCars.push(carBody);
    }

    // Also position local player on the line
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

    // Compute bounding box of all cars
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const cb of allCars) {
      const p = cb.body.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    // Center of group
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Span — add padding
    const spanX = maxX - minX + 20;
    const spanZ = maxZ - minZ + 20;
    const span = Math.max(spanX, spanZ, 30); // minimum 30 units visible

    // Height: proportional to span so everything fits in view
    // Using FOV to calculate needed distance
    const fovRad = (cam.fov * Math.PI) / 180;
    const aspect = cam.aspect;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const neededH = span / (2 * Math.tan(Math.min(fovRad, hFov) / 2));
    const targetH = Math.max(neededH * 0.6, 15); // 0.6 factor for angled view

    // Camera position: behind and above center, looking slightly forward
    const targetX = cx;
    const targetZ = cz + span * 0.4; // offset back
    const targetY = targetH;

    // Smooth lerp
    const lerpFactor = Math.min(1, 3 * dt);
    cam.position.x += (targetX - cam.position.x) * lerpFactor;
    cam.position.y += (targetY - cam.position.y) * lerpFactor;
    cam.position.z += (targetZ - cam.position.z) * lerpFactor;

    // Look at center of group
    cam.lookAt(cx, 0, cz);
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
