/**
 * MobileControls — virtual joystick + ability/power-up buttons for touch devices.
 *
 * Auto-detected via 'ontouchstart' in window. Hidden on desktop.
 *
 * - Left half: virtual joystick (appears where thumb touches)
 *   X = steer, Y = accelerate/brake
 * - Bottom-right: large ability button with cooldown overlay
 * - Above ability: smaller power-up button
 * - Multitouch: joystick + button simultaneously
 * - All touch events preventDefault (no scroll/zoom)
 */

const JOYSTICK_RADIUS = 60;
const JOYSTICK_THUMB_RADIUS = 24;
const ABILITY_BTN_SIZE = 72;
const POWERUP_BTN_SIZE = 48;
const NEON_BORDER = 'rgba(0,255,255,0.6)';
const BG_SEMI = 'rgba(255,255,255,0.08)';

export class MobileControls {
  /**
   * @param {object} callbacks
   * @param {(input: {forward:boolean,backward:boolean,left:boolean,right:boolean}) => void} callbacks.onInput
   * @param {() => void} callbacks.onAbility
   * @param {() => void} callbacks.onPowerUp
   */
  constructor(callbacks) {
    this._cb = callbacks;
    this._el = null;
    this._active = false;

    // Joystick state
    this._joyTouch = null;   // touch identifier
    this._joyOrigin = null;  // {x, y} center
    this._joyX = 0;          // -1..1
    this._joyY = 0;          // -1..1

    // DOM refs
    this._joyBase = null;
    this._joyThumb = null;
    this._abilityBtn = null;
    this._abilityCooldown = null;
    this._powerupBtn = null;

    // Ability cooldown rendering
    this._abilityState = 'ready';
    this._abilityProgress = 1;
    this._powerupColor = null;

    if (!('ontouchstart' in window)) return;

    this._build();
    this._bindTouch();
    this._active = true;
  }

  get isActive() { return this._active; }

  // ── Public updates ─────────────────────────────────────────────────────

  /** Update ability cooldown ring. state: 'ready'|'active'|'cooldown', progress: 0-1 */
  updateAbility(state, progress) {
    this._abilityState = state;
    this._abilityProgress = progress;
    this._renderAbilityCooldown();
  }

  /** Show power-up color on the power-up button. null to clear. */
  setPowerUp(color) {
    this._powerupColor = color;
    if (!this._powerupBtn) return;
    if (color) {
      this._powerupBtn.style.borderColor = color;
      this._powerupBtn.style.background = color + '22';
    } else {
      this._powerupBtn.style.borderColor = 'rgba(255,255,255,0.2)';
      this._powerupBtn.style.background = BG_SEMI;
    }
  }

  dispose() {
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }

