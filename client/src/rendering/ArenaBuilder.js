import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA, THEME } from '../core/Config.js';
import {
  createMagmaUnderlayTexture,
  createScorchTexture, createScorchEmissiveMap,
} from './ProceduralTextures.js';
import { createLavaMaterial } from './LavaShader.js';
import { GeyserFX } from './GeyserFX.js';

// Reusable Object3D for InstancedMesh matrix updates (avoid per-frame allocation)
const _dummy = new THREE.Object3D();

// Reusable array for geyser light pool ranking (avoid per-frame allocation)
const _rankedSlots = [];

export class ArenaBuilder {
  constructor(scene) {
    this.scene = scene;
    this.boostPads = [];
    this.edgeLights = [];
    this.obstacleGroups = []; // { group, type: 'pillar'|'boulder', config, physicsBody? }
    this._clock = new THREE.Clock();
    this._emberFrameSkip = 0; // throttle ember updates
    this._decorFrameSkip = 0; // throttle decorative pulse updates

    // Group containing driveable surfaces (for car tilt raycasting)
    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);

    // Animation references
    this._lavaMaterial = null;
    this._lavaBubbles = [];
    this._emberVeins = [];
    this._emberParticles = null;
    this._geyserSlots = [];
    this._lavaFireMesh = null;
    this._lavaFireFrames = [];
    this._lavaFireFrameIndex = 0;
    this._lavaFireFrameTimer = 0;
    this._eruptionRing = null;
    this._eruptionMat = null;
    this._underlavaMat = null;
    this._lastElapsed = 0; // for computing dt from elapsed

    // Geyser FX system
    this.geyserFX = new GeyserFX(this.scene);
    this._scorchTexture = null;
    this._scorchEmissiveMap = null;

