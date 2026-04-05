import * as THREE from 'three';

/**
 * ProceduralTextures — generates Canvas2D-based textures for the volcano arena.
 * All textures use tileable noise (wrapping coordinates) to avoid visible seams.
 */

// ── Tileable value noise ────────────────────────────────────────────
function _hash(x, y) {
  let n = x * 127.1 + y * 311.7;
  n = Math.sin(n) * 43758.5453;
  return n - Math.floor(n);
}

function _smoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const a = _hash(ix, iy);
  const b = _hash(ix + 1, iy);
  const c = _hash(ix, iy + 1);
  const d = _hash(ix + 1, iy + 1);

  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function _fbm(x, y, octaves = 4) {
  let value = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    value += amp * _smoothNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return value;
}

/** Tileable FBM: wraps seamlessly over a period. */
function _fbmTile(x, y, period, octaves = 4) {
  // Sample noise at 4 points on a torus to make it tileable
  const s = x / period;
  const t = y / period;
  const nx1 = period * Math.cos(s * Math.PI * 2);
  const ny1 = period * Math.sin(s * Math.PI * 2);
  const nx2 = period * Math.cos(t * Math.PI * 2);
  const ny2 = period * Math.sin(t * Math.PI * 2);
  return _fbm(nx1 + nx2, ny1 + ny2, octaves);
}

// helper: clamp 0-255
function _c(v) { return Math.max(0, Math.min(255, v)) | 0; }

