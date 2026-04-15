import * as THREE from 'three';
import { CARS, CAR_ORDER, STAT_MAP } from '../core/Config.js';
import { getCarPreviewScene } from '../rendering/CarFactory.js';

const MAX_STAT = 8;

/**
 * Car selection carousel — volcanic-themed fullscreen overlay with 3D
 * rotating preview on a rock pedestal, stat bars, ability info, and
 * left/right navigation.
 */
export class CarSelect {
  /**
   * @param {string} nickname
   * @param {Function} onSelect — (carType) => void
   * @param {object} [options]
   * @param {boolean} [options.respawnMode=false] — if true, renders as overlay (semi-transparent bg, game continues behind)
   */
  constructor(nickname, onSelect, options = {}) {
    this._nickname = nickname;
    this._onSelect = onSelect;
    this._respawnMode = options.respawnMode || false;
    this._index = 0;
    this._renderer = null;
    this._preview = null;
    this._clock = new THREE.Clock();
    this._animFrame = 0;
    this._el = null;
    this._transitioning = false;

    // Touch/swipe state
    this._touchStartX = 0;
    this._touchStartY = 0;

    this._build();
    this._setCarByIndex(0);
    this._startRenderLoop();
  }

  // ── DOM ──────────────────────────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.id = 'car-select';
    el.innerHTML = `
      <div class="cs-grid-bg"></div>

      <div class="cs-header">
        <div class="cs-player">${this._nickname}</div>
        <div class="cs-title">${this._respawnMode ? 'RESPAWN — CHOOSE YOUR RIDE' : 'CHOOSE YOUR RIDE'}</div>
        <div class="cs-car-name" id="cs-car-name"></div>
      </div>

      <canvas id="cs-canvas"></canvas>

      <div class="cs-nav">
        <button class="cs-arrow cs-left" id="cs-left">&#9664;</button>
        <div class="cs-counter" id="cs-counter"></div>
        <button class="cs-arrow cs-right" id="cs-right">&#9654;</button>
      </div>

      <div class="cs-stats" id="cs-stats"></div>

      <div class="cs-ability" id="cs-ability"></div>

      <button class="cs-select" id="cs-select">SELECT</button>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #car-select{
        position:fixed;inset:0;z-index:1000;
        display:flex;flex-direction:column;align-items:center;
        justify-content:space-between;
        background:${this._respawnMode
          ? 'rgba(5, 5, 16, 0.85)'
          : 'radial-gradient(ellipse at center 60%, #1a0e08 0%, #0d0604 50%, #050202 100%)'};
        font-family:'Russo One',sans-serif;
        padding:clamp(12px,3vw,24px);
        overflow:hidden;
        user-select:none;-webkit-user-select:none;
        ${this._respawnMode ? 'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);' : ''}
      }

      /* Animated orange grid background */
      .cs-grid-bg{
        position:absolute;inset:0;
        background-image:
          linear-gradient(rgba(255,68,0,0.08) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,68,0,0.08) 1px, transparent 1px);
        background-size:48px 48px;
        mask-image:radial-gradient(ellipse at center 50%, rgba(0,0,0,0.6) 0%, transparent 70%);
        -webkit-mask-image:radial-gradient(ellipse at center 50%, rgba(0,0,0,0.6) 0%, transparent 70%);
        animation:cs-grid-scroll 8s linear infinite;
        pointer-events:none;
      }
      @keyframes cs-grid-scroll{
        0%{background-position:0 0}
        100%{background-position:0 48px}
      }

      /* Header */
      .cs-header{text-align:center;width:100%;flex-shrink:0;position:relative;z-index:1}
      .cs-player{
        color:#c9a87c;font-size:0.8rem;letter-spacing:0.25em;
        margin-bottom:0.15rem;
      }
      .cs-title{
        color:#ff8c00;font-size:clamp(0.65rem,2vw,0.8rem);
        font-family:'Luckiest Guy',cursive;
        letter-spacing:0.25em;
        text-shadow:0 2px 0 #1a0e08, 0 0 10px rgba(255,68,0,0.4);
        margin-bottom:0.3rem;
      }
      .cs-car-name{
        font-family:'Luckiest Guy',cursive;
        font-size:clamp(1.4rem,5vw,2.4rem);
        color:#fff5e6;letter-spacing:0.08em;
        text-shadow:0 3px 0 #1a0e08, 0 0 14px var(--car-glow,#ff6b20), 0 0 40px var(--car-glow,#ff440044);
        transition:opacity .25s;
      }

      /* 3D canvas */
      #cs-canvas{
        flex:1 1 auto;width:100%;max-height:45vh;
        border-radius:8px;
        position:relative;z-index:1;
      }

      /* Nav arrows + counter */
      .cs-nav{
        display:flex;align-items:center;gap:1.5rem;
        flex-shrink:0;margin:0.5rem 0;
        position:relative;z-index:1;
      }
      .cs-arrow{
        background:transparent;border:2px solid #ff6b20;
        color:#ff6b20;font-size:1.6rem;width:48px;height:48px;
        border-radius:50%;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:all .15s;line-height:1;
      }
      .cs-arrow:hover{
        background:rgba(255,68,0,0.1);
        box-shadow:0 0 14px #ff6b20, 0 0 30px #ff440033;
      }
      .cs-arrow:active{transform:scale(0.9)}
      .cs-counter{
        color:#c9a87c;font-size:0.85rem;letter-spacing:0.15em;
        min-width:4em;text-align:center;
        font-family:'Luckiest Guy',cursive;
      }

      /* Stat bars */
      .cs-stats{
        width:min(360px,90vw);flex-shrink:0;
        position:relative;z-index:1;
      }
      .cs-stat-row{
        display:flex;align-items:center;margin:6px 0;
      }
      .cs-stat-label{
        width:80px;color:#c9a87c;font-size:0.7rem;
        letter-spacing:0.1em;text-align:right;padding-right:10px;
        font-family:'Russo One',sans-serif;
      }
      .cs-stat-track{
        flex:1;height:14px;background:#1a0e08;
        border:2px solid rgba(255,102,0,0.2);
        border-radius:7px;overflow:hidden;position:relative;
        box-shadow:inset 0 2px 4px rgba(0,0,0,0.4);
      }
      .cs-stat-fill{
        height:100%;border-radius:5px;
        transition:width .4s cubic-bezier(.25,.8,.25,1);
        box-shadow:0 0 8px var(--bar-color);
        background-image:linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 50%);
        background-blend-mode:overlay;
      }
      .cs-stat-val{
        width:36px;text-align:center;color:#fff5e6;font-size:0.8rem;
        padding-left:8px;
        font-family:'Luckiest Guy',cursive;
      }

      /* Ability */
      .cs-ability{
        text-align:center;flex-shrink:0;
        margin:0.4rem 0;
        transition:opacity .25s;
        position:relative;z-index:1;
      }
      .cs-ability-name{
        color:#ff8c00;font-size:0.9rem;
        font-family:'Luckiest Guy',cursive;
        letter-spacing:0.1em;
        text-shadow:0 2px 0 #1a0e08, 0 0 10px rgba(255,107,32,0.4);
      }
      .cs-ability-desc{
        color:#c9a87c;font-size:0.72rem;margin-top:2px;
      }

      /* Select button */
      .cs-select{
        flex-shrink:0;
        background:linear-gradient(180deg, rgba(255,107,32,0.15) 0%, transparent 100%);
        border:3px solid #ff6b20;color:#ff8c00;
        font:clamp(1rem,3vw,1.4rem) 'Luckiest Guy',cursive;
        padding:0.7rem clamp(2rem,8vw,4rem);
        cursor:pointer;letter-spacing:0.15em;
        border-radius:10px;transition:all .15s;
        text-shadow:0 2px 0 #1a0e08, 0 0 8px rgba(255,68,0,0.5);
        margin-bottom:env(safe-area-inset-bottom,0);
        position:relative;z-index:1;
      }
      .cs-select:hover{
        background:linear-gradient(180deg, rgba(255,107,32,0.25) 0%, rgba(255,68,0,0.05) 100%);
        box-shadow:0 0 20px rgba(255,107,32,0.5), 0 0 40px rgba(255,68,0,0.2);
        color:#ffaa33;border-color:#ff8c00;
      }
      .cs-select:active{transform:scale(0.95)}

      /* Fade utility */
      .cs-fade-out{opacity:0!important}
    `;
    el.appendChild(style);
    document.body.appendChild(el);
    this._el = el;