    // Eruption FX state
    this._eruptionSurgePoints = null;
    this._eruptionSurgeData = [];
    this._eruptionSurgeActive = false;
    this._eruptionDebrisMesh = null;
    this._eruptionDebrisData = [];
    this._eruptionDebrisDirty = false;
    this._eruptionFlash = null;
    this._eruptionFlashMat = null;
    this._eruptionFlashTimer = 0;
    this._eruptionWarningActive = false;
    this._eruptionWarningTimer = 0;
  }

  build() {
    this._buildPlatform();
    this._buildLavaPool();
    this._buildLavaFireEffect();
    this._buildEdgeLines();
    this._buildRockObstacles();
    this._buildEdgeBarriers();
    this._buildGeyserSlots();
    // Boost pads removed — replaced by portal launch ramps in PortalSystem
    this._buildSurfaceDetails();
    this._buildSkybox();
    this._buildLighting();
    this._buildDecorations();
    this._buildEruptionRing();
    this._buildEruptionFX();
  }

  // ── Octagonal Platform ───────────────────────────────────────────────
  _buildPlatform() {
    const radius = ARENA.diameter / 2;
    const sides = 8;
    const shape = new THREE.Shape();

    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 8;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    shape.closePath();

    // Cut out center hole for lava pool
    const hole = new THREE.Path();
    const lavaR = ARENA.lava.radius + 0.5; // slight overlap
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const x = Math.cos(a) * lavaR;
      const z = Math.sin(a) * lavaR;
      if (i === 0) hole.moveTo(x, z);
      else hole.lineTo(x, z);
    }
    hole.closePath();
    shape.holes.push(hole);

    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -0.5, 0);

    // ── Flat top surface (ShapeGeometry — lightweight) ──
    const surfaceGeo = new THREE.ShapeGeometry(shape, 12);
    surfaceGeo.rotateX(-Math.PI / 2);

    // Normalize UVs from world-space [-radius, radius] to [0, 1]
    const uvAttr = surfaceGeo.getAttribute('uv');
    for (let i = 0; i < uvAttr.count; i++) {
      uvAttr.setX(i, (uvAttr.getX(i) + radius) / (radius * 2));
      uvAttr.setY(i, (uvAttr.getY(i) + radius) / (radius * 2));
    }
    uvAttr.needsUpdate = true;
    surfaceGeo.setAttribute('uv2', surfaceGeo.getAttribute('uv').clone());

    // Load lava rock textures
    const texLoader = new THREE.TextureLoader();
    const tiles = 16;

    const rockTex = texLoader.load('/assets/textures/lava_color.png');
    rockTex.wrapS = rockTex.wrapT = THREE.RepeatWrapping;
    rockTex.repeat.set(tiles, tiles);
    rockTex.colorSpace = THREE.SRGBColorSpace;

    const rockNormal = texLoader.load('/assets/textures/lava_normal.png');
    rockNormal.wrapS = rockNormal.wrapT = THREE.RepeatWrapping;
    rockNormal.repeat.set(tiles, tiles);

    const rockAO = texLoader.load('/assets/textures/lava_ao.png');
    rockAO.wrapS = rockAO.wrapT = THREE.RepeatWrapping;
    rockAO.repeat.set(tiles, tiles);

    const lavaRadius = ARENA.lava.radius;
    const arenaRadius = radius;

    // Emissive map has WRONG polarity (white background = everything glows).
    // Instead: use color map to derive emission — bright lava cracks in the color
    // texture are already orange/yellow, so we extract emission from luminance
    // of the color map in the shader, and skip the broken emissive map entirely.
    const mat = new THREE.MeshStandardMaterial({
      map: rockTex,
      normalMap: rockNormal,
      normalScale: new THREE.Vector2(2.5, 2.5),
      emissive: new THREE.Color(0xff4400),
      emissiveIntensity: 0,
      aoMap: rockAO,
      aoMapIntensity: 1.0,
      roughness: 0.82,
      metalness: 0.1,
    });

    // ── Shader: auto-emission from color brightness + radial heat near lava ──
    mat.customProgramCacheKey = function () { return 'arena-surface-v7'; };

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLavaRadius = { value: lavaRadius };
      shader.uniforms.uArenaRadius = { value: arenaRadius };

      shader.vertexShader = shader.vertexShader.replace(
        'void main() {',
        `varying vec3 vWorldPos;\n         void main() {`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>\n         vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `varying vec3 vWorldPos;\n         uniform float uLavaRadius;\n         uniform float uArenaRadius;\n         void main() {`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>

         float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         float emitMask = smoothstep(0.25, 0.5, lum);
         totalEmissiveRadiance += diffuseColor.rgb * emitMask * 2.0;

         float heatDist = length(vWorldPos.xz);
         float heatFalloff = smoothstep(uLavaRadius + 10.0, uLavaRadius + 0.5, heatDist);
         float heatNoise = fract(sin(dot(vWorldPos.xz * 0.3, vec2(127.1, 311.7))) * 43758.5453);
         heatFalloff *= 0.7 + heatNoise * 0.3;
         totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * heatFalloff * 1.2;
        `
      );
    };

    this._platformMaterial = mat;

    // Top driving surface (ShapeGeometry — flat, guaranteed visible from above)
    const surface = new THREE.Mesh(surfaceGeo, mat);
    surface.position.y = 0.01; // just above y=0
    surface.receiveShadow = true;
    this.arenaGroup.add(surface);
    this.floorMesh = surface; // direct ref for optimized tilt raycasting

    // Side walls (ExtrudeGeometry — provides the 3D edge volume)
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x1a0e05, roughness: 0.9, metalness: 0.1,
    });
    const edgeMesh = new THREE.Mesh(geo, edgeMat);
    edgeMesh.receiveShadow = true;
    this.arenaGroup.add(edgeMesh);

    // ── Magma underlay (subtle glow beneath lava pool only) ──
    const lavaUnderlayR = ARENA.lava.radius + 1;
    const underGeo = new THREE.CircleGeometry(lavaUnderlayR, 16);
    underGeo.rotateX(-Math.PI / 2);
    const magmaTex = createMagmaUnderlayTexture(256);
    this._underlavaMat = new THREE.MeshStandardMaterial({
      map: magmaTex,
      emissive: 0x661100,
      emissiveIntensity: 0.6,
      roughness: 0.5,
    });
    const underlava = new THREE.Mesh(underGeo, this._underlavaMat);
    underlava.position.y = -0.6;
    this.scene.add(underlava);
  }

  // ── Lava Pool (center) ───────────────────────────────────────────────
  _buildLavaPool() {
    const { radius } = ARENA.lava;

    // Lava surface with custom shader (animated UV distortion, bloom-friendly)
    const lavaGeo = new THREE.CircleGeometry(radius, 32);
    lavaGeo.rotateX(-Math.PI / 2);
    this._lavaMaterial = createLavaMaterial();
    const lava = new THREE.Mesh(lavaGeo, this._lavaMaterial);
    lava.position.y = -0.08;
    this.scene.add(lava);

    // Rocky rim (thin, subtle)
    const rimGeo = new THREE.TorusGeometry(radius + 0.2, 0.25, 8, 32);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.95 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 0.05;
    rim.rotation.x = Math.PI / 2;
    this.scene.add(rim);

    // Lava bubbles
    const bubbleMat = new THREE.MeshStandardMaterial({
      color: THEME.lavaColor, emissive: THEME.lavaEmissive, emissiveIntensity: 2.5,
    });
    for (let i = 0; i < 6; i++) {
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(0.15 + Math.random() * 0.25, 6, 4), bubbleMat
      );
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius * 0.7;
      bubble.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
      this.scene.add(bubble);
      this._lavaBubbles.push({ mesh: bubble, poolRadius: radius, speed: 0.15 + Math.random() * 0.25 });
    }

    // Lava glow light (moderate — avoid washing everything in orange)
    const lavaLight = new THREE.PointLight(0xff5500, 0.8, 25);
    lavaLight.position.set(0, 2, 0);
    this.scene.add(lavaLight);
  }

  // ── Edge Lines ───────────────────────────────────────────────────────
  _buildEdgeLines() {
    const radius = ARENA.diameter / 2;
    const sides = 8;
    const tubeMat = new THREE.MeshStandardMaterial({
      color: THEME.edgeTube, emissive: THEME.edgeGlow, emissiveIntensity: 1.2,
      transparent: true, opacity: 0.7,
    });

    // Merge all edge tubes into a single draw call
    const edgeTubeGeos = [];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2 - Math.PI / 8;
      const a1 = ((i + 1) / sides) * Math.PI * 2 - Math.PI / 8;
      const p1 = new THREE.Vector3(Math.cos(a0) * radius, 0.05, Math.sin(a0) * radius);
      const p2 = new THREE.Vector3(Math.cos(a1) * radius, 0.05, Math.sin(a1) * radius);
      edgeTubeGeos.push(new THREE.TubeGeometry(new THREE.LineCurve3(p1, p2), 1, 0.18, 8, false));
    }
    const mergedEdgeTubes = mergeGeometries(edgeTubeGeos);
    this.scene.add(new THREE.Mesh(mergedEdgeTubes, tubeMat));
    for (const g of edgeTubeGeos) g.dispose();

    // Lava pool inner ring (red glow) — merged into single draw call
    const lavaTubeMat = new THREE.MeshStandardMaterial({
      color: 0xcc3300, emissive: 0x882200, emissiveIntensity: 1.5, transparent: true, opacity: 0.8,
    });
    const lavaR = ARENA.lava.radius + 0.3;
    const lavaRingGeos = [];
    for (let i = 0; i < 16; i++) {
      const a0 = (i / 16) * Math.PI * 2;
      const a1 = ((i + 1) / 16) * Math.PI * 2;
      const p1 = new THREE.Vector3(Math.cos(a0) * lavaR, 0.08, Math.sin(a0) * lavaR);
      const p2 = new THREE.Vector3(Math.cos(a1) * lavaR, 0.08, Math.sin(a1) * lavaR);
      lavaRingGeos.push(new THREE.TubeGeometry(new THREE.LineCurve3(p1, p2), 1, 0.12, 8, false));
    }
    const mergedLavaRing = mergeGeometries(lavaRingGeos);
    this.scene.add(new THREE.Mesh(mergedLavaRing, lavaTubeMat));
    for (const g of lavaRingGeos) g.dispose();

    // Edge glow handled by emissive tubes + bloom — no point lights needed
  }

  // ── Lava Fire Effect (animated texture on lava pool) ──────────────────
  _buildLavaFireEffect() {
    const { radius } = ARENA.lava;
    const texLoader = new THREE.TextureLoader();
    const frameCount = 46;

    // Load all animation frames
    for (let i = 0; i < frameCount; i++) {
      const idx = String(i).padStart(4, '0');
      const tex = texLoader.load(`/assets/textures/fluid_simple/fire_${idx}.png`);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._lavaFireFrames.push(tex);
    }

    // Create a plane slightly above the lava surface, use Additive blending
    // to make the black background disappear (black = 0 in additive = transparent)
    const fireGeo = new THREE.CircleGeometry(radius * 0.92, 32);
    fireGeo.rotateX(-Math.PI / 2);
    const fireMat = new THREE.MeshBasicMaterial({
      map: this._lavaFireFrames[0],
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._lavaFireMesh = new THREE.Mesh(fireGeo, fireMat);
    this._lavaFireMesh.position.y = -0.02;
    this._lavaFireMesh.renderOrder = 1;
    this.scene.add(this._lavaFireMesh);
  }

  // ── Rock Obstacles (pillars + boulders — physics in PhysicsWorld) ────
  _buildRockObstacles() {
    const { pillars, boulders } = ARENA.rockObstacles;
    // Lazy-init shared rock textures (reused by _buildEdgeBarriers)
    this._ensureRockTextures();
    const rockTex = this._rockTex;
    const rockNormal = this._rockNormal;

    // Shared materials (2 instead of ~17 cloned per-obstacle)
    const pillarMat = new THREE.MeshStandardMaterial({
      map: rockTex,
      normalMap: rockNormal,
      normalScale: new THREE.Vector2(2.0, 2.0),
      roughness: 0.9,
      metalness: 0.05,
      emissive: 0x331100,
      emissiveIntensity: 0.15,
    });
    const boulderMat = new THREE.MeshStandardMaterial({
      map: rockTex,
      normalMap: rockNormal,
      normalScale: new THREE.Vector2(2.0, 2.0),
      roughness: 0.92,
      metalness: 0.05,
      emissive: 0x221000,
      emissiveIntensity: 0.1,
    });
    const baseCrackMat = new THREE.MeshStandardMaterial({
      color: 0x661100,
      emissive: 0xff4400,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.6,
    });

    // ── Pillars — tapered, rough-hewn rock columns ──
    for (const p of pillars) {
      const x = Math.cos(p.angle) * p.dist;
      const z = Math.sin(p.angle) * p.dist;
      const group = new THREE.Group();

      // Main pillar body — CylinderGeometry with radial segments for organic look
      const pillarGeo = new THREE.CylinderGeometry(
        p.baseRadius * 0.6,  // top radius (tapered)
        p.baseRadius,         // bottom radius
        p.height,
        7,                    // radial segments (odd = more natural)
        4,                    // height segments for vertex displacement
      );

      // Scale UVs in geometry instead of cloning texture with different repeat
      const uvScale = p.height / 3;
      const uvAttr = pillarGeo.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) {
        uvAttr.setY(i, uvAttr.getY(i) * uvScale);
      }
      uvAttr.needsUpdate = true;

      // Displace vertices for a rugged, natural rock shape
      const posAttr = pillarGeo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vy = posAttr.getY(i);
        const vz = posAttr.getZ(i);
        // Skip top/bottom cap centers
        const dist = Math.sqrt(vx * vx + vz * vz);
        if (dist < 0.01) continue;
        // Noise displacement based on position
        const noise = Math.sin(vy * 3.1 + vx * 2.7) * 0.15
                    + Math.cos(vz * 4.3 + vy * 1.9) * 0.12
                    + Math.sin(vx * 5.2 + vz * 3.8) * 0.08;
        const factor = 1 + noise;
        posAttr.setX(i, vx * factor);
        posAttr.setZ(i, vz * factor);
      }
      pillarGeo.computeVertexNormals();

      const pillarMesh = new THREE.Mesh(pillarGeo, pillarMat);
      pillarMesh.castShadow = true;
      pillarMesh.receiveShadow = true;
      group.add(pillarMesh);

      // Stacked rock ledges around the pillar (2-3 per pillar)
      const ledgeCount = 2 + Math.floor(Math.random() * 2);
      for (let j = 0; j < ledgeCount; j++) {
        const ledgeY = -p.height * 0.3 + (j / ledgeCount) * p.height * 0.7;
        const ledgeR = p.baseRadius * (0.8 + Math.random() * 0.5);
        const ledgeAngle = Math.random() * Math.PI * 2;
        const ledgeGeo = new THREE.DodecahedronGeometry(ledgeR * 0.5, 0);
        ledgeGeo.scale(1.6, 0.4, 1.2);
        const ledgeMesh = new THREE.Mesh(ledgeGeo, pillarMat);
        ledgeMesh.position.set(
          Math.cos(ledgeAngle) * p.baseRadius * 0.5,
          ledgeY,
          Math.sin(ledgeAngle) * p.baseRadius * 0.5,
        );
        ledgeMesh.rotation.y = ledgeAngle;
        ledgeMesh.castShadow = true;
        group.add(ledgeMesh);
      }

      // Craggy top — irregular rocks crowning the pillar
      for (let j = 0; j < 3; j++) {
        const topR = p.baseRadius * 0.3 + Math.random() * p.baseRadius * 0.25;
        const topGeo = new THREE.DodecahedronGeometry(topR, 1);
        // Stretch vertically for a pointed look
        topGeo.scale(1, 1.3 + Math.random() * 0.8, 1);
        const topMesh = new THREE.Mesh(topGeo, pillarMat);
        topMesh.position.set(
          (Math.random() - 0.5) * p.baseRadius * 0.6,
          p.height * 0.45 + Math.random() * topR,
          (Math.random() - 0.5) * p.baseRadius * 0.6,
        );
        topMesh.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.3);
        topMesh.castShadow = true;
        group.add(topMesh);
      }

      // Small emissive crack at base (lava seeping through)
      const crackGeo = new THREE.TorusGeometry(p.baseRadius + 0.1, 0.08, 4, 12);
      const crack = new THREE.Mesh(crackGeo, baseCrackMat);
      crack.rotation.x = Math.PI / 2;
      crack.position.y = -p.height / 2 + 0.05;
      group.add(crack);

      group.position.set(x, p.height / 2, z);
      group.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(group);
      this.obstacleGroups.push({ group, type: 'pillar', config: p });
    }

    // ── Boulders — irregular rounded rocks (shared material) ──
    for (const b of boulders) {
      const x = Math.cos(b.angle) * b.dist;
      const z = Math.sin(b.angle) * b.dist;
      const group = new THREE.Group();

      // Main boulder — deformed icosahedron
      const boulderGeo = new THREE.IcosahedronGeometry(b.radius, 1);
      // Squash vertically to look like a resting boulder
      boulderGeo.scale(1, 0.65, 1);

      // Displace vertices for irregularity
      const posAttr = boulderGeo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vy = posAttr.getY(i);
        const vz = posAttr.getZ(i);
        const noise = Math.sin(vx * 4.1 + vz * 3.3) * 0.12
                    + Math.cos(vy * 5.7 + vx * 2.1) * 0.08;
        posAttr.setX(i, vx * (1 + noise));
        posAttr.setY(i, vy * (1 + noise * 0.5));
        posAttr.setZ(i, vz * (1 + noise));
      }
      boulderGeo.computeVertexNormals();

      const boulderMesh = new THREE.Mesh(boulderGeo, boulderMat);
      boulderMesh.castShadow = true;
      boulderMesh.receiveShadow = true;
      group.add(boulderMesh);

      // 1-2 smaller rocks clustered around the main boulder
      const clusterCount = 1 + Math.floor(Math.random() * 2);
      for (let j = 0; j < clusterCount; j++) {
        const smallR = b.radius * (0.3 + Math.random() * 0.3);
        const smallGeo = new THREE.DodecahedronGeometry(smallR, 0);
        smallGeo.scale(1, 0.7, 1);
        const smallMesh = new THREE.Mesh(smallGeo, boulderMat);
        const sa = Math.random() * Math.PI * 2;
        smallMesh.position.set(
          Math.cos(sa) * (b.radius + smallR * 0.3),
          -b.radius * 0.2,
          Math.sin(sa) * (b.radius + smallR * 0.3),
        );
        smallMesh.rotation.set(Math.random(), Math.random(), Math.random());
        smallMesh.castShadow = true;
        group.add(smallMesh);
      }

      group.position.set(x, b.radius * 0.6, z);
      group.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(group);
      this.obstacleGroups.push({ group, type: 'boulder', config: b });
    }
  }

  // Lazy-load and cache the shared volcanic-rock textures used by both
  // _buildRockObstacles and _buildEdgeBarriers. Called from either site;
  // whoever runs first triggers the HTTP fetch, the other reuses the
  // cached THREE.Texture — no duplicate GPU uploads.
  _ensureRockTextures() {
    if (this._rockTex) return;
    const texLoader = new THREE.TextureLoader();
    this._rockTex = texLoader.load('/assets/textures/volcano_floor.png');
    this._rockTex.wrapS = this._rockTex.wrapT = THREE.RepeatWrapping;
    this._rockTex.colorSpace = THREE.SRGBColorSpace;
    this._rockNormal = texLoader.load('/assets/textures/lava_normal.png');
    this._rockNormal.wrapS = this._rockNormal.wrapT = THREE.RepeatWrapping;
  }

  // ── Destructible Edge Barriers (volcanic rock walls) ────────────────
  // 8 edges × N segments. Dark rock body + emissive magma crack overlay
  // whose intensity grows with accumulated ram damage. Fully destroyed
  // segments spawn shatter VFX and (in multiplayer) respawn after a
  // server-driven timer with a rise-up animation.
  _buildEdgeBarriers() {
    const cfg = ARENA.edgeBarriers;
    if (!cfg) return;

    const R = ARENA.diameter / 2;
    const sides = 8;

    // Reuse cached textures from _buildRockObstacles (or load lazily
    // if _buildEdgeBarriers happens to run first).
    this._ensureRockTextures();
    const rockTex = this._rockTex;
    const rockNormal = this._rockNormal;

    this._barrierRockMat = new THREE.MeshStandardMaterial({
      map: rockTex,
      normalMap: rockNormal,
      normalScale: new THREE.Vector2(1.6, 1.6),
      roughness: 0.92,
      metalness: 0.05,
      emissive: 0x2a0a00,
      emissiveIntensity: 0.2,
    });
    // Single crack material — per-segment emissiveIntensity is managed
    // via a userData-driven per-mesh material? No — we need per-segment
    // state, so each segment gets its own instance. Cheap clones (same
    // shader program, only uniforms differ).
    this._barrierCrackBaseColor = 0x661100;
    this._barrierCrackEmissive = 0xff4400;

    // Shared geometries: main box + crack overlay (slight outward
    // scale to avoid Z-fighting) + crown rim geometry.
    const boxGeo = new THREE.BoxGeometry(cfg.width, cfg.height, cfg.thickness);
    const crackGeo = new THREE.BoxGeometry(
      cfg.width * 1.005, cfg.height * 1.005, cfg.thickness * 1.02,
    );
    const rimGeo = new THREE.BoxGeometry(cfg.width * 1.02, 0.12, cfg.thickness * 1.25);

    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x1a0500,
      emissive: 0xff3300,
      emissiveIntensity: 0.9,
      roughness: 0.7,
      metalness: 0.2,
    });

    // Save shared refs so respawn can reuse without recreating.
    this._barrierShared = {
      boxGeo, crackGeo, rimGeo,
      rockMat: this._barrierRockMat,
      rimMat,
      cfg,
    };

    for (let edgeIdx = 0; edgeIdx < sides; edgeIdx++) {
      const a0 = (edgeIdx / sides) * Math.PI * 2 - Math.PI / 8;
      const a1 = ((edgeIdx + 1) / sides) * Math.PI * 2 - Math.PI / 8;
      const p1x = Math.cos(a0) * R, p1z = Math.sin(a0) * R;
      const p2x = Math.cos(a1) * R, p2z = Math.sin(a1) * R;
      const mx = (p1x + p2x) / 2, mz = (p1z + p2z) / 2;
      const ex = p2x - p1x, ez = p2z - p1z;
      const elen = Math.hypot(ex, ez);
      const tx = ex / elen, tz = ez / elen;
      const mR = Math.hypot(mx, mz);
      const nx = -mx / mR, nz = -mz / mR;
      const yaw = Math.atan2(tz, tx);

      for (let segIdx = 0; segIdx < cfg.segmentsPerEdge; segIdx++) {
        const frac = (segIdx + 0.5) / cfg.segmentsPerEdge - 0.5;
        const cx = mx + tx * elen * frac + nx * cfg.inset;
        const cz = mz + tz * elen * frac + nz * cfg.inset;
        const segConfig = { edgeIdx, segIdx, x: cx, z: cz, yaw };
        this._spawnBarrierVisual(segConfig, { rising: false });
      }
    }
  }

  _spawnBarrierVisual(segConfig, { rising }) {
    const { boxGeo, crackGeo, rimGeo, rockMat, rimMat, cfg } = this._barrierShared;
    const group = new THREE.Group();

    const body = new THREE.Mesh(boxGeo, rockMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Per-segment crack material (cloned so emissiveIntensity is independent).
    const crackMat = new THREE.MeshStandardMaterial({
      color: this._barrierCrackBaseColor,
      emissive: this._barrierCrackEmissive,
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0,
      roughness: 0.6,
      metalness: 0.0,
    });
    const crack = new THREE.Mesh(crackGeo, crackMat);
    group.add(crack);

    // Top rim — thin emissive stripe crowning each segment.
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = cfg.height / 2 + 0.02;
    group.add(rim);

    const finalY = cfg.height / 2;
    group.position.set(segConfig.x, rising ? -cfg.height : finalY, segConfig.z);
    group.rotation.y = segConfig.yaw;
    this.scene.add(group);

    const entry = {
      group,
      type: 'barrier',
      config: segConfig,
      crackMat,
      crackHits: 0,
      // Animation state for respawn rise-up
      rising: rising
        ? { t: 0, duration: cfg.respawnRiseTimeSec, fromY: -cfg.height, toY: finalY }
        : null,
    };
    this.obstacleGroups.push(entry);
    return entry;
  }

  /**
   * Increment crack level on a given barrier segment (visual only).
   * Called from Game.js when a car rams a barrier below the destroy
   * threshold but above the crack threshold. No network sync — purely
   * local feedback that the wall is under stress.
   */
  damageBarrierVisual(edgeIdx, segIdx) {
    const cfg = ARENA.edgeBarriers;
    for (const og of this.obstacleGroups) {
      if (og.type !== 'barrier') continue;
      if (og.config.edgeIdx !== edgeIdx || og.config.segIdx !== segIdx) continue;
      og.crackHits = Math.min(og.crackHits + 1, cfg.maxCrackHits);
      const t = og.crackHits / cfg.maxCrackHits;
      og.crackMat.emissiveIntensity = 0.6 + t * 2.0;
      og.crackMat.opacity = 0.25 + t * 0.55;
      return;
    }
  }

  /**
   * Rebuild a destroyed barrier with a rise-up animation. Idempotent —
   * if the segment is already present the call is a no-op.
   */
  respawnBarrierVisual(edgeIdx, segIdx) {
    for (const og of this.obstacleGroups) {
      if (og.type === 'barrier'
        && og.config.edgeIdx === edgeIdx
        && og.config.segIdx === segIdx) return;
    }
    const R = ARENA.diameter / 2;
    const sides = 8;
    const a0 = (edgeIdx / sides) * Math.PI * 2 - Math.PI / 8;
    const a1 = ((edgeIdx + 1) / sides) * Math.PI * 2 - Math.PI / 8;
    const p1x = Math.cos(a0) * R, p1z = Math.sin(a0) * R;
    const p2x = Math.cos(a1) * R, p2z = Math.sin(a1) * R;
    const mx = (p1x + p2x) / 2, mz = (p1z + p2z) / 2;
    const ex = p2x - p1x, ez = p2z - p1z;
    const elen = Math.hypot(ex, ez);
    const tx = ex / elen, tz = ez / elen;
    const mR = Math.hypot(mx, mz);
    const nx = -mx / mR, nz = -mz / mR;
    const yaw = Math.atan2(tz, tx);
    const cfg = ARENA.edgeBarriers;
    const frac = (segIdx + 0.5) / cfg.segmentsPerEdge - 0.5;
    const cx = mx + tx * elen * frac + nx * cfg.inset;
    const cz = mz + tz * elen * frac + nz * cfg.inset;
    this._spawnBarrierVisual({ edgeIdx, segIdx, x: cx, z: cz, yaw }, { rising: true });
  }

  /** Advance rise-up animations for barriers currently respawning. */
  _updateBarrierRise(dt) {
    const cfg = ARENA.edgeBarriers;
    if (!cfg) return;
    for (const og of this.obstacleGroups) {
      if (og.type !== 'barrier' || !og.rising) continue;
      og.rising.t += dt;
      const t = Math.min(og.rising.t / og.rising.duration, 1);
      // Ease-out with a small overshoot bounce at the end
      const eased = 1 - Math.pow(1 - t, 3);
      const overshoot = t > 0.85 ? Math.sin((t - 0.85) / 0.15 * Math.PI) * 0.15 : 0;
      og.group.position.y = og.rising.fromY
        + (og.rising.toY - og.rising.fromY) * eased
        + overshoot;
      if (t >= 1) {
        og.group.position.y = og.rising.toY;
        og.rising = null;
      }
    }
  }

  // ── Geyser Slots (optimized — logic in DynamicHazards) ──────────────
  _buildGeyserSlots() {
    const { count, radius: geyserR } = ARENA.geysers;
    const FX = ARENA.geysers.fx;

    // Pre-generate scorch textures (shared across all slots)
    this._scorchTexture = createScorchTexture(256);
    this._scorchEmissiveMap = createScorchEmissiveMap(256);

    // Shared geometries (created once, reused by all slots)
    const markerGeo = new THREE.CylinderGeometry(geyserR, geyserR, 0.05, 12);
    const ringGeo = new THREE.RingGeometry(FX.warningRing.innerRadius, FX.warningRing.outerRadius, 16);
    ringGeo.rotateX(-Math.PI / 2);
    const scorchGeo = new THREE.PlaneGeometry(FX.scorch.radius * 2, FX.scorch.radius * 2);
    scorchGeo.rotateX(-Math.PI / 2);

    // Shared materials (reused where possible — reduces draw call batching overhead)
    const sharedMarkerMat = new THREE.MeshStandardMaterial({
      color: 0x3d2b1a, emissive: 0x000000, emissiveIntensity: 0,
      transparent: true, opacity: 0.7,
    });
    const sharedCrackMat = new THREE.MeshStandardMaterial({
      color: 0x1a0500, emissive: THEME.lavaEmissive,
      emissiveIntensity: 0, roughness: 0.9,
    });
    const sharedRingMat = new THREE.MeshStandardMaterial({
      color: THEME.geyserWarning, emissive: THEME.geyserWarning,
      emissiveIntensity: 1.5, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const sharedScorchMat = new THREE.MeshStandardMaterial({
      map: this._scorchTexture,
      emissiveMap: this._scorchEmissiveMap,
      emissive: THEME.lavaEmissive,
      emissiveIntensity: FX.scorch.emissiveIntensity,
      transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1,
    });

    // Merged crack geometry (all 5 cracks baked into one mesh per slot)
    const crackMergedGeo = new THREE.BufferGeometry();
    const singleCrack = new THREE.BoxGeometry(FX.cracks.length, FX.cracks.height, FX.cracks.width);
    singleCrack.translate(FX.cracks.length / 2, 0, 0);
    const merged = [];
    for (let c = 0; c < FX.cracks.count; c++) {
      const angle = (c / FX.cracks.count) * Math.PI * 2;
      const clone = singleCrack.clone();
      clone.rotateY(angle);
      merged.push(clone);
    }
    // Merge into single geometry using BufferGeometryUtils pattern
    const totalVerts = merged.reduce((s, g) => s + g.attributes.position.count, 0);
    const totalIdx = merged.reduce((s, g) => s + (g.index ? g.index.count : 0), 0);
    const mergedPos = new Float32Array(totalVerts * 3);
    const mergedNorm = new Float32Array(totalVerts * 3);
    const mergedIndex = new Uint16Array(totalIdx);
    let vOff = 0, iOff = 0, baseV = 0;
    for (const g of merged) {
      const p = g.attributes.position.array;
      const n = g.attributes.normal.array;
      mergedPos.set(p, vOff * 3);
      mergedNorm.set(n, vOff * 3);
      if (g.index) {
        for (let j = 0; j < g.index.count; j++) {
          mergedIndex[iOff + j] = g.index.array[j] + baseV;
        }
        iOff += g.index.count;
      }
      baseV += g.attributes.position.count;
      vOff += g.attributes.position.count;
      g.dispose();
    }
    singleCrack.dispose();
    crackMergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    crackMergedGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    crackMergedGeo.setIndex(new THREE.BufferAttribute(mergedIndex, 1));

    // Column geometries per layer (2 layers)
    const colGeos = [];
    const colMats = []; // shared across all slots
    for (let l = 0; l < FX.column.layers; l++) {
      const r = FX.column.baseRadius * FX.column.radiusScale[l];
      colGeos.push(new THREE.CylinderGeometry(r * 0.4, r, FX.column.height, 8));
      colMats.push(new THREE.MeshBasicMaterial({
        color: l === 0 ? 0xffaa33 : THEME.lavaColor,
        transparent: true,
        opacity: FX.column.opacities[l],
        depthWrite: false,
        side: THREE.FrontSide,
      }));
    }

    // ── Shared light pool (2 lights, assigned to nearest active geysers) ──
    this._geyserLightPool = [];
    for (let l = 0; l < FX.light.poolSize; l++) {
      const light = new THREE.PointLight(FX.light.warningColor, 0, FX.light.range);
      light.position.set(0, -10, 0);
      this.scene.add(light);
      this._geyserLightPool.push({ light, slotIndex: -1, intensity: 0 });
    }

    for (let i = 0; i < count; i++) {
      const slot = {};

      // Marker — each slot needs its own material for independent emissive
      slot.markerMat = sharedMarkerMat.clone();
      slot.marker = new THREE.Mesh(markerGeo, slot.markerMat);
      slot.marker.position.set(0, -10, 0);
      this.scene.add(slot.marker);

      // Merged cracks (1 mesh instead of 5) — shared material, animate via scale
      slot.crackMat = sharedCrackMat.clone();
      slot.crackMesh = new THREE.Mesh(crackMergedGeo, slot.crackMat);
      slot.crackMesh.position.set(0, -10, 0);
      slot.crackMesh.visible = false;
      this.scene.add(slot.crackMesh);

      // Warning ring — shared material clone (needs independent opacity)
      slot.warningRingMat = sharedRingMat.clone();
      slot.warningRing = new THREE.Mesh(ringGeo, slot.warningRingMat);
      slot.warningRing.position.set(0, -10, 0);
      this.scene.add(slot.warningRing);

      // Column layers (shared material refs — columns don't need independent opacity
      // since they animate via scale, not material)
      slot.columns = [];
      for (let l = 0; l < FX.column.layers; l++) {
        const col = new THREE.Mesh(colGeos[l], colMats[l]);
        col.position.set(0, -10, 0);
        col.visible = false;
        this.scene.add(col);
        slot.columns.push({ mesh: col });
      }

      // Scorch mark — needs clone for independent opacity/emissive
      slot.scorchMat = sharedScorchMat.clone();
      slot.scorch = new THREE.Mesh(scorchGeo, slot.scorchMat);
      slot.scorch.position.set(0, -10, 0);
      slot.scorchTimer = 0;
      slot.scorchFading = false;
      this.scene.add(slot.scorch);

      // Particle FX slot
      slot.fxIndex = this.geyserFX.createSlot();

      // State tracking
      slot.x = 0;
      slot.z = 0;
      slot.state = 'idle';
      slot.columnScaleY = 0;
      slot.columnVisible = false;
      slot.lightPriority = 0;  // higher = more deserving of a shared light
      slot.crackScale = 0;

      this._geyserSlots.push(slot);
    }
  }

  // ── Eruption Ring (expanding shockwave visual) ───────────────────────
  _buildEruptionRing() {
    const geo = new THREE.RingGeometry(1, 3, 32);
    geo.rotateX(-Math.PI / 2);
    this._eruptionMat = new THREE.MeshStandardMaterial({
      color: THEME.lavaColor, emissive: THEME.lavaEmissive, emissiveIntensity: 3,
      transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    this._eruptionRing = new THREE.Mesh(geo, this._eruptionMat);
    this._eruptionRing.position.y = 0.15;
    this._eruptionRing.visible = false;
    this.scene.add(this._eruptionRing);
  }

  // ── Eruption FX (particles, debris, flash) ──────────────────────────
  _buildEruptionFX() {
    const EFX = ARENA.eruption.fx;

    // ── Lava surge point cloud (burst upward from pool) ──
    const surgeCount = EFX.surge.count;
    const surgePositions = new Float32Array(surgeCount * 3);
    for (let i = 0; i < surgeCount; i++) {
      surgePositions[i * 3 + 1] = -100;
      this._eruptionSurgeData.push({ vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, active: false });
    }
    const surgeGeo = new THREE.BufferGeometry();
    surgeGeo.setAttribute('position', new THREE.BufferAttribute(surgePositions, 3));
    const surgeMat = new THREE.PointsMaterial({
      color: 0xffaa22,
      size: EFX.surge.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._eruptionSurgePoints = new THREE.Points(surgeGeo, surgeMat);
    this._eruptionSurgePoints.frustumCulled = false;
    this._eruptionSurgePoints.visible = false;
    this.scene.add(this._eruptionSurgePoints);

    // ── Debris chunks (InstancedMesh) ──
    const debrisGeo = new THREE.DodecahedronGeometry(EFX.debris.radius, 0);
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0x661100,
      emissive: THEME.lavaEmissive,
      emissiveIntensity: 2.0,
      roughness: 0.7,
    });
    this._eruptionDebrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, EFX.debris.count);
    this._eruptionDebrisMesh.frustumCulled = false;
    for (let i = 0; i < EFX.debris.count; i++) {
      _dummy.position.set(0, -100, 0);
      _dummy.updateMatrix();
      this._eruptionDebrisMesh.setMatrixAt(i, _dummy.matrix);
      this._eruptionDebrisData.push({
        vx: 0, vy: 0, vz: 0, x: 0, y: -100, z: 0,
        rx: 0, ry: 0, rz: 0, life: 0, active: false,
      });
    }
    this._eruptionDebrisMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this._eruptionDebrisMesh);

    // ── Screen flash (fullscreen quad attached to camera) ──
    const flashGeo = new THREE.PlaneGeometry(2, 2);
    this._eruptionFlashMat = new THREE.MeshBasicMaterial({
      color: EFX.flash.color,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._eruptionFlash = new THREE.Mesh(flashGeo, this._eruptionFlashMat);
    this._eruptionFlash.renderOrder = 9999;
    this._eruptionFlash.frustumCulled = false;
    this._eruptionFlash.visible = false;
    // Will be parented to camera in showEruptionBlast
  }

  // ── Boost Pads ───────────────────────────────────────────────────────
  _buildBoostPads() {
    const padGeo = new THREE.BoxGeometry(4, 0.08, 1.5);
    const radius = ARENA.diameter / 2;

    for (let i = 0; i < ARENA.boostPadCount; i++) {
      const angle = (i / ARENA.boostPadCount) * Math.PI * 2;
      const dist = radius * 0.55;

      const padMat = new THREE.MeshStandardMaterial({
        color: THEME.boostPad, emissive: THEME.boostPad,
        emissiveIntensity: 1.5, transparent: true, opacity: 0.9,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(Math.cos(angle) * dist, 0.04, Math.sin(angle) * dist);
      pad.rotation.y = -angle + Math.PI / 2;
      this.scene.add(pad);

      const arrowGeo = new THREE.ConeGeometry(0.3, 0.8, 4);
      const arrowMat = new THREE.MeshStandardMaterial({
        color: THEME.boostPad, emissive: THEME.boostPad, emissiveIntensity: 2,
      });
      const arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(Math.cos(angle) * dist, 0.15, Math.sin(angle) * dist);
      arrow.rotation.y = -angle;
      this.scene.add(arrow);

      this.boostPads.push({ mesh: pad, material: padMat, angle });
    }
  }

  // ── Surface Details ──────────────────────────────────────────────────
  _buildSurfaceDetails() {
    const radius = ARENA.diameter / 2;
    const patchMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1a, roughness: 0.95 });

    // Rock patches — merged into single draw call
    const patchGeos = [];
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = ARENA.lava.radius + 4 + Math.random() * (radius - ARENA.lava.radius - 8);
      const r = 1.5 + Math.random() * 1.5;
      const g = new THREE.CylinderGeometry(r, r * 1.1, 0.1, 6);
      g.translate(Math.cos(a) * d, 0.05, Math.sin(a) * d);
      patchGeos.push(g);
    }
    const mergedPatches = mergeGeometries(patchGeos);
    const patchMesh = new THREE.Mesh(mergedPatches, patchMat);
    patchMesh.castShadow = true;
    patchMesh.receiveShadow = true;
    this.scene.add(patchMesh);
    for (const g of patchGeos) g.dispose();

    // Magma veins — merged into single draw call with shared material
    this._veinMat = new THREE.MeshStandardMaterial({
      color: 0x661100, emissive: 0x441100, emissiveIntensity: 0.8,
      transparent: true, opacity: 0.5,
    });
    const veinGeos = [];
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = ARENA.lava.radius + 3 + Math.random() * (radius - ARENA.lava.radius - 6);
      const len = 4 + Math.random() * 6;
      const g = new THREE.BoxGeometry(len, 0.02, 0.2);
      // Apply rotation before merging (can't rotate after merge)
      const rotY = Math.random() * Math.PI;
      const cos = Math.cos(rotY), sin = Math.sin(rotY);
      const posArr = g.attributes.position;
      for (let v = 0; v < posArr.count; v++) {
        const vx = posArr.getX(v), vz = posArr.getZ(v);
        posArr.setX(v, vx * cos - vz * sin);
        posArr.setZ(v, vx * sin + vz * cos);
      }
      g.translate(Math.cos(a) * d, 0.03, Math.sin(a) * d);
      veinGeos.push(g);
    }
    const mergedVeins = mergeGeometries(veinGeos);
    this.scene.add(new THREE.Mesh(mergedVeins, this._veinMat));
    for (const g of veinGeos) g.dispose();
  }

  // ── Skybox ───────────────────────────────────────────────────────────
  _buildSkybox() {
    // Sky dome — warmer, not pitch black
    this.scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(400, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0x2a1208, side: THREE.BackSide })
    ));

    // Ash clouds — merged into single draw call
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0x3a2518, transparent: true, opacity: 0.4 });
    const cloudGeos = [];
    for (let i = 0; i < 22; i++) {
      const r = 150 + Math.random() * 200;
      const a = Math.random() * Math.PI * 2;
      const y = 80 + Math.random() * 120;
      const size = 15 + Math.random() * 25;
      const g = new THREE.SphereGeometry(size, 8, 6);
      g.scale(1, 0.3, 1);
      g.translate(Math.cos(a) * r, y, Math.sin(a) * r);
      cloudGeos.push(g);
    }
    const mergedCloudGeo = mergeGeometries(cloudGeos);
    this.scene.add(new THREE.Mesh(mergedCloudGeo, cloudMat));
    for (const g of cloudGeos) g.dispose();

    // Ember particles — GPU-animated (zero CPU cost per frame)
    const emberCount = 300;
    const positions = new Float32Array(emberCount * 3);
    const seeds = new Float32Array(emberCount);
    for (let i = 0; i < emberCount; i++) {
      const r = 30 + Math.random() * 120;
      const theta = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.random() * 120 + 10;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      seeds[i] = Math.random();
    }
    const emberGeo = new THREE.BufferGeometry();
    emberGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    emberGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const emberColor = new THREE.Color(THEME.ember);
    this._emberTimerUniform = { value: 0 };
    this._emberParticles = new THREE.Points(emberGeo, new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._emberTimerUniform,
        color: { value: emberColor },
      },
      vertexShader: `
        attribute float seed;
        uniform float uTime;
        varying float vOpacity;
        void main() {
          vec3 pos = position;
          // Drift upward, wrap at 140 back to 10
          float rise = uTime * (0.1 + seed * 0.1);
          pos.y = mod(pos.y - 10.0 + rise, 130.0) + 10.0;
          // Gentle horizontal sway
          pos.x += sin(uTime * 0.3 + seed * 6.28) * 2.0;
          pos.z += cos(uTime * 0.25 + seed * 4.0) * 2.0;
          // Fade near top/bottom of range
          float t = (pos.y - 10.0) / 130.0;
          vOpacity = 0.7 * smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.85, t);
          vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = 0.6 * (250.0 / -mvPos.z);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float vOpacity;
        void main() {
          if (vOpacity < 0.01) discard;
          gl_FragColor = vec4(color, vOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
    }));
    this.scene.add(this._emberParticles);

    // Distant mountains — merged into single draw call per material
    const mountainMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 1.0 });
    const mountainGeos = [];
    const tipMat = new THREE.MeshStandardMaterial({
      color: THEME.lavaColor, emissive: THEME.lavaEmissive, emissiveIntensity: 1.5,
    });
    const tipGeos = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 200 + Math.random() * 80;
      const h = 20 + Math.random() * 30;
      const base = 30 + Math.random() * 20;
      const g = new THREE.ConeGeometry(base, h, 5 + Math.floor(Math.random() * 2));
      g.translate(Math.cos(a) * dist, -10, Math.sin(a) * dist);
      mountainGeos.push(g);

      if (Math.random() > 0.5) {
        const tg = new THREE.SphereGeometry(1.5, 6, 4);
        tg.translate(Math.cos(a) * dist, -10 + h - 2, Math.sin(a) * dist);
        tipGeos.push(tg);
      }
    }
    const mergedMountainGeo = mergeGeometries(mountainGeos);
    this.scene.add(new THREE.Mesh(mergedMountainGeo, mountainMat));
    for (const g of mountainGeos) g.dispose();
    if (tipGeos.length > 0) {
      const mergedTipGeo = mergeGeometries(tipGeos);
      this.scene.add(new THREE.Mesh(mergedTipGeo, tipMat));
      for (const g of tipGeos) g.dispose();
    }
  }

  // ── Lighting ─────────────────────────────────────────────────────────
  _buildLighting() {
    // Ambient — warm base fill so nothing is pure black
    this.scene.add(new THREE.AmbientLight(0x664433, 0.8));

    // Main directional — strong warm key light from above-right
    const dirLight = new THREE.DirectionalLight(0xffdcb0, 1.4);
    dirLight.position.set(20, 40, 15);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 80;
    dirLight.shadow.camera.left = -45;
    dirLight.shadow.camera.right = 45;
    dirLight.shadow.camera.top = 45;
    dirLight.shadow.camera.bottom = -45;
    // Bias to prevent shadow acne and peter-panning
    dirLight.shadow.bias = -0.001;
    dirLight.shadow.normalBias = 0.05;
    this.scene.add(dirLight);
    this._dirLight = dirLight;

    // Cool fill from opposite side — provides contrast and rim definition
    const fillLight = new THREE.DirectionalLight(0x8899bb, 0.5);
    fillLight.position.set(-20, 25, -15);
    this.scene.add(fillLight);

    // Hemisphere — warm sky / reddish ground bounce (volcano floor reflection)
    this.scene.add(new THREE.HemisphereLight(0x886644, 0x331100, 0.6));

    // Lava uplighting — warm glow from below to simulate volcanic radiance
    const upLight = new THREE.DirectionalLight(0xff6633, 0.3);
    upLight.position.set(0, -5, 0);
    this.scene.add(upLight);
  }

  // ── Decorative Pillars ───────────────────────────────────────────────
  _buildDecorations() {
    const radius = ARENA.diameter / 2;
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1a0e05, roughness: 0.85 });

    // Merge all decorative pillars into single draw call
    const pillarGeos = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const dist = radius + 3 + Math.random() * 5;
      const h = 5 + Math.random() * 8;
      const g = new THREE.ConeGeometry(1.5 + Math.random(), h, 5);
      g.translate(Math.cos(a) * dist, h / 2 - 2, Math.sin(a) * dist);
      pillarGeos.push(g);
    }
    const mergedPillarGeo = mergeGeometries(pillarGeos);
    this.scene.add(new THREE.Mesh(mergedPillarGeo, pillarMat));
    for (const g of pillarGeos) g.dispose();
  }

  // ── Animate ──────────────────────────────────────────────────────────
  update(elapsed) {
    const dt = Math.min(elapsed - this._lastElapsed, 1 / 30); // cap to avoid spiral
    this._lastElapsed = elapsed;

    // Lava shader time uniform — drives all lava animation in GPU
    if (this._lavaMaterial && this._lavaMaterial.uniforms) {
      this._lavaMaterial.uniforms.uTime.value = elapsed;
    }

    // Barrier rise-up animation (respawn)
    this._updateBarrierRise(dt);

    // Decorative pulse animations (throttled to every other frame — imperceptible)
    if (++this._decorFrameSkip >= 2) {
      this._decorFrameSkip = 0;

      // (Boost pads removed)

      // Magma veins — subtle glow pulse (single shared material)
      if (this._veinMat) {
        this._veinMat.emissiveIntensity = 0.5 + Math.sin(elapsed * 1.2) * 0.3;
      }

      // Underlava subtle pulse
      if (this._underlavaMat) {
        this._underlavaMat.emissiveIntensity = 0.4 + Math.sin(elapsed * 0.5) * 0.2;
      }
    }

    // Lava bubbles (speed multiplied during eruption warning)
    const bubbleAccel = this._eruptionWarningActive
      ? (1 + (ARENA.eruption.fx.warning.bubbleSpeedMult - 1) *
          Math.min(this._eruptionWarningTimer / ARENA.eruption.warningTime, 1))
      : 1;
    for (const b of this._lavaBubbles) {
      b.mesh.position.y += b.speed * bubbleAccel * dt;
      if (b.mesh.position.y > 0.4) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * b.poolRadius * 0.7;
        b.mesh.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
        b.mesh.scale.setScalar(0.5 + Math.random() * 0.5);
      }
    }

    // Ember particles — GPU-animated, just update time uniform
    if (this._emberTimerUniform) {
      this._emberTimerUniform.value = elapsed;
    }

    // Lava fire animation (frame-based, synced to game FPS)
    if (this._lavaFireMesh && this._lavaFireFrames.length > 0) {
      this._lavaFireFrameTimer += dt;
      const frameDuration = 1 / 60; // match game FPS
      if (this._lavaFireFrameTimer >= frameDuration) {
        this._lavaFireFrameTimer -= frameDuration;
        this._lavaFireFrameIndex = (this._lavaFireFrameIndex + 1) % this._lavaFireFrames.length;
        this._lavaFireMesh.material.map = this._lavaFireFrames[this._lavaFireFrameIndex];
      }
    }

    // Geyser visual animations
    this._updateGeyserVisuals(elapsed, dt);

    // Geyser particle FX
    this.geyserFX.update(dt);

    // Eruption FX (surge particles, debris, flash, warning pulse)
    this._updateEruptionFX(elapsed, dt);
  }

  // ── Geyser visual animation (called every frame from update) ──────
  _updateGeyserVisuals(elapsed, dt) {
    const FX = ARENA.geysers.fx;

    for (const slot of this._geyserSlots) {
      // ── PERF: skip completely idle geysers with no active animations ──
      if (slot.state === 'idle' && slot.columnScaleY <= 0 && slot.crackScale <= 0
          && !slot.scorchFading && slot.scorchMat.opacity <= 0) {
        continue;
      }

      // ── Column animation (smooth rise/fall) ──
      if (slot.columnVisible && slot.state === 'active') {
        slot.columnScaleY = Math.min(1, slot.columnScaleY + FX.column.riseSpeed * dt);
      } else if (slot.columnScaleY > 0) {
        slot.columnScaleY = Math.max(0, slot.columnScaleY - FX.column.shrinkSpeed * dt);
      }

      if (slot.columnScaleY > 0.01) {
        const wobbleX = Math.sin(elapsed * FX.column.wobbleSpeed) * FX.column.wobbleAmount;
        const wobbleZ = Math.cos(elapsed * FX.column.wobbleSpeed * 1.3 + 1) * FX.column.wobbleAmount;
        for (let l = 0; l < slot.columns.length; l++) {
          const col = slot.columns[l];
          col.mesh.visible = true;
          col.mesh.position.set(
            slot.x + wobbleX * (l + 1) * 0.5,
            FX.column.height * 0.5 * slot.columnScaleY,
            slot.z + wobbleZ * (l + 1) * 0.5,
          );
          const layerWobble = 0.8 + Math.sin(elapsed * (5 + l * 2)) * 0.2;
          col.mesh.scale.set(1, slot.columnScaleY * layerWobble, 1);
        }
      } else {
        for (const col of slot.columns) col.mesh.visible = false;
      }

      // ── Crack animation (single merged mesh) ──
      if (slot.state === 'warning') {
        slot.crackScale = Math.min(1, slot.crackScale + FX.cracks.growSpeed * dt);
      } else if (slot.state !== 'active') {
        slot.crackScale = Math.max(0, slot.crackScale - FX.cracks.growSpeed * 2 * dt);
      }

      if (slot.crackScale > 0.01) {
        slot.crackMesh.visible = true;
        slot.crackMesh.position.set(slot.x, 0.03, slot.z);
        slot.crackMesh.scale.setScalar(slot.crackScale);
        const pulse = 0.5 + Math.sin(elapsed * 8) * 0.5;
        slot.crackMat.emissiveIntensity = slot.crackScale * pulse * 2;
      } else {
        slot.crackMesh.visible = false;
      }

      // ── Warning ring ──
      if (slot.state === 'warning') {
        slot.warningRing.position.set(slot.x, 0.06, slot.z);
        const pulse = 1 + Math.sin(elapsed * FX.warningRing.pulseSpeed) * FX.warningRing.pulseAmount;
        slot.warningRing.scale.set(pulse, 1, pulse);
        slot.warningRingMat.opacity = 0.4 + Math.sin(elapsed * 8) * 0.2;
      } else if (slot.state === 'active') {
        slot.warningRingMat.opacity = Math.max(0, slot.warningRingMat.opacity - 2 * dt);
      } else if (slot.warningRingMat.opacity > 0) {
        slot.warningRingMat.opacity = 0;
        slot.warningRing.position.y = -10;
      }

      // ── Light priority (used by shared light pool below) ──
      if (slot.state === 'active') {
        slot.lightPriority = 3;
      } else if (slot.state === 'warning') {
        slot.lightPriority = 1;
      } else if (slot.state === 'cooldown' && slot.columnScaleY > 0) {
        slot.lightPriority = 0.5;
      } else {
        slot.lightPriority = 0;
      }

      // ── Scorch mark ──
      if (slot.scorchMat.opacity > 0 || slot.scorchFading) {
        slot.scorchTimer += dt;
        const emFade = Math.max(0, 1 - slot.scorchTimer * FX.scorch.emissiveFadeSpeed);
        slot.scorchMat.emissiveIntensity = FX.scorch.emissiveIntensity * emFade;
        if (slot.scorchTimer > FX.scorch.fadeDelay) {
          const fadeT = (slot.scorchTimer - FX.scorch.fadeDelay) / FX.scorch.fadeDuration;
          slot.scorchMat.opacity = Math.max(0, 1 - fadeT);
          if (slot.scorchMat.opacity <= 0) {
            slot.scorchFading = false;
            slot.scorch.position.y = -10;
          }
        }
      }
    }

    // ── Shared light pool: assign 2 lights to highest-priority geysers ──
    this._updateGeyserLightPool(elapsed, dt);
  }

  // ── Light pool: 2 shared lights assigned to most important geysers ──
  _updateGeyserLightPool(elapsed, dt) {
    const FX = ARENA.geysers.fx;
    const pool = this._geyserLightPool;

    // Find top N slots by priority (reuse module-level array, no allocations)
    _rankedSlots.length = 0;
    for (let i = 0; i < this._geyserSlots.length; i++) {
      const slot = this._geyserSlots[i];
      if (slot.lightPriority > 0) {
        _rankedSlots.push(i);
      }
    }
    // Simple inline sort by priority descending (max 6 active slots)
    for (let i = 1; i < _rankedSlots.length; i++) {
      const key = _rankedSlots[i];
      const keyPri = this._geyserSlots[key].lightPriority;
      let j = i - 1;
      while (j >= 0 && this._geyserSlots[_rankedSlots[j]].lightPriority < keyPri) {
        _rankedSlots[j + 1] = _rankedSlots[j];
        j--;
      }
      _rankedSlots[j + 1] = key;
    }

    for (let l = 0; l < pool.length; l++) {
      const poolEntry = pool[l];
      const targetIdx = _rankedSlots[l]; // may be undefined if fewer active geysers than lights

      if (targetIdx !== undefined) {
        const s = this._geyserSlots[targetIdx];
        poolEntry.slotIndex = targetIdx;
        poolEntry.light.position.set(s.x, FX.light.height, s.z);

        if (s.state === 'active') {
          poolEntry.light.color.setHex(FX.light.activeColor);
          const flicker = 1 + Math.sin(elapsed * FX.light.flickerSpeed) * FX.light.flickerAmount;
          poolEntry.intensity = FX.light.activeIntensity * flicker;
        } else if (s.state === 'warning') {
          poolEntry.light.color.setHex(FX.light.warningColor);
          poolEntry.intensity = Math.min(FX.light.warningIntensity,
            poolEntry.intensity + FX.light.warningIntensity * dt * 2);
        } else {
          // Cooldown — fade
          poolEntry.intensity = Math.max(0,
            poolEntry.intensity - (FX.light.activeIntensity / FX.light.fadeOutTime) * dt);
        }
      } else {
        // No geyser needs this light — fade out
        poolEntry.intensity = Math.max(0, poolEntry.intensity - 5 * dt);
        if (poolEntry.intensity < 0.01) {
          poolEntry.light.position.y = -10;
          poolEntry.slotIndex = -1;
        }
      }

      poolEntry.light.intensity = poolEntry.intensity;
    }
  }

  // ── Geyser state transitions (called by DynamicHazards) ───────────

  geyserStartWarning(slotIndex, x, z) {
    const slot = this._geyserSlots[slotIndex];
    if (!slot) return;
    slot.x = x;
    slot.z = z;
    slot.state = 'warning';
    slot.crackScale = 0;
    slot.columnScaleY = 0;

    slot.marker.position.set(x, 0.03, z);
    slot.markerMat.emissive.setHex(THEME.geyserWarning);
    slot.markerMat.emissiveIntensity = 1.0;

    this.geyserFX.startWarning(slot.fxIndex, x, z);
  }

  geyserStartEruption(slotIndex, x, z) {
    const slot = this._geyserSlots[slotIndex];
    if (!slot) return;
    slot.x = x;
    slot.z = z;
    slot.state = 'active';
    slot.columnVisible = true;
    slot.columnScaleY = 0;

    slot.markerMat.emissive.setHex(THEME.geyserActive);
    slot.markerMat.emissiveIntensity = 2.5;

    const fx = ARENA.geysers.fx;
    slot.scorch.position.set(x, 0.02, z);
    slot.scorchMat.opacity = 1.0;
    slot.scorchMat.emissiveIntensity = fx.scorch.emissiveIntensity;
    slot.scorchTimer = 0;
    slot.scorchFading = false;

    this.geyserFX.startEruption(slot.fxIndex, x, z);
  }

  geyserStartCooldown(slotIndex) {
    const slot = this._geyserSlots[slotIndex];
    if (!slot) return;
    slot.state = 'cooldown';
    slot.columnVisible = false;

    slot.scorchTimer = 0;
    slot.scorchFading = true;
    slot.marker.position.y = -10;

    this.geyserFX.startCooldown(slot.fxIndex);
  }

  geyserSetIdle(slotIndex) {
    const slot = this._geyserSlots[slotIndex];
    if (!slot) return;
    slot.state = 'idle';
    slot.crackScale = 0;
    slot.columnScaleY = 0;
    slot.columnVisible = false;
    slot.lightPriority = 0;

    slot.marker.position.y = -10;
    slot.crackMesh.visible = false;
    slot.warningRing.position.y = -10;
    for (const col of slot.columns) col.mesh.visible = false;

    this.geyserFX.setIdle(slot.fxIndex);
  }

  // ── Eruption warning start (called by DynamicHazards) ───────────────
  startEruptionWarning() {
    this._eruptionWarningActive = true;
    this._eruptionWarningTimer = 0;
  }

  // ── Eruption blast (called by DynamicHazards) ──────────────────────
  showEruptionBlast(camera) {
    const EFX = ARENA.eruption.fx;

    // ── Shockwave ring ──
    if (this._eruptionRing) {
      this._eruptionRing.visible = true;
      this._eruptionRing.scale.set(1, 1, 1);
      this._eruptionMat.opacity = 0.8;

      const startTime = performance.now();
      const maxScale = ARENA.eruption.radius;
      const duration = EFX.ring.duration;
      const animate = () => {
        const t = (performance.now() - startTime) / (duration * 1000);
        if (t >= 1) {
          this._eruptionRing.visible = false;
          return;
        }
        // Ease-out for more dramatic expansion
        const eased = 1 - (1 - t) * (1 - t);
        const s = eased * maxScale;
        this._eruptionRing.scale.set(s, 1, s);
        this._eruptionMat.opacity = 0.8 * (1 - t);
        requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    }

    // ── Stop warning ──
    this._eruptionWarningActive = false;

    // ── Lava surge particles ──
    const surgePos = this._eruptionSurgePoints.geometry.attributes.position.array;
    const lavaR = ARENA.lava.radius;
    for (let i = 0; i < this._eruptionSurgeData.length; i++) {
      const p = this._eruptionSurgeData[i];
      p.active = true;
      p.life = 0;
      p.maxLife = EFX.surge.lifetime + (Math.random() - 0.5) * 0.8;
      // Spawn within lava pool
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * lavaR * 0.8;
      surgePos[i * 3] = Math.cos(angle) * r;
      surgePos[i * 3 + 1] = 0.1;
      surgePos[i * 3 + 2] = Math.sin(angle) * r;
      // Upward + outward velocity
      const outSpeed = Math.random() * EFX.surge.spreadSpeed;
      p.vx = Math.cos(angle) * outSpeed;
      p.vy = EFX.surge.launchSpeed + Math.random() * EFX.surge.launchSpeedVariance;
      p.vz = Math.sin(angle) * outSpeed;
    }
    this._eruptionSurgePoints.geometry.attributes.position.needsUpdate = true;
    this._eruptionSurgePoints.visible = true;
    this._eruptionSurgeActive = true;

    // ── Debris chunks ──
    for (let i = 0; i < this._eruptionDebrisData.length; i++) {
      const d = this._eruptionDebrisData[i];
      d.active = true;
      d.life = 0;
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * lavaR * 0.5;
      d.x = Math.cos(angle) * r;
      d.y = 0.5;
      d.z = Math.sin(angle) * r;
      const outSpeed = EFX.debris.launchSpeed + Math.random() * EFX.debris.launchSpeedVariance;
      d.vx = Math.cos(angle) * outSpeed;
      d.vy = EFX.debris.launchUpSpeed + Math.random() * EFX.debris.launchUpVariance;
      d.vz = Math.sin(angle) * outSpeed;
      d.rx = Math.random() * 5;
      d.ry = Math.random() * 5;
      d.rz = Math.random() * 5;
      const s = 0.5 + Math.random();
      _dummy.position.set(d.x, d.y, d.z);
      _dummy.scale.setScalar(s);
      _dummy.updateMatrix();
      this._eruptionDebrisMesh.setMatrixAt(i, _dummy.matrix);
    }
    this._eruptionDebrisMesh.instanceMatrix.needsUpdate = true;
    this._eruptionDebrisDirty = false;

    // ── Screen flash ──
    if (camera && this._eruptionFlash) {
      // Attach to camera
      if (this._eruptionFlash.parent !== camera) {
        camera.add(this._eruptionFlash);
      }
      this._eruptionFlash.position.set(0, 0, -0.5);
      this._eruptionFlash.visible = true;
      this._eruptionFlashMat.opacity = EFX.flash.maxOpacity;
      this._eruptionFlashTimer = EFX.flash.duration;
    }
  }

  // ── Eruption animation update (called from main update) ────────────
  _updateEruptionFX(elapsed, dt) {
    const EFX = ARENA.eruption.fx;

    // ── Warning phase: pulsing lava glow (via shader emissive boost uniform) ──
    if (this._eruptionWarningActive) {
      this._eruptionWarningTimer += dt;
      if (this._lavaMaterial && this._lavaMaterial.uniforms) {
        const t = Math.min(this._eruptionWarningTimer / ARENA.eruption.warningTime, 1);
        const pulse = Math.sin(this._eruptionWarningTimer * EFX.warning.pulseSpeed) * EFX.warning.pulseAmount;
        this._lavaMaterial.uniforms.uEmissiveBoost.value = t * 2.0 + pulse * t;
      }
      // Bubble acceleration is handled in the main update loop via bubbleAccel
    }

    // ── Surge particles ──
    if (this._eruptionSurgeActive) {
      const pos = this._eruptionSurgePoints.geometry.attributes.position.array;
      let anyAlive = false;
      for (let i = 0; i < this._eruptionSurgeData.length; i++) {
        const p = this._eruptionSurgeData[i];
        if (!p.active) continue;
        p.life += dt;
        if (p.life > p.maxLife || pos[i * 3 + 1] < -1) {
          p.active = false;
          pos[i * 3 + 1] = -100;
          continue;
        }
        p.vy -= EFX.surge.gravity * dt;
        pos[i * 3] += p.vx * dt;
        pos[i * 3 + 1] += p.vy * dt;
        pos[i * 3 + 2] += p.vz * dt;
        anyAlive = true;
      }
      this._eruptionSurgePoints.geometry.attributes.position.needsUpdate = true;
      if (!anyAlive) {
        this._eruptionSurgeActive = false;
        this._eruptionSurgePoints.visible = false;
      }
    }

    // ── Debris chunks ──
    let debrisDirty = false;
    for (let i = 0; i < this._eruptionDebrisData.length; i++) {
      const d = this._eruptionDebrisData[i];
      if (!d.active) continue;
      d.life += dt;
      if (d.life > EFX.debris.lifetime || d.y < -1) {
        d.active = false;
        _dummy.position.set(0, -100, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        this._eruptionDebrisMesh.setMatrixAt(i, _dummy.matrix);
        debrisDirty = true;
        continue;
      }
      d.vy -= EFX.debris.gravity * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rx += 4 * dt;
      d.rz += 3 * dt;
      _dummy.position.set(d.x, d.y, d.z);
      _dummy.rotation.set(d.rx, d.ry, d.rz);
      _dummy.updateMatrix();
      this._eruptionDebrisMesh.setMatrixAt(i, _dummy.matrix);
      debrisDirty = true;
    }
    if (debrisDirty) {
      this._eruptionDebrisMesh.instanceMatrix.needsUpdate = true;
    }

    // ── Screen flash fade ──
    if (this._eruptionFlashTimer > 0) {
      this._eruptionFlashTimer -= dt;
      const t = Math.max(0, this._eruptionFlashTimer / EFX.flash.duration);
      this._eruptionFlashMat.opacity = EFX.flash.maxOpacity * t * t;
      if (this._eruptionFlashTimer <= 0) {
        this._eruptionFlash.visible = false;
      }
    }
  }
}
