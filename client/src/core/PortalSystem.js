import * as THREE from 'three';
import { PORTAL, ARENA, CARS } from './Config.js';

/**
 * PortalSystem — Vibe Jam 2026 webring portal integration.
 *
 * Two portal types:
 * 1. Exit Portal (always present, above lava center) — sends player to next game
 * 2. Return Portal (only for incoming portal players) — sends player back to previous game
 *
 * Launch ramps around the lava pool propel cars upward toward the exit portal.
 * Portal trigger only fires for the local human player — bots pass through harmlessly.
 *
 * Multiplayer-ready: portal checks are based on playerId, ramp cooldowns are per-car.
 */
export class PortalSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} deps
   * @param {Function} deps.getLocalPlayer — returns local player CarBody
   * @param {Function} deps.getPlayerNickname
   * @param {Function} deps.getPlayerCarType
   * @param {Function} deps.getScoreManager — returns ScoreManager instance
   */
  constructor(scene, deps) {
    this.scene = scene;
    this._getLocalPlayer = deps.getLocalPlayer;
    this._getPlayerNickname = deps.getPlayerNickname;
    this._getPlayerCarType = deps.getPlayerCarType;
    this._getScoreManager = deps.getScoreManager;

    // ── Exit portal mesh + group ──
    this._exitGroup = null;
    this._exitLabel = null;

    // ── Return portal ──
    this._returnGroup = null;
    this._returnPosition = null;
    this._returnURL = null;
    this._returnParams = null;

    // ── Ramp state ──
    this._rampBodies = []; // Cannon bodies for ramps
    this._rampCooldowns = new Map(); // CarBody → timestamp

    // ── Warp transition state ──
    this._warping = false;
    this._warpTime = 0;
    this._warpURL = null;
    this._warpOverlay = null;
    this._warpCanvas = null;
    this._warpCtx = null;

    // ── Multiplayer: set by Game.connectMultiplayer ──
    this._networkManager = null;

    // ── Incoming portal params ──
    this._incomingParams = this._parseURLParams();

    // ── Animation ──
    this._time = 0;

    this._buildExitPortal();
    this._buildRamps();

    // Build return portal if incoming from another game
    if (this._incomingParams.portal && this._incomingParams.ref) {
      this._buildReturnPortal();
    }
  }

  // ── URL Parameter handling ────────────────────────────────────────────

  _parseURLParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      portal: params.get('portal') === 'true',
      ref: params.get('ref') || null,
      username: params.get('username') || null,
      color: params.get('color') || null,
      speed: params.get('speed') || null,
      hp: params.get('hp') || null,
      avatar_url: params.get('avatar_url') || null,
      team: params.get('team') || null,
      speed_x: params.get('speed_x') || null,
      speed_y: params.get('speed_y') || null,
      speed_z: params.get('speed_z') || null,
      rotation_x: params.get('rotation_x') || null,
      rotation_y: params.get('rotation_y') || null,
      rotation_z: params.get('rotation_z') || null,
    };
  }

  get incomingParams() { return this._incomingParams; }
  get isPortalEntry() { return this._incomingParams.portal; }

  _buildExitURL() {
    const player = this._getLocalPlayer();
    const nickname = this._getPlayerNickname();
    const carType = this._getPlayerCarType();
    const scoreManager = this._getScoreManager();

    const params = new URLSearchParams();
    if (nickname) params.set('username', nickname);

    // Get car color as hex
    if (carType) {
      const carCfg = CARS[carType];
      if (carCfg) {
        params.set('color', '#' + new THREE.Color(carCfg.color).getHexString());
      }
    }

    // Speed
    if (player) {
      const vel = player.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
      params.set('speed', speed.toFixed(1));
      params.set('speed_x', vel.x.toFixed(1));
      params.set('speed_y', vel.y.toFixed(1));
      params.set('speed_z', vel.z.toFixed(1));
    }

    // HP
    if (player) {
      params.set('hp', Math.ceil(player.hp).toString());
    }

    // Ref (this game's URL)
    params.set('ref', window.location.origin + window.location.pathname);

    // Score — use server-assigned playerId in multiplayer, fallback to 'local'
    if (scoreManager) {
      const playerId = this._networkManager?.localPlayerId || 'local';
      const stats = scoreManager.getPlayerStats(playerId);
      if (stats) {
        params.set('score', stats.score.toString());
      }
    }

    return `${PORTAL.exitURL}?${params.toString()}`;
  }

  _buildReturnURL() {
    if (!this._returnURL) return null;

    // Re-send all original incoming params
    const params = new URLSearchParams();
    const p = this._incomingParams;
    if (p.username) params.set('username', p.username);
    if (p.color) params.set('color', p.color);
    if (p.speed) params.set('speed', p.speed);
    if (p.hp) params.set('hp', p.hp);
    if (p.avatar_url) params.set('avatar_url', p.avatar_url);
    if (p.team) params.set('team', p.team);
    if (p.speed_x) params.set('speed_x', p.speed_x);
    if (p.speed_y) params.set('speed_y', p.speed_y);
    if (p.speed_z) params.set('speed_z', p.speed_z);
    if (p.rotation_x) params.set('rotation_x', p.rotation_x);
    if (p.rotation_y) params.set('rotation_y', p.rotation_y);
    if (p.rotation_z) params.set('rotation_z', p.rotation_z);

    const base = this._returnURL;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${params.toString()}`;
  }

  // ── Portal meshes ────────────────────────────────────────────────────

  _buildExitPortal() {
    const cfg = PORTAL.exit;
    const group = new THREE.Group();
    group.position.set(0, cfg.height, 0);

    // Torus
    const torusGeo = new THREE.TorusGeometry(cfg.meshRadius, cfg.tubeRadius, 16, 48);
    const torusMat = new THREE.MeshStandardMaterial({
      color: cfg.color,
      emissive: cfg.emissive,
      emissiveIntensity: cfg.emissiveIntensity,
      metalness: 0.8,
      roughness: 0.2,
      transparent: true,
      opacity: 0.9,
    });
    const torus = new THREE.Mesh(torusGeo, torusMat);
    torus.rotation.x = Math.PI / 2; // face upward
    group.add(torus);

    // Inner swirl (animated disc)
    const discGeo = new THREE.CircleGeometry(cfg.meshRadius - 0.2, 32);
    const discMat = new THREE.MeshBasicMaterial({
      color: cfg.emissive,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = Math.PI / 2;
    group.add(disc);
    this._exitDisc = disc;

    // Point light
    const light = new THREE.PointLight(cfg.color, 3, 30);
    light.position.set(0, 1, 0);
    group.add(light);

    // Label sprite
    const label = this._createTextSprite(cfg.labelText, cfg.color);
    label.position.set(0, cfg.meshRadius + 1.5, 0);
    label.scale.set(8, 2, 1);
    group.add(label);

    this.scene.add(group);
    this._exitGroup = group;
    this._exitTorus = torus;
  }

  _buildReturnPortal() {
    const cfg = PORTAL.return;
    const p = this._incomingParams;
    this._returnURL = p.ref;

    // Position at arena edge (slot 0 area, slightly offset)
    const angle = 0; // same as spawn slot 0
    const dist = ARENA.diameter / 2 * 0.65;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    this._returnPosition = new THREE.Vector3(x, 0, z);

    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // Torus arch
    const torusGeo = new THREE.TorusGeometry(cfg.meshRadius, cfg.tubeRadius, 16, 48);
    const torusMat = new THREE.MeshStandardMaterial({
      color: cfg.color,
      emissive: cfg.emissive,
      emissiveIntensity: cfg.emissiveIntensity,
      metalness: 0.8,
      roughness: 0.2,
      transparent: true,
      opacity: 0.9,
    });
    const torus = new THREE.Mesh(torusGeo, torusMat);
    // Stand upright as an arch
    group.add(torus);

    // Inner disc
    const discGeo = new THREE.CircleGeometry(cfg.meshRadius - 0.2, 32);
    const discMat = new THREE.MeshBasicMaterial({
      color: cfg.emissive,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    group.add(disc);
    this._returnDisc = disc;

    // Light
    const light = new THREE.PointLight(cfg.color, 2, 20);
    light.position.set(0, 2, 0);
    group.add(light);

    // Label
    let domain = 'previous game';
    try { domain = new URL(this._returnURL).hostname; } catch (e) { /* ignore */ }
    const label = this._createTextSprite(`Return to ${domain}`, cfg.color);
    label.position.set(0, cfg.meshRadius + 1.5, 0);
    label.scale.set(8, 2, 1);
    group.add(label);

    this.scene.add(group);
    this._returnGroup = group;
    this._returnTorus = torus;
  }

  _buildRamps() {
    const cfg = PORTAL.ramps;
    this._rampMeshes = [];
    this._rampPositions = [];
    this._rampMaterials = [];

    // Speed-pad shader
    const rampVS = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const rampFS = `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uEmissive;
      varying vec2 vUv;
      void main() {
        float scroll = fract(vUv.y * 3.0 - uTime * 2.0);
        float chevron = smoothstep(0.0, 0.15, scroll) * (1.0 - smoothstep(0.35, 0.5, scroll));
        float edgeGlow = 1.0 - pow(abs(vUv.x - 0.5) * 2.0, 2.0);
        float stripe = smoothstep(0.35, 0.45, abs(vUv.x - 0.5));
        vec3 finalColor = uColor * 0.4 + uEmissive * (chevron * 1.8 + 0.2)
                        + uEmissive * edgeGlow * 0.6 + uEmissive * stripe * 0.3;
        finalColor *= 0.85 + 0.15 * sin(uTime * 4.0);
        gl_FragColor = vec4(finalColor, 0.95);
      }
    `;

    const halfW = cfg.width / 2;
    const rampLen = cfg.outerRadius - cfg.innerRadius;

    for (let i = 0; i < cfg.count; i++) {
      const angle = (i / cfg.count) * Math.PI * 2;

      // Radial direction (outward from center)
      const outX = Math.cos(angle);
      const outZ = Math.sin(angle);
      // Perpendicular (lateral) direction
      const latX = -outZ;
      const latZ = outX;

      // 4 corner positions in world space:
      // Outer edge (far from center) = on the ground (y=0.05)
      // Inner edge (near center/portal) = raised (y=cfg.height)
      const outerR = cfg.outerRadius;
      const innerR = cfg.innerRadius;

      // Outer-left, outer-right (on the ground)
      const olX = outX * outerR + latX * halfW;
      const olZ = outZ * outerR + latZ * halfW;
      const orX = outX * outerR - latX * halfW;
      const orZ = outZ * outerR - latZ * halfW;
      const outerY = 0.05;

      // Inner-left, inner-right (raised toward portal)
      const ilX = outX * innerR + latX * halfW;
      const ilZ = outZ * innerR + latZ * halfW;
      const irX = outX * innerR - latX * halfW;
      const irZ = outZ * innerR - latZ * halfW;
      const innerY = cfg.height;

      // Build geometry with explicit vertices (2 triangles)
      // Subdivide along length for smoother lighting
      const segs = 6;
      const verts = [];
      const uvs = [];
      const indices = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs; // 0=outer (ground), 1=inner (raised)
        const y = outerY + t * (innerY - outerY);
        // Left edge
        const lx = olX + t * (ilX - olX);
        const lz = olZ + t * (ilZ - olZ);
        // Right edge
        const rx = orX + t * (irX - orX);
        const rz = orZ + t * (irZ - orZ);
        verts.push(lx, y, lz); // left
        uvs.push(0, t);
        verts.push(rx, y, rz); // right
        uvs.push(1, t);
      }
      for (let s = 0; s < segs; s++) {
        const bl = s * 2;
        const br = s * 2 + 1;
        const tl = (s + 1) * 2;
        const tr = (s + 1) * 2 + 1;
        indices.push(bl, br, tl);
        indices.push(br, tr, tl);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(cfg.color) },
          uEmissive: { value: new THREE.Color(cfg.emissive) },
        },
        vertexShader: rampVS,
        fragmentShader: rampFS,
        transparent: true,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      // No rotation needed — vertices are already in world space
      this.scene.add(mesh);
      this._rampMeshes.push(mesh);
      this._rampMaterials.push(mat);

      // Midpoint for trigger detection
      const midR = (cfg.innerRadius + cfg.outerRadius) / 2;
      const cx = outX * midR;
      const cz = outZ * midR;
      this._rampPositions.push({ x: cx, z: cz, angle });

      // Side rails — two bars along left and right edges of the ramp
      for (const side of [-1, 1]) {
        const railVerts = [];
        const railH = 0.4;
        for (let s = 0; s <= segs; s++) {
          const t = s / segs;
          const y = outerY + t * (innerY - outerY);
          const ex = (side === -1)
            ? olX + t * (ilX - olX)
            : orX + t * (irX - orX);
          const ez = (side === -1)
            ? olZ + t * (ilZ - olZ)
            : orZ + t * (irZ - orZ);
          // Bottom of rail
          railVerts.push(ex, y, ez);
          // Top of rail
          railVerts.push(ex, y + railH, ez);
        }
        const railIdx = [];
        for (let s = 0; s < segs; s++) {
          const b = s * 2, t2 = (s + 1) * 2;
          railIdx.push(b, b + 1, t2);
          railIdx.push(b + 1, t2 + 1, t2);
        }
        const railGeo = new THREE.BufferGeometry();
        railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railVerts, 3));
        railGeo.setIndex(railIdx);
        railGeo.computeVertexNormals();

        const railMat = new THREE.MeshStandardMaterial({
          color: cfg.color,
          emissive: cfg.emissive,
          emissiveIntensity: 1.5,
          metalness: 0.8,
          roughness: 0.2,
        });
        const rail = new THREE.Mesh(railGeo, railMat);
        this.scene.add(rail);
        this._rampMeshes.push(rail);
      }

      // Ground arrows leading to the ramp
      for (let a = 0; a < 3; a++) {
        const arrowDist = outerR + 1.5 + a * 2;
        const ax = outX * arrowDist;
        const az = outZ * arrowDist;
        const arrowGeo = new THREE.ConeGeometry(0.4, 1.0, 3);
        const arrowMat = new THREE.MeshStandardMaterial({
          color: cfg.color,
          emissive: cfg.emissive,
          emissiveIntensity: 1.2 - a * 0.3,
          transparent: true,
          opacity: 0.8 - a * 0.2,
        });
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.position.set(ax, 0.15, az);
        // Cone points along +Y by default. Rotate to point inward (toward center)
        // Lay it flat: rotate around X, then face it inward via Y rotation
        arrow.rotation.set(0, 0, 0);
        arrow.lookAt(0, 0.15, 0);
        arrow.rotateX(Math.PI / 2);
        this.scene.add(arrow);
        this._rampMeshes.push(arrow);
      }
    }
  }

  _createTextSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.font = 'bold 48px Courier New';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Glow
    const hex = '#' + new THREE.Color(color).getHexString();
    ctx.shadowColor = hex;
    ctx.shadowBlur = 20;
    ctx.fillStyle = hex;
    ctx.fillText(text, 256, 64);
    // Second pass for brighter center
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.8;
    ctx.fillText(text, 256, 64);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    return new THREE.Sprite(mat);
  }

  // ── Update (call every frame) ────────────────────────────────────────

  update(dt) {
    this._time += dt;

    // Animate ramp shader
    if (this._rampMaterials) {
      for (const mat of this._rampMaterials) {
        mat.uniforms.uTime.value = this._time;
      }
    }

    // Animate exit portal
    if (this._exitGroup) {
      this._exitGroup.rotation.y += PORTAL.exit.rotationSpeed * dt;
      // Pulse the disc
      if (this._exitDisc) {
        this._exitDisc.material.opacity = 0.2 + 0.15 * Math.sin(this._time * 3);
      }
      // Bob up and down slightly
      this._exitGroup.position.y = PORTAL.exit.height + Math.sin(this._time * 0.8) * 0.5;
    }

    // Animate return portal
    if (this._returnGroup) {
      this._returnGroup.rotation.y += PORTAL.return.rotationSpeed * dt;
      if (this._returnDisc) {
        this._returnDisc.material.opacity = 0.2 + 0.1 * Math.sin(this._time * 2.5);
      }
    }

    // Warp transition animation
    if (this._warping) {
      this._updateWarpTransition(dt);
      return; // skip trigger checks during warp
    }

    // Check portal triggers
    this._checkExitPortal();
    this._checkReturnPortal();
    this._checkRampLaunch();
  }

  // ── Trigger checks ───────────────────────────────────────────────────

  _checkExitPortal() {
    if (this._warping) return;
    const player = this._getLocalPlayer();
    if (!player || !this._exitGroup) return;

    const pos = player.body.position;
    const portalPos = this._exitGroup.position;
    const dx = pos.x - portalPos.x;
    const dy = pos.y - portalPos.y;
    const dz = pos.z - portalPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < PORTAL.exit.radius) {
      this._startWarpTransition(this._buildExitURL());
    }
  }

  _checkReturnPortal() {
    if (this._warping) return;
    if (!this._returnGroup || !this._returnPosition) return;
    const player = this._getLocalPlayer();
    if (!player) return;

    const pos = player.body.position;
    const rp = this._returnPosition;
    const dx = pos.x - rp.x;
    const dz = pos.z - rp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < PORTAL.return.radius && Math.abs(pos.y - 0.6) < 2) {
      const url = this._buildReturnURL();
      if (url) this._startWarpTransition(url);
    }
  }

  // ── Warp transition ──────────────────────────────────────────────────

  _startWarpTransition(url) {
    this._warping = true;
    this._warpTime = 0;
    this._warpURL = url;

    // Freeze the player car
    const player = this._getLocalPlayer();
    if (player) {
      player.body.velocity.set(0, 0, 0);
      player.body.angularVelocity.set(0, 0, 0);
    }

    // Create fullscreen overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      pointer-events:none;
      opacity:0;transition:opacity 0.3s;
    `;
    document.body.appendChild(overlay);
    this._warpOverlay = overlay;

    // Vortex canvas (fullscreen)
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = 'width:100%;height:100%;';
    overlay.appendChild(canvas);
    this._warpCanvas = canvas;
    this._warpCtx = canvas.getContext('2d');

    // "WARPING..." text
    const text = document.createElement('div');
    text.textContent = 'WARPING...';
    text.style.cssText = `
      position:absolute;bottom:15%;left:50%;transform:translateX(-50%);
      font:bold 32px 'Courier New',monospace;color:#0ff;
      text-shadow:0 0 20px #0ff,0 0 40px #08f;
      letter-spacing:0.3em;
      animation:warp-pulse 0.6s ease-in-out infinite alternate;
    `;
    overlay.appendChild(text);

    // Inject pulse animation
    if (!document.getElementById('warp-styles')) {
      const style = document.createElement('style');
      style.id = 'warp-styles';
      style.textContent = `
        @keyframes warp-pulse {
          0% { opacity:0.6; transform:translateX(-50%) scale(1); }
          100% { opacity:1; transform:translateX(-50%) scale(1.05); }
        }
      `;
      document.head.appendChild(style);
    }

    // Fade in
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    // Redirect after animation — disconnect from multiplayer first
    setTimeout(() => {
      if (this._networkManager) {
        this._networkManager.disconnect();
      }
      window.location.href = this._warpURL;
    }, 2200);
  }

  _updateWarpTransition(dt) {
    if (!this._warping || !this._warpCtx) return;
    this._warpTime += dt;

    const ctx = this._warpCtx;
    const w = this._warpCanvas.width;
    const h = this._warpCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const t = this._warpTime;

    // Clear with dark background that gets darker over time
    const bgAlpha = Math.min(0.95, 0.3 + t * 0.3);
    ctx.fillStyle = `rgba(0, 2, 10, ${bgAlpha})`;
    ctx.fillRect(0, 0, w, h);

    // Vortex spiral arms
    const numArms = 5;
    const maxRadius = Math.sqrt(cx * cx + cy * cy);
    const spinSpeed = t * 3; // accelerating spin
    const intensity = Math.min(1, t * 0.5);

    for (let arm = 0; arm < numArms; arm++) {
      const armAngle = (arm / numArms) * Math.PI * 2;

      ctx.beginPath();
      for (let r = 10; r < maxRadius; r += 3) {
        const normalR = r / maxRadius;
        const spiralAngle = armAngle + normalR * 6 + spinSpeed * (1 + normalR * 0.5);
        const wobble = Math.sin(r * 0.05 + t * 8) * 3 * normalR;

        const px = cx + Math.cos(spiralAngle) * (r + wobble);
        const py = cy + Math.sin(spiralAngle) * (r + wobble);

        if (r === 10) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }

      // Cyan-to-blue gradient along arm
      const alpha = (0.15 + 0.1 * Math.sin(t * 4 + arm)) * intensity;
      ctx.strokeStyle = `rgba(0, ${180 + arm * 15}, 255, ${alpha})`;
      ctx.lineWidth = 2 + Math.sin(t * 3 + arm) * 1;
      ctx.stroke();
    }

    // Center glow (bright core)
    const glowR = 40 + Math.sin(t * 5) * 15;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR * (1 + t * 0.3));
    glow.addColorStop(0, `rgba(0, 255, 255, ${0.8 * intensity})`);
    glow.addColorStop(0.3, `rgba(0, 128, 255, ${0.4 * intensity})`);
    glow.addColorStop(1, 'rgba(0, 0, 30, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Speed lines (radial streaks pulling inward)
    const numStreaks = 60;
    for (let i = 0; i < numStreaks; i++) {
      const angle = (i / numStreaks) * Math.PI * 2 + t * 0.5;
      const startR = maxRadius * (0.3 + 0.7 * Math.random());
      const endR = startR * Math.max(0.1, 1 - t * 0.2);
      const streakAlpha = (0.1 + 0.15 * Math.random()) * intensity;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * startR, cy + Math.sin(angle) * startR);
      ctx.lineTo(cx + Math.cos(angle) * endR, cy + Math.sin(angle) * endR);
      ctx.strokeStyle = `rgba(100, 200, 255, ${streakAlpha})`;
      ctx.lineWidth = 1 + Math.random();
      ctx.stroke();
    }

    // Rotate the player car mesh in the 3D scene
    const player = this._getLocalPlayer();
    if (player && player.mesh) {
      player.mesh.rotation.y += dt * (4 + t * 3); // accelerating spin
    }
  }

  _checkRampLaunch() {
    const player = this._getLocalPlayer();
    if (!player) return;

    const cfg = PORTAL.ramps;
    const pos = player.body.position;
    const now = performance.now() / 1000;

    // Check cooldown
    const lastLaunch = this._rampCooldowns.get(player) || 0;
    if (now - lastLaunch < cfg.cooldownPerCar) return;

    for (const ramp of this._rampPositions) {
      const dx = pos.x - ramp.x;
      const dz = pos.z - ramp.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < cfg.width && Math.abs(pos.y - 0.6) < 1.5) {
        // Check car is moving toward center (dot product with inward direction)
        const vel = player.body.velocity;
        const toCenter = new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
        const dot = vel.x * toCenter.x + vel.z * toCenter.z;

        if (dot > 3) { // must be moving inward at reasonable speed
          // Launch!
          player.body.velocity.y = cfg.launchForce;
          // Push slightly toward center
          player.body.velocity.x += toCenter.x * cfg.lateralForce;
          player.body.velocity.z += toCenter.z * cfg.lateralForce;

          this._rampCooldowns.set(player, now);
          break;
        }
      }
    }
  }

  // ── Dispose ──────────────────────────────────────────────────────────

  dispose() {
    if (this._exitGroup) {
      this.scene.remove(this._exitGroup);
      this._exitGroup = null;
    }
    if (this._returnGroup) {
      this.scene.remove(this._returnGroup);
      this._returnGroup = null;
    }
    for (const mesh of this._rampMeshes || []) {
      this.scene.remove(mesh);
    }
  }
}
