import * as THREE from 'three';
import { IMPACT_TEXT } from '../core/Config.js';

/**
 * ImpactText — comic-style impact words ("POW", "BOOM", etc.) rendered as
 * DOM overlays projected from 3D collision points to 2D screen space.
 *
 * Uses a pre-allocated DOM pool with a visibility cap to avoid clutter.
 * Animation is JS-driven (not CSS keyframes) because the 3D position must
 * be re-projected every frame as the camera moves.
 */
export class ImpactText {
  constructor() {
    this._pool = [];
    this._vec = new THREE.Vector3();
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.id = 'impact-texts';
    container.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:7;overflow:hidden;
    `;
    document.body.appendChild(container);
    this._container = container;

    // Inject base styles
    const style = document.createElement('style');
    style.textContent = `
      .impact-word {
        position:absolute;
        left:0;top:0;
        font-family:'Luckiest Guy',cursive;
        font-weight:400;
        pointer-events:none;
        will-change:transform,opacity;
        white-space:nowrap;
        opacity:0;
        letter-spacing:2px;
      }
    `;
    container.appendChild(style);

    // Pre-allocate pool
    for (let i = 0; i < IMPACT_TEXT.poolSize; i++) {
      const el = document.createElement('span');
      el.className = 'impact-word';
      container.appendChild(el);
      this._pool.push({
        el,
        active: false,
        timer: 0,
        duration: 0,
        x: 0, y: 0, z: 0,
        rotation: 0,
        tier: 'light',
      });
    }
  }

  /**
   * Show an impact word at a 3D world position.
   * @param {object} opts
   * @param {string} opts.word — text to display
   * @param {string} opts.tier — 'light' | 'heavy' | 'devastating'
   * @param {number} opts.x, opts.y, opts.z — world position
   */
  show({ word, tier, x, y, z }) {
    // Find inactive slot
    let slot = this._pool.find(s => !s.active);

    // If all active, evict the one closest to finishing
    if (!slot) {
      const activeCount = this._pool.filter(s => s.active).length;
      if (activeCount >= IMPACT_TEXT.maxVisible) {
        let bestIdx = -1;
        let bestProgress = -1;
        for (let i = 0; i < this._pool.length; i++) {
          const s = this._pool[i];
          if (s.active) {
            const progress = s.timer / s.duration;
            if (progress > bestProgress) {
              bestProgress = progress;
              bestIdx = i;
            }
          }
        }
        if (bestIdx >= 0) {
          slot = this._pool[bestIdx];
          slot.el.style.opacity = '0';
          slot.active = false;
        }
      }
      if (!slot) slot = this._pool.find(s => !s.active);
      if (!slot) return; // should not happen
    }

    const cfg = IMPACT_TEXT.tiers[tier] || IMPACT_TEXT.tiers.light;
    const anim = IMPACT_TEXT.animation;

    // Random font size within range
    const fontSize = cfg.fontSize[0] + Math.random() * (cfg.fontSize[1] - cfg.fontSize[0]);
    const sw = cfg.strokeWidth;

    slot.el.textContent = word;
    slot.el.style.fontSize = `${Math.round(fontSize)}px`;
    slot.el.style.color = cfg.color;
    slot.el.style.textShadow = `
      -${sw}px -${sw}px 0 #1a0e08,
       ${sw}px -${sw}px 0 #1a0e08,
      -${sw}px  ${sw}px 0 #1a0e08,
       ${sw}px  ${sw}px 0 #1a0e08,
       0 0 ${sw * 3}px ${cfg.glowColor}
    `;

    slot.active = true;
    slot.timer = 0;
    slot.duration = cfg.duration;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.tier = tier;
    slot.rotation = (Math.random() - 0.5) * anim.rotationRange;

    // Start invisible — first update() frame will position and reveal
    slot.el.style.opacity = '0';
  }

  /**
   * Per-frame update: project positions, animate scale/opacity/drift.
   */
  update(camera, screenW, screenH, dt) {
    const anim = IMPACT_TEXT.animation;

    for (const slot of this._pool) {
      if (!slot.active) continue;

      slot.timer += dt;
      const t = Math.min(1, slot.timer / slot.duration);

      // ── Animation phases ──
      let scale, opacity, yDrift;

      if (t < 0.15) {
        // Pop in (elastic ease-out)
        const t2 = t / 0.15;
        scale = anim.popScale * (1 - Math.pow(2, -10 * t2) * Math.cos(t2 * Math.PI * 2));
        opacity = t2;
        yDrift = 0;
      } else if (t < 0.30) {
        // Bounce settle
        const t2 = (t - 0.15) / 0.15;
        scale = anim.popScale + (1.0 - anim.popScale) * t2;
        opacity = 1;
        yDrift = -5 * t2;
      } else if (t < 0.65) {
        // Hold + drift
        const t2 = (t - 0.30) / 0.35;
        scale = 1.0;
        opacity = 1;
        yDrift = -5 + (-15 - (-5)) * t2;
      } else {
        // Fade out
        const t2 = (t - 0.65) / 0.35;
        scale = 1.0 + (0.7 - 1.0) * t2;
        opacity = 1 - t2;
        yDrift = -15 + (-30 - (-15)) * t2;
      }

      // ── 3D → 2D projection ──
      this._vec.set(slot.x, slot.y, slot.z);
      this._vec.project(camera);

      // Behind camera check
      if (this._vec.z > 1) {
        slot.el.style.opacity = '0';
        if (t >= 1) { slot.active = false; }
        continue;
      }

      const sx = (this._vec.x * 0.5 + 0.5) * screenW;
      const sy = (-this._vec.y * 0.5 + 0.5) * screenH;

      slot.el.style.transform =
        `translate3d(${sx}px,${sy + yDrift}px,0) translate(-50%,-50%) rotate(${slot.rotation}deg) scale(${scale.toFixed(3)})`;
      slot.el.style.opacity = String(Math.max(0, opacity).toFixed(3));

      // Deactivate when done
      if (t >= 1) {
        slot.active = false;
        slot.el.style.opacity = '0';
      }
    }
  }

  dispose() {
    if (this._container?.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._pool.length = 0;
  }
}