// ── Voronoi distance helper (tileable) ──────────────────────────────
function _voronoiDist(x, y, period, cellSize) {
  const cx = x / cellSize;
  const cy = y / cellSize;
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  let minDist = 999;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = ix + dx;
      const ny = iy + dy;
      // Tileable hash: wrap cell coords
      const wx = ((nx % period) + period) % period;
      const wy = ((ny % period) + period) % period;
      const px = nx + _hash(wx, wy);
      const py = ny + _hash(wy + 31, wx + 17);
      const ddx = cx - px;
      const ddy = cy - py;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

// ── Rock / volcanic ground texture (1024, multi-scale) ──────────────
export function createRockTexture(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;

  // Precompute Voronoi crack field (tileable)
  const voronoiPeriod = 12;
  const voronoiCellSize = size / voronoiPeriod;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // ── Macro: large-scale rock variation ──
      const n1 = _fbmTile(x, y, size, 5);
      // ── Meso: medium detail / flow patterns ──
      const n2 = _fbmTile(x + 200, y + 200, size, 4);
      // ── Micro: fine grain pitting ──
      const n3 = _fbmTile(x * 2 + 500, y * 2 + 500, size * 2, 2);
      // ── Color variation ──
      const n4 = _fbmTile(x + 800, y + 800, size, 2);

      // ── Voronoi crack pattern (sharp plate boundaries) ──
      const vd = _voronoiDist(x, y, voronoiPeriod, voronoiCellSize);
      const crackLine = vd < 0.08 ? (0.08 - vd) / 0.08 : 0; // 0-1, 1 = center of crack
      const plateShade = Math.min(vd * 3, 1); // plates lighter toward center

      // ── Base color: dark volcanic basalt ──
      const base = 35 + n1 * 45 + plateShade * 12;

      // ── Crack darkening ──
      const crackDark = crackLine * -30;

      // ── Rope lava ridges (pahoehoe): directional threshold ──
      const ridge = Math.abs(n2 - 0.5) < 0.035 ? 12 : 0;

      // ── Warm reddish-brown variation in some areas ──
      const warmth = n4 > 0.5 ? (n4 - 0.5) * 2 : 0;
      const warmR = warmth * 35;
      const warmG = warmth * 10;

      // ── Fine grain adds subtle brightness variation ──
      const grain = (n3 - 0.5) * 15;

      d[i]     = _c(base + crackDark + ridge + warmR + grain + 8);  // R
      d[i + 1] = _c(base + crackDark + ridge + warmG + grain - 3);  // G
      d[i + 2] = _c(base * 0.45 + crackDark + grain);               // B
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  return tex;
}

// ── Rock normal map (1024, multi-scale + Voronoi cracks) ────────────
export function createRockNormalMap(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  // Voronoi params (must match rock texture for crack alignment)
  const voronoiPeriod = 12;
  const voronoiCellSize = size / voronoiPeriod;

  // Multi-scale height map
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // ── Macro: broad terrain mounds (visible from camera height) ──
      const macro = _fbmTile(x, y, size, 4) * 0.5;

      // ── Meso: rope-lava ridges (directional, sharp) ──
      const meso = _fbmTile(x + 300, y + 300, size, 3);
      const ridge = Math.abs(meso - 0.5) < 0.04 ? -0.2 : 0;

      // ── Micro: vesicular pitting (fine grain, low amplitude) ──
      const micro = _fbmTile(x * 2 + 700, y * 2 + 700, size * 2, 2) * 0.12;

      // ── Voronoi crack network (sharp plate boundaries) ──
      const vd = _voronoiDist(x, y, voronoiPeriod, voronoiCellSize);
      const crackDepth = vd < 0.07 ? -(0.07 - vd) / 0.07 * 0.35 : 0;

      heights[y * size + x] = macro + ridge + micro + crackDepth;
    }
  }

  // Compute normals from height field (Sobel-style finite differences)
  const strength = 5.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const xp = (x + 1) % size;
      const xm = (x - 1 + size) % size;
      const yp = (y + 1) % size;
      const ym = (y - 1 + size) % size;

      const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);

      data[i]     = _c((-dx / len * 0.5 + 0.5) * 255);
      data[i + 1] = _c((-dy / len * 0.5 + 0.5) * 255);
      data[i + 2] = _c((1 / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  return tex;
}

// ── Lava texture (NO repeat — single large fill, animated via offset) ─
export function createLavaTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Use tileable noise so offset animation wraps smoothly
      const n1 = _fbmTile(x, y, size, 5);
      const n2 = _fbmTile(x + 300, y + 300, size, 3);
      const heat = n1 * 0.6 + n2 * 0.4;

      // Smooth gradient: hot yellow → orange → dark red
      // More gradual transitions, less patchy
      let r, g, b;
      if (heat > 0.55) {
        // Hot: bright yellow-orange
        const t = (heat - 0.55) / 0.45; // 0..1
        r = 255;
        g = 80 + t * 150;  // 80..230
        b = t * 30;
      } else if (heat > 0.3) {
        // Warm: orange to dark orange
        const t = (heat - 0.3) / 0.25; // 0..1
        r = 160 + t * 95;  // 160..255
        g = 20 + t * 60;   // 20..80
        b = 0;
      } else {
        // Cool: dark red-brown crust
        const t = heat / 0.3; // 0..1
        r = 60 + t * 100;  // 60..160
        g = 5 + t * 15;
        b = 0;
      }

      d[i]     = _c(r);
      d[i + 1] = _c(g);
      d[i + 2] = _c(b);
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // NO repeat — single texture covers entire lava pool
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

// ── Lava emissive map ───────────────────────────────────────────────
export function createLavaEmissiveMap(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const n = _fbmTile(x, y, size, 5);
      // Smooth glow ramp (not just hot spots)
      const glow = Math.max(0, (n - 0.3) / 0.7); // 0..1
      const g2 = glow * glow; // concentrate brightness on hottest areas

      d[i]     = _c(g2 * 255);
      d[i + 1] = _c(g2 * 80);
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

// ── Geyser scorch mark texture ──────────────────────────────────────
// Radial burn mark with charred cracks, ember-glowing edges, and
// organic noise for a realistic-but-toon scorched earth look.
export function createScorchTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Distance from center (0 = center, 1 = edge)
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Radial falloff — soft edge
      const radial = 1 - Math.min(dist, 1);
      const alpha = radial * radial * radial; // cubic falloff for soft edges

      if (alpha < 0.01) {
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = 0;
        continue;
      }

      // Noise layers for organic variation
      const n1 = _fbm(x * 0.04, y * 0.04, 4);    // large char pattern
      const n2 = _fbm(x * 0.12, y * 0.12, 3);    // fine cracks
      const n3 = _fbm(x * 0.08 + 100, y * 0.08 + 100, 2); // color variation

      // Crack pattern: dark lines where noise gradient is steep
      const crackIntensity = n2 > 0.58 ? (n2 - 0.58) * 5 : 0;

      // Base charred color: very dark brown with warm undertone
      const charBase = 15 + n1 * 25;
      const warmth = n3 * 0.4; // how much ember glow bleeds in

      // Ember glow at edges of cracks and near center
      const emberRing = (dist > 0.3 && dist < 0.7) ? Math.sin((dist - 0.3) * Math.PI / 0.4) : 0;
      const ember = Math.max(0, crackIntensity * 0.6 + emberRing * 0.3) * n1;

      // Colors
      const r = _c(charBase + warmth * 30 + ember * 180 + crackIntensity * -10);
      const g = _c(charBase * 0.6 + warmth * 8 + ember * 60 + crackIntensity * -8);
      const b = _c(charBase * 0.3 + ember * 5);

      d[i]     = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = _c(alpha * 255);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // No repeat — single decal per scorch mark
  return tex;
}

// ── Geyser scorch emissive map ──────────────────────────────────────
// Glowing ember veins within the scorch mark — subtle residual heat.
export function createScorchEmissiveMap(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radial = 1 - Math.min(dist, 1);

      if (radial < 0.05) {
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = 255;
        continue;
      }

      // Crack/vein noise — only veins glow
      const n = _fbm(x * 0.12, y * 0.12, 3);
      const vein = n > 0.55 ? (n - 0.55) * 6 : 0;
      const glow = vein * radial * radial;

      d[i]     = _c(glow * 255); // R: hot
      d[i + 1] = _c(glow * 80);  // G: warm
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

// ── Magma underlay texture ──────────────────────────────────────────
export function createMagmaUnderlayTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const n = _fbmTile(x, y, size, 3);
      // Dark with thin bright veins
      const vein = n > 0.55 ? (n - 0.55) * 4 : 0;

      d[i]     = _c(20 + vein * 160);
      d[i + 1] = _c(3 + vein * 30);
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
