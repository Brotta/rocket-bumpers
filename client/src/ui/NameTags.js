import * as THREE from 'three';

/**
 * NameTags — floating labels above each car, rendered as DOM overlays
 * projected from 3D world positions to 2D screen coordinates.
 */

const TAG_OFFSET_Y = 3.6; // units above the car (above health bar)

export class NameTags {
  constructor() {
    /** @type {Map<import('../physics/CarBody.js').CarBody, HTMLDivElement>} */
    this._tags = new Map();
    this._container = null;
    this._vec = new THREE.Vector3();
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.id = 'name-tags';
    container.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden;
    `;
    document.body.appendChild(container);
    this._container = container;

    const style = document.createElement('style');
    style.textContent = `
      .name-tag {
        position:absolute;
        left:0;top:0;
        font:18px 'Russo One',sans-serif;
        color:#fff5e6;
        text-shadow:0 2px 0 #1a0e08, 0 0 8px rgba(0,0,0,0.8), 0 0 16px rgba(0,0,0,0.4);
        white-space:nowrap;
        pointer-events:none;
        opacity:0.9;
        will-change:transform;
        letter-spacing:0.04em;
      }
      .name-tag.is-local {
        color:#ffcc00;
        text-shadow:0 2px 0 #1a0e08, 0 0 8px rgba(255,170,0,0.4), 0 0 16px rgba(0,0,0,0.4);
      }
    `;
    container.appendChild(style);
  }

  /**
   * Register a car for name tag display.
   * @param {import('../physics/CarBody.js').CarBody} carBody
   * @param {boolean} isLocal
   */
  add(carBody, isLocal = false) {
    if (this._tags.has(carBody)) return;

    const tag = document.createElement('div');
    tag.className = 'name-tag' + (isLocal ? ' is-local' : '');
    tag.textContent = carBody.nickname;
    this._container.appendChild(tag);
    // Cache dimensions once (text doesn't change) — avoids layout reflow every frame
    tag._cachedW = 0;
    tag._cachedH = 0;
    requestAnimationFrame(() => {
      tag._cachedW = tag.offsetWidth;
      tag._cachedH = tag.offsetHeight;
    });
    this._tags.set(carBody, tag);
  }

  /** Remove a car's name tag. */
  remove(carBody) {
    const tag = this._tags.get(carBody);
    if (tag) {
      tag.remove();
      this._tags.delete(carBody);
    }
  }

  /** Remove all name tags. */
  clear() {
    for (const tag of this._tags.values()) {
      tag.remove();
    }
    this._tags.clear();
  }

  /**
   * Update all tag positions. Call once per frame after camera update.
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} screenW
   * @param {number} screenH
   */
  update(camera, screenW, screenH) {
    for (const [carBody, tag] of this._tags) {
      // Hide if car is invisible or fallen
      if (!carBody.mesh.visible || carBody.body.position.y < -3) {
        if (tag._visible !== false) {
          tag.style.opacity = '0';
          tag._visible = false;
        }
        continue;
      }

      // Project 3D position to screen
      this._vec.set(
        carBody.body.position.x,
        carBody.body.position.y + TAG_OFFSET_Y,
        carBody.body.position.z,
      );
      this._vec.project(camera);

      // Behind camera?
      if (this._vec.z > 1) {
        if (tag._visible !== false) {
          tag.style.opacity = '0';
          tag._visible = false;
        }
        continue;
      }

      const x = (this._vec.x * 0.5 + 0.5) * screenW;
      const y = (-this._vec.y * 0.5 + 0.5) * screenH;

      // Single transform write — GPU-composited, no layout thrashing
      if (tag._visible !== true) {
        tag.style.opacity = '0.9';
        tag._visible = true;
      }
      tag.style.transform = `translate3d(${x - tag._cachedW * 0.5}px,${y - tag._cachedH}px,0)`;
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