  // ── Build DOM ──────────────────────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.id = 'mobile-controls';
    el.style.cssText = `
      position:fixed;inset:0;z-index:20;
      pointer-events:none;
      touch-action:none;
      user-select:none;
      -webkit-user-select:none;
    `;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      @media (pointer:fine) {
        #mobile-controls { display:none !important; }
      }
    `;
    el.appendChild(style);

    // Joystick base (hidden until touch)
    this._joyBase = document.createElement('div');
    this._joyBase.style.cssText = `
      position:absolute;display:none;
      width:${JOYSTICK_RADIUS * 2}px;height:${JOYSTICK_RADIUS * 2}px;
      border-radius:50%;
      border:2px solid ${NEON_BORDER};
      background:${BG_SEMI};
      pointer-events:none;
    `;

    // Joystick thumb
    this._joyThumb = document.createElement('div');
    this._joyThumb.style.cssText = `
      position:absolute;
      width:${JOYSTICK_THUMB_RADIUS * 2}px;height:${JOYSTICK_THUMB_RADIUS * 2}px;
      border-radius:50%;
      background:rgba(0,255,255,0.35);
      border:2px solid rgba(0,255,255,0.8);
      box-shadow:0 0 12px rgba(0,255,255,0.4);
      left:${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px;
      top:${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px;
      pointer-events:none;
    `;
    this._joyBase.appendChild(this._joyThumb);
    el.appendChild(this._joyBase);

    // Touch zone — left half (for joystick)
    const leftZone = document.createElement('div');
    leftZone.className = 'mc-left-zone';
    leftZone.style.cssText = `
      position:absolute;left:0;top:0;width:50%;height:100%;
      pointer-events:auto;touch-action:none;
    `;
    el.appendChild(leftZone);
    this._leftZone = leftZone;

    // Ability button (bottom-right)
    this._abilityBtn = document.createElement('div');
    this._abilityBtn.style.cssText = `
      position:absolute;bottom:24px;right:24px;
      width:${ABILITY_BTN_SIZE}px;height:${ABILITY_BTN_SIZE}px;
      border-radius:50%;
      border:3px solid rgba(0,255,0,0.7);
      background:${BG_SEMI};
      pointer-events:auto;touch-action:none;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 16px rgba(0,255,0,0.3);
    `;

    // SVG cooldown ring inside ability button
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 72 72');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';

    this._abilityCooldown = document.createElementNS(svgNS, 'circle');
    this._abilityCooldown.setAttribute('cx', '36');
    this._abilityCooldown.setAttribute('cy', '36');
    this._abilityCooldown.setAttribute('r', '30');
    this._abilityCooldown.setAttribute('fill', 'rgba(0,0,0,0.3)');
    this._abilityCooldown.setAttribute('stroke', '#0f0');
    this._abilityCooldown.setAttribute('stroke-width', '4');
    this._abilityCooldown.setAttribute('stroke-dasharray', String(2 * Math.PI * 30));
    this._abilityCooldown.setAttribute('stroke-dashoffset', '0');
    this._abilityCooldown.setAttribute('stroke-linecap', 'round');
    this._abilityCooldown.setAttribute('transform', 'rotate(-90 36 36)');
    svg.appendChild(this._abilityCooldown);
    this._abilityBtn.appendChild(svg);

    // Ability label
    const abilityLbl = document.createElement('div');
    abilityLbl.style.cssText = `
      font:bold 11px 'Courier New',monospace;color:#0f0;
      text-shadow:0 0 6px #000;pointer-events:none;z-index:1;
    `;
    abilityLbl.textContent = 'ABILITY';
    this._abilityBtn.appendChild(abilityLbl);
    this._abilityLabel = abilityLbl;
    el.appendChild(this._abilityBtn);

    // Power-up button (above ability)
    this._powerupBtn = document.createElement('div');
    this._powerupBtn.style.cssText = `
      position:absolute;bottom:${24 + ABILITY_BTN_SIZE + 16}px;right:${24 + (ABILITY_BTN_SIZE - POWERUP_BTN_SIZE) / 2}px;
      width:${POWERUP_BTN_SIZE}px;height:${POWERUP_BTN_SIZE}px;
      border-radius:50%;
      border:2px solid rgba(255,255,255,0.2);
      background:${BG_SEMI};
      pointer-events:auto;touch-action:none;
      display:flex;align-items:center;justify-content:center;
    `;
    const pwrLbl = document.createElement('div');
    pwrLbl.style.cssText = `
      font:bold 9px 'Courier New',monospace;color:#666;
      text-shadow:0 0 4px #000;pointer-events:none;
    `;
    pwrLbl.textContent = 'PWR';
    this._powerupBtn.appendChild(pwrLbl);
    el.appendChild(this._powerupBtn);

    document.body.appendChild(el);
    this._el = el;
  }

  // ── Touch handling ────────────────────────────────────────────────────

  _bindTouch() {
    // Joystick — left zone
    this._leftZone.addEventListener('touchstart', this._onJoyStart, { passive: false });
    this._leftZone.addEventListener('touchmove', this._onJoyMove, { passive: false });
    this._leftZone.addEventListener('touchend', this._onJoyEnd, { passive: false });
    this._leftZone.addEventListener('touchcancel', this._onJoyEnd, { passive: false });

    // Ability button
    this._abilityBtn.addEventListener('touchstart', this._onAbilityTouch, { passive: false });

    // Power-up button
    this._powerupBtn.addEventListener('touchstart', this._onPowerUpTouch, { passive: false });
  }

  _onJoyStart = (e) => {
    e.preventDefault();
    if (this._joyTouch !== null) return; // already tracking

    const t = e.changedTouches[0];
    this._joyTouch = t.identifier;
    this._joyOrigin = { x: t.clientX, y: t.clientY };

    // Show joystick at touch position
    this._joyBase.style.display = 'block';
    this._joyBase.style.left = `${t.clientX - JOYSTICK_RADIUS}px`;
    this._joyBase.style.top = `${t.clientY - JOYSTICK_RADIUS}px`;

    // Reset thumb
    this._joyThumb.style.left = `${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px`;
    this._joyThumb.style.top = `${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px`;

    this._joyX = 0;
    this._joyY = 0;
    this._emitInput();
  };

  _onJoyMove = (e) => {
    e.preventDefault();
    if (this._joyTouch === null) return;

    for (const t of e.changedTouches) {
      if (t.identifier !== this._joyTouch) continue;

      let dx = t.clientX - this._joyOrigin.x;
      let dy = t.clientY - this._joyOrigin.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Clamp to radius
      if (dist > JOYSTICK_RADIUS) {
        dx = (dx / dist) * JOYSTICK_RADIUS;
        dy = (dy / dist) * JOYSTICK_RADIUS;
      }

      // Normalized -1..1
      this._joyX = dx / JOYSTICK_RADIUS;
      this._joyY = -dy / JOYSTICK_RADIUS; // Y inverted: up = positive

      // Move thumb
      this._joyThumb.style.left = `${JOYSTICK_RADIUS + dx - JOYSTICK_THUMB_RADIUS}px`;
      this._joyThumb.style.top = `${JOYSTICK_RADIUS + dy - JOYSTICK_THUMB_RADIUS}px`;

      this._emitInput();
      break;
    }
  };

  _onJoyEnd = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== this._joyTouch) continue;

      this._joyTouch = null;
      this._joyOrigin = null;
      this._joyX = 0;
      this._joyY = 0;
      this._joyBase.style.display = 'none';

      // Reset thumb position
      this._joyThumb.style.left = `${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px`;
      this._joyThumb.style.top = `${JOYSTICK_RADIUS - JOYSTICK_THUMB_RADIUS}px`;

      this._emitInput();
      break;
    }
  };

  _onAbilityTouch = (e) => {
    e.preventDefault();
    if (this._cb.onAbility) this._cb.onAbility();
  };

  _onPowerUpTouch = (e) => {
    e.preventDefault();
    if (this._cb.onPowerUp) this._cb.onPowerUp();
  };

  // ── Input emission ────────────────────────────────────────────────────

  _emitInput() {
    const deadzone = 0.2;
    if (this._cb.onInput) {
      this._cb.onInput({
        forward: this._joyY > deadzone,
        backward: this._joyY < -deadzone,
        left: this._joyX < -deadzone,
        right: this._joyX > deadzone,
      });
    }
  }

  // ── Ability cooldown rendering ────────────────────────────────────────

  _renderAbilityCooldown() {
    if (!this._abilityCooldown) return;
    const c = 2 * Math.PI * 30;
    this._abilityCooldown.setAttribute(
      'stroke-dashoffset',
      String(c * (1 - this._abilityProgress)),
    );

    if (this._abilityState === 'ready') {
      this._abilityCooldown.setAttribute('stroke', '#0f0');
      this._abilityBtn.style.borderColor = 'rgba(0,255,0,0.7)';
      this._abilityBtn.style.boxShadow = '0 0 18px rgba(0,255,0,0.4)';
      this._abilityLabel.style.color = '#0f0';
    } else if (this._abilityState === 'active') {
      this._abilityCooldown.setAttribute('stroke', '#ff0');
      this._abilityBtn.style.borderColor = 'rgba(255,255,0,0.7)';
      this._abilityBtn.style.boxShadow = '0 0 12px rgba(255,255,0,0.3)';
      this._abilityLabel.style.color = '#ff0';
    } else {
      this._abilityCooldown.setAttribute('stroke', '#555');
      this._abilityBtn.style.borderColor = 'rgba(100,100,100,0.5)';
      this._abilityBtn.style.boxShadow = 'none';
      this._abilityLabel.style.color = '#666';
    }
  }

  /** Set ability name displayed on the button. */
  setAbilityName(name) {
    if (this._abilityLabel) this._abilityLabel.textContent = name;
  }
}