    // Three.js renderer on the canvas
    const canvas = el.querySelector('#cs-canvas');
    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.4;
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._resizeRenderer();

    // Events
    el.querySelector('#cs-left').addEventListener('click', () => this._navigate(-1));
    el.querySelector('#cs-right').addEventListener('click', () => this._navigate(1));
    el.querySelector('#cs-select').addEventListener('click', () => this._confirm());

    // Keyboard
    this._onKey = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { this._navigate(-1); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { this._navigate(1); e.preventDefault(); }
      if (e.key === 'Enter') { this._confirm(); e.preventDefault(); }
    };
    window.addEventListener('keydown', this._onKey);

    // Touch/swipe
    canvas.addEventListener('touchstart', (e) => {
      this._touchStartX = e.touches[0].clientX;
      this._touchStartY = e.touches[0].clientY;
    }, { passive: true });
    canvas.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - this._touchStartX;
      const dy = e.changedTouches[0].clientY - this._touchStartY;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        this._navigate(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    // Resize
    this._onResize = () => this._resizeRenderer();
    window.addEventListener('resize', this._onResize);
  }

  _resizeRenderer() {
    const canvas = this._renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      this._renderer.setSize(w, h, false);
    }
    if (this._preview) {
      this._preview.camera.aspect = w / h;
      this._preview.camera.updateProjectionMatrix();
    }
  }

  // ── Car switching ───────────────────────────────────────────────────

  _navigate(dir) {
    if (this._transitioning) return;
    this._transitioning = true;

    // Fade out text
    const nameEl = this._el.querySelector('#cs-car-name');
    const abilEl = this._el.querySelector('#cs-ability');
    nameEl.classList.add('cs-fade-out');
    abilEl.classList.add('cs-fade-out');

    setTimeout(async () => {
      this._index = (this._index + dir + CAR_ORDER.length) % CAR_ORDER.length;
      await this._setCarByIndex(this._index);

      nameEl.classList.remove('cs-fade-out');
      abilEl.classList.remove('cs-fade-out');
      this._transitioning = false;
    }, 200);
  }

  async _setCarByIndex(i) {
    const carKey = CAR_ORDER[i];
    const carCfg = CARS[carKey];

    // Build new preview scene (async — GLB loading)
    this._preview = await getCarPreviewScene(carKey);
    this._resizeRenderer();

    // Car name
    const colorHex = '#' + new THREE.Color(carCfg.color).getHexString();
    const nameEl = this._el.querySelector('#cs-car-name');
    nameEl.textContent = `${carCfg.name} — ${carCfg.subtitle.toUpperCase()}`;
    nameEl.style.setProperty('--car-glow', colorHex);

    // Counter
    this._el.querySelector('#cs-counter').textContent = `${i + 1} / ${CAR_ORDER.length}`;

    // Stats
    this._updateStats(carCfg);

    // Ability
    this._updateAbility(carCfg);
  }

  _updateStats(carCfg) {
    const container = this._el.querySelector('#cs-stats');
    const stats = [
      { key: 'speed',    label: 'SPEED',    color: '#ff4422' },
      { key: 'mass',     label: 'MASS',     color: '#ff8c00' },
      { key: 'handling', label: 'HANDLING',  color: '#ffcc00' },
    ];

    container.innerHTML = stats.map(({ key, label, color }) => {
      const val = carCfg.stats[key];
      const pct = (val / MAX_STAT) * 100;
      return `
        <div class="cs-stat-row">
          <span class="cs-stat-label">${label}</span>
          <div class="cs-stat-track">
            <div class="cs-stat-fill" style="width:${pct}%;background:${color};--bar-color:${color}"></div>
          </div>
          <span class="cs-stat-val">${val}/${MAX_STAT}</span>
        </div>
      `;
    }).join('');
  }

  _updateAbility(carCfg) {
    const el = this._el.querySelector('#cs-ability');
    el.innerHTML = `
      <div class="cs-ability-name">ABILITY: ${carCfg.ability.name}</div>
      <div class="cs-ability-desc">${carCfg.ability.description} · ${carCfg.ability.cooldown}s cooldown</div>
    `;
  }

  // ── Confirm ──────────────────────────────────────────────────────────

  _confirm() {
    const carKey = CAR_ORDER[this._index];
    this.destroy();
    this._onSelect(carKey);
  }

  // ── Render loop ──────────────────────────────────────────────────────

  _startRenderLoop() {
    const loop = () => {
      this._animFrame = requestAnimationFrame(loop);
      if (!this._preview) return;
      const dt = this._clock.getDelta();
      this._preview.update(dt);
      this._renderer.render(this._preview.scene, this._preview.camera);
    };
    loop();
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  destroy() {
    cancelAnimationFrame(this._animFrame);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }
}
