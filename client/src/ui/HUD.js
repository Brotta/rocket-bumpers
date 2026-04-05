import { CARS } from '../core/Config.js';

const RING_R = 30;
const RING_C = 2 * Math.PI * RING_R;
const KILL_FEED_TIMEOUT = 3000;

/**
 * HUD — full in-game overlay rendered as DOM elements.
 *
 * Elements:
 * - Timer (top-center): MM:SS, red < 10s, pulsing < 5s
 * - Score (top-left): flashes green on increase
 * - Ability indicator (bottom-center-right): cooldown ring + glow
 * - Power-up slot (above ability): colored border + icon
 * - Kill feed (top-right): fades after 3s
 */
export class HUD {
  constructor() {
    this._score = 0;
    this._kills = [];
    this._carType = null;
    this._el = null;
    this._build();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Show HUD for given player/car. */
  show(nickname, carType) {
    this._carType = carType;
    const car = CARS[carType];
    this._abilityName.textContent = car.ability.name;
    this._abilityLetter.textContent = car.ability.name[0];
    this._playerLabel.textContent = `${nickname} — ${car.name}`;
    this._el.style.display = 'block';
    this._score = 0;
    this._scoreEl.textContent = '0';
  }

  hide() {
    if (this._el) this._el.style.display = 'none';
  }

  // ── Timer ───────────────────────────────────────────────────────────────

  /** Update timer display. remaining in seconds. */
  updateTimer(remaining) {
    const sec = Math.ceil(remaining);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    this._timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;

    // Color
    if (remaining <= 5) {
      this._timerEl.style.color = '#f44';
      this._timerEl.style.animation = 'hud-pulse 0.5s infinite';
    } else if (remaining <= 10) {
      this._timerEl.style.color = '#f44';
      this._timerEl.style.animation = 'none';
    } else {
      this._timerEl.style.color = '#fff';
      this._timerEl.style.animation = 'none';
    }
  }

  showTimer() { this._timerEl.style.display = 'block'; }
  hideTimer() { this._timerEl.style.display = 'none'; }

  // ── Score ───────────────────────────────────────────────────────────────

  setScore(value) {
    if (value > this._score) {
      this._flashScore();
    }
    this._score = value;
    this._scoreEl.textContent = String(value);
  }

  _flashScore() {
    this._scoreWrap.style.color = '#0f0';
    this._scoreWrap.style.textShadow = '0 0 16px #0f0, 0 0 40px #0f0';
    this._scoreWrap.style.transform = 'scale(1.15)';
    clearTimeout(this._scoreFlashTimer);
    this._scoreFlashTimer = setTimeout(() => {
      this._scoreWrap.style.color = '#fff';
      this._scoreWrap.style.textShadow = '0 0 8px #000';
      this._scoreWrap.style.transform = 'scale(1)';
    }, 350);
  }

  // ── Ability ─────────────────────────────────────────────────────────────

  /**
   * Update ability indicator.
   * @param {'ready'|'active'|'cooldown'} state
   * @param {number} progress 0-1 (1 = ready)
   */
  updateAbility(state, progress) {
    // Ring fill (clockwise)
    this._abilityRing.setAttribute(
      'stroke-dashoffset',
      String(RING_C * (1 - progress)),
    );

    if (state === 'ready') {
      this._abilityRing.setAttribute('stroke', '#0f0');
      this._abilityCircle.style.boxShadow = '0 0 18px #0f0, 0 0 36px #0f055';
      this._abilityLetter.style.color = '#0f0';
    } else if (state === 'active') {
      this._abilityRing.setAttribute('stroke', '#ff0');
      this._abilityCircle.style.boxShadow = '0 0 12px #ff0';
      this._abilityLetter.style.color = '#ff0';
    } else {
      this._abilityRing.setAttribute('stroke', '#555');
      this._abilityCircle.style.boxShadow = 'none';
      this._abilityLetter.style.color = '#666';
    }
  }

  // ── Power-up slot ───────────────────────────────────────────────────────

  /** Show active power-up. color as CSS string, label e.g. "BOOST". null to clear. */
  setPowerUp(color, label) {
    if (!color) {
      this._powerupSlot.style.borderColor = '#333';
      this._powerupSlot.style.background = 'rgba(30,30,30,0.6)';
      this._powerupIcon.textContent = '';
      return;
    }
    this._powerupSlot.style.borderColor = color;
    this._powerupSlot.style.background = 'rgba(0,0,0,0.6)';
    this._powerupIcon.textContent = label || '';
    this._powerupIcon.style.color = color;
  }

  // ── Kill feed ───────────────────────────────────────────────────────────

  /** Add a kill feed entry. */
  addKill(attackerName, victimName, points) {
    const entry = document.createElement('div');
    entry.className = 'hud-kill-entry';
    entry.textContent = `${attackerName} → ${victimName} +${points}`;
    this._killFeed.appendChild(entry);

    // Fade in
    requestAnimationFrame(() => { entry.style.opacity = '1'; });

    // Remove after timeout
    const timer = setTimeout(() => {
      entry.style.opacity = '0';
      setTimeout(() => entry.remove(), 400);
    }, KILL_FEED_TIMEOUT);
    this._kills.push({ entry, timer });
  }

  clearKillFeed() {
    for (const k of this._kills) {
      clearTimeout(k.timer);
      k.entry.remove();
    }
    this._kills.length = 0;
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  dispose() {
    this.clearKillFeed();
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }

  // ── Build DOM ───────────────────────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.id = 'game-hud';
    el.style.cssText = 'display:none;';

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      @keyframes hud-pulse {
        0%,100% { opacity:1; transform:translateX(-50%) scale(1); }
        50%     { opacity:0.5; transform:translateX(-50%) scale(1.08); }
      }

      #game-hud { position:fixed;inset:0;pointer-events:none;z-index:10;font-family:'Courier New',monospace; }

      /* Timer */
      .hud-timer {
        position:absolute;top:16px;left:50%;transform:translateX(-50%);
        font:bold 28px 'Courier New',monospace;color:#fff;
        text-shadow:0 0 8px #000;display:none;
      }

      /* Score */
      .hud-score-wrap {
        position:absolute;top:16px;left:16px;
        color:#fff;text-shadow:0 0 8px #000;
        transition:color .2s,text-shadow .2s,transform .15s;
      }
      .hud-player-label {
        font:bold 14px 'Courier New',monospace;color:#888;
        margin-bottom:4px;
      }
      .hud-score {
        font:bold 28px 'Courier New',monospace;
      }

      /* Ability indicator */
      .hud-ability {
        position:absolute;bottom:24px;right:24px;
        display:flex;flex-direction:column;align-items:center;gap:4px;
      }
      .hud-ability-circle {
        position:relative;width:72px;height:72px;
        border-radius:50%;transition:box-shadow .3s;
      }
      .hud-ability-letter {
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font:bold 26px 'Courier New',monospace;color:#0f0;
        text-shadow:0 0 6px #000;
      }
      .hud-ability-name {
        font:bold 11px 'Courier New',monospace;color:#aaa;
        text-transform:uppercase;letter-spacing:0.15em;
      }

      /* Power-up slot */
      .hud-powerup-slot {
        position:absolute;bottom:112px;right:32px;
        width:44px;height:44px;
        border:2px solid #333;border-radius:6px;
        background:rgba(30,30,30,0.6);
        display:flex;align-items:center;justify-content:center;
        transition:border-color .2s;
      }
      .hud-powerup-icon {
        font:bold 11px 'Courier New',monospace;color:#666;
        text-align:center;
      }

      /* Kill feed */
      .hud-kill-feed {
        position:absolute;top:16px;right:16px;
        display:flex;flex-direction:column;gap:4px;
        max-width:300px;
      }
      .hud-kill-entry {
        font:bold 13px 'Courier New',monospace;
        color:#ff0;text-shadow:0 0 6px #000;
        background:rgba(0,0,0,0.5);
        padding:4px 10px;border-radius:4px;
        opacity:0;transition:opacity .4s;
        white-space:nowrap;
      }
    `;
    el.appendChild(style);

    // Timer
    this._timerEl = this._div('hud-timer', el);

    // Score
    this._scoreWrap = this._div('hud-score-wrap', el);
    this._playerLabel = this._div('hud-player-label', this._scoreWrap);
    this._scoreEl = this._div('hud-score', this._scoreWrap);

    // Ability
    const abilityWrap = this._div('hud-ability', el);
    this._abilityCircle = this._div('hud-ability-circle', abilityWrap);
    this._abilityCircle.innerHTML = `
      <svg viewBox="0 0 72 72" style="width:100%;height:100%;position:absolute;inset:0;">
        <circle cx="36" cy="36" r="30" fill="rgba(0,0,0,0.5)" stroke="#333" stroke-width="3"/>
        <circle class="hud-ability-ring" cx="36" cy="36" r="30" fill="none"
          stroke="#0f0" stroke-width="4" stroke-linecap="round"
          stroke-dasharray="${RING_C}" stroke-dashoffset="0"
          transform="rotate(-90 36 36)"/>
      </svg>
    `;
    this._abilityRing = this._abilityCircle.querySelector('.hud-ability-ring');
    this._abilityLetter = this._div('hud-ability-letter', this._abilityCircle);
    this._abilityName = this._div('hud-ability-name', abilityWrap);

    // Power-up slot
    this._powerupSlot = this._div('hud-powerup-slot', el);
    this._powerupIcon = this._div('hud-powerup-icon', this._powerupSlot);

    // Kill feed
    this._killFeed = this._div('hud-kill-feed', el);

    document.body.appendChild(el);
    this._el = el;
  }

  _div(className, parent) {
    const d = document.createElement('div');
    d.className = className;
    parent.appendChild(d);
    return d;
  }
}
