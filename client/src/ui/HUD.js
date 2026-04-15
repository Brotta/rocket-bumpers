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
      this._timerEl.style.color = '#ff3322';
      this._timerEl.style.borderColor = 'rgba(255,51,34,0.6)';
      this._timerEl.style.animation = 'hud-pulse 0.5s infinite';
    } else if (remaining <= 10) {
      this._timerEl.style.color = '#ff6633';
      this._timerEl.style.borderColor = 'rgba(255,102,0,0.4)';
      this._timerEl.style.animation = 'none';
    } else {
      this._timerEl.style.color = '#fff5e6';
      this._timerEl.style.borderColor = 'rgba(255,102,0,0.4)';
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
    this._scoreWrap.style.color = '#ffcc00';
    this._scoreWrap.style.textShadow = '0 2px 0 #1a0e08, 0 0 20px #ffaa00, 0 0 40px rgba(255,170,0,0.4)';
    this._scoreWrap.style.transform = 'scale(1.18)';
    clearTimeout(this._scoreFlashTimer);
    this._scoreFlashTimer = setTimeout(() => {
      this._scoreWrap.style.color = '#fff5e6';
      this._scoreWrap.style.textShadow = '0 2px 0 #1a0e08, 0 0 10px rgba(0,0,0,0.6)';
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
      this._abilityRing.setAttribute('stroke', '#ffcc00');
      this._abilityCircle.style.boxShadow = '0 0 18px rgba(255,204,0,0.5), 0 0 36px rgba(255,170,0,0.2)';
      this._abilityLetter.style.color = '#ffcc00';
    } else if (state === 'active') {
      this._abilityRing.setAttribute('stroke', '#ff6600');
      this._abilityCircle.style.boxShadow = '0 0 14px rgba(255,102,0,0.5)';
      this._abilityLetter.style.color = '#ff6600';
    } else {
      this._abilityRing.setAttribute('stroke', '#553322');
      this._abilityCircle.style.boxShadow = 'none';
      this._abilityLetter.style.color = '#886644';
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
        50%     { opacity:0.5; transform:translateX(-50%) scale(1.12); }
      }

      #game-hud { position:fixed;inset:0;pointer-events:none;z-index:10;font-family:'Russo One',sans-serif; }

      /* Timer — chunky centered display */
      .hud-timer {
        position:absolute;top:12px;left:50%;transform:translateX(-50%);
        font:32px 'Luckiest Guy',cursive;color:#fff5e6;
        text-shadow:
          0 2px 0 #1a0e08,
          0 0 12px rgba(255,102,0,0.5),
          0 0 30px rgba(255,68,0,0.2);
        letter-spacing:0.08em;
        background:linear-gradient(180deg, rgba(26,14,8,0.85) 0%, rgba(10,6,3,0.9) 100%);
        border:2px solid rgba(255,102,0,0.4);
        border-radius:10px;
        padding:4px 20px;
        display:none;
      }

      /* Score — bold with warm accent */
      .hud-score-wrap {
        position:absolute;top:16px;left:16px;
        color:#fff5e6;
        text-shadow:0 2px 0 #1a0e08, 0 0 10px rgba(0,0,0,0.6);
        transition:color .2s,text-shadow .2s,transform .15s;
      }
      .hud-player-label {
        font:12px 'Russo One',sans-serif;color:#c9a87c;
        margin-bottom:2px;letter-spacing:0.1em;
      }
      .hud-score {
        font:36px 'Luckiest Guy',cursive;
        letter-spacing:0.04em;
      }

      /* Ability indicator — warm glow ring */
      .hud-ability {
        position:absolute;bottom:max(12px, env(safe-area-inset-bottom, 0px));right:max(12px, env(safe-area-inset-right, 0px));
        display:flex;flex-direction:column;align-items:center;gap:4px;
      }
      .hud-ability-circle {
        position:relative;width:72px;height:72px;
        border-radius:50%;transition:box-shadow .3s;
      }
      .hud-ability-letter {
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font:28px 'Luckiest Guy',cursive;color:#ffcc00;
        text-shadow:0 2px 0 #1a0e08, 0 0 8px rgba(0,0,0,0.8);
      }
      .hud-ability-name {
        font:11px 'Russo One',sans-serif;color:#c9a87c;
        text-transform:uppercase;letter-spacing:0.15em;
      }

      /* Power-up slot — mini item box */
      .hud-powerup-slot {
        position:absolute;bottom:calc(100px + max(12px, env(safe-area-inset-bottom, 0px)));right:calc(20px + max(12px, env(safe-area-inset-right, 0px)));
        width:48px;height:48px;
        border:2px solid #553322;border-radius:8px;
        background:linear-gradient(180deg, rgba(26,14,8,0.8) 0%, rgba(10,6,3,0.9) 100%);
        display:flex;align-items:center;justify-content:center;
        transition:border-color .2s, box-shadow .2s;
      }
      .hud-powerup-icon {
        font:bold 10px 'Russo One',sans-serif;color:#886644;
        text-align:center;
      }

      /* Kill feed — warm themed, top-right */
      .hud-kill-feed {
        position:absolute;top:56px;right:16px;
        display:flex;flex-direction:column;gap:5px;
        max-width:320px;
      }
      .hud-kill-entry {
        font:13px 'Russo One',sans-serif;
        color:#ffcc00;
        text-shadow:0 1px 0 #1a0e08, 0 0 8px rgba(255,170,0,0.3);
        background:linear-gradient(90deg, rgba(26,14,8,0.85) 0%, rgba(26,14,8,0.6) 80%, transparent 100%);
        border-left:3px solid #ff6600;
        padding:5px 12px;border-radius:0 6px 6px 0;
        opacity:0;transition:opacity .4s;
        white-space:nowrap;
        letter-spacing:0.03em;
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
        <circle cx="36" cy="36" r="30" fill="rgba(26,14,8,0.7)" stroke="#553322" stroke-width="3"/>
        <circle class="hud-ability-ring" cx="36" cy="36" r="30" fill="none"
          stroke="#ffcc00" stroke-width="4" stroke-linecap="round"
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
