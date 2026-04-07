import * as THREE from 'three';
import { DAMAGE } from '../core/Config.js';

/**
 * HealthBars — floating HP bars above each car, rendered as DOM overlays
 * projected from 3D world positions to 2D screen coordinates.
 * Same projection approach as NameTags.
 */

const BAR_OFFSET_Y = 3.0; // units above the car (above name tags)
const BAR_WIDTH = 108;     // px (80% larger)
const BAR_HEIGHT = 14;     // px (80% larger)

export class HealthBars {
  constructor() {
    /** @type {Map<import('../physics/CarBody.js').CarBody, {el: HTMLDivElement, fill: HTMLDivElement, lastHp: number}>} */
    this._bars = new Map();
    this._container = null;
    this._vec = new THREE.Vector3();
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.id = 'health-bars';
    container.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden;
    `;
    document.body.appendChild(container);
    this._container = container;

    const style = document.createElement('style');
    style.textContent = `
      .hp-bar {
        position:absolute;
        left:0;top:0;
        width:${BAR_WIDTH}px;
        height:${BAR_HEIGHT}px;
        background:rgba(0,0,0,0.6);
        border:1px solid rgba(255,255,255,0.3);
        border-radius:3px;
        overflow:hidden;
        pointer-events:none;
        will-change:transform;
      }
      .hp-fill {
        height:100%;
        width:100%;
        border-radius:2px;
        transition:width 0.25s ease-out, background-color 0.3s;
        transform-origin:left center;
      }
      .hp-bar.is-local .hp-fill {
        box-shadow:0 0 4px currentColor;
      }
      .hp-bar.hit-flash .hp-fill {
        filter:brightness(2.0);
      }
    `;
    container.appendChild(style);
  }

  /**
   * Register a car for health bar display.
   * @param {import('../physics/CarBody.js').CarBody} carBody
   * @param {boolean} isLocal
   */
  add(carBody, isLocal = false) {
    if (this._bars.has(carBody)) return;

    const el = document.createElement('div');
    el.className = 'hp-bar' + (isLocal ? ' is-local' : '');

    const fill = document.createElement('div');
    fill.className = 'hp-fill';
    fill.style.backgroundColor = '#44ff44';
    fill.style.width = '100%';
    el.appendChild(fill);

    this._container.appendChild(el);
    this._bars.set(carBody, { el, fill, lastHp: carBody.maxHp });
  }

  /** Remove a car's health bar. */
  remove(carBody) {
    const entry = this._bars.get(carBody);
    if (entry) {
      entry.el.remove();
      this._bars.delete(carBody);
    }
  }

  /** Remove all health bars. */
  clear() {
    for (const entry of this._bars.values()) {
      entry.el.remove();
    }
    this._bars.clear();
  }

  /** Flash the bar white on damage. */
  flashDamage(carBody) {
    const entry = this._bars.get(carBody);
    if (!entry) return;
    entry.el.classList.add('hit-flash');
    setTimeout(() => entry.el.classList.remove('hit-flash'), 150);
  }

  /**
   * Update all bar positions and fill. Call once per frame after camera update.
   */
  update(camera, screenW, screenH) {
    for (const [carBody, entry] of this._bars) {
      const { el, fill } = entry;

      // Hide if car is invisible, eliminated, or fallen
      if (!carBody.mesh.visible || carBody.isEliminated || carBody.body.position.y < -3) {
        if (el._visible !== false) {
          el.style.opacity = '0';
          el._visible = false;
        }
        continue;
      }

      // Project 3D position to screen
      this._vec.set(
        carBody.body.position.x,
        carBody.body.position.y + BAR_OFFSET_Y,
        carBody.body.position.z,
      );
      this._vec.project(camera);

      // Behind camera?
      if (this._vec.z > 1) {
        if (el._visible !== false) {
          el.style.opacity = '0';
          el._visible = false;
        }
        continue;
      }

      const x = (this._vec.x * 0.5 + 0.5) * screenW;
      const y = (-this._vec.y * 0.5 + 0.5) * screenH;

      if (el._visible !== true) {
        el.style.opacity = '1';
        el._visible = true;
      }
      el.style.transform = `translate3d(${x - BAR_WIDTH * 0.5}px,${y - BAR_HEIGHT}px,0)`;

      // Update fill width and color only when HP changed
      if (entry.lastHp !== carBody.hp) {
        entry.lastHp = carBody.hp;
        const ratio = Math.max(0, carBody.hp / carBody.maxHp);
        fill.style.width = `${ratio * 100}%`;

        // Color: green → yellow → red
        let color;
        if (ratio > 0.6) {
          color = '#44ff44';
        } else if (ratio > 0.3) {
          color = '#ffcc00';
        } else {
          color = '#ff3333';
        }
        fill.style.backgroundColor = color;

        // Pulsing at low HP
        if (ratio <= 0.3 && ratio > 0) {
          fill.style.animation = 'hp-pulse 0.5s ease-in-out infinite alternate';
        } else {
          fill.style.animation = 'none';
        }
      }
    }
  }

  dispose() {
    this.clear();
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }
}

// Inject pulse keyframes
const pulseStyle = document.createElement('style');
pulseStyle.textContent = `
  @keyframes hp-pulse {
    0% { opacity: 1.0; }
    100% { opacity: 0.5; }
  }
`;
document.head.appendChild(pulseStyle);
