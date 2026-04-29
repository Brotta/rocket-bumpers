import { Game } from './core/Game.js';
import { CARS, CAR_ORDER } from './core/Config.js';
import { SplashScreen } from './ui/SplashScreen.js';
import { CarSelect } from './ui/CarSelect.js';
import { preloadCarModels } from './rendering/CarFactory.js';
import { menuMusic } from './audio/MenuMusic.js';
import { arenaMusic } from './audio/ArenaMusic.js';
import { sampleEngineAudio } from './audio/SampleEngineAudio.js';
import { sfxPlayer } from './audio/SFXPlayer.js';

// ── URL params detection ─────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const isPortalEntry = urlParams.get('portal') === 'true';
const portalUsername = urlParams.get('username') || null;
const roomId = urlParams.get('room') || 'arena-1'; // default public room

// ── Create game instance ──────────────────────────────────────────────
const game = new Game();

// ��─ FPS / Frame-time counter (top-right) ─────────────────────────────
const fpsDiv = document.createElement('div');
fpsDiv.style.cssText = `
  position:fixed;bottom:max(8px, env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);
  color:#886644;font:10px 'Russo One',sans-serif;
  background:rgba(10,6,3,0.6);
  padding:3px 8px;
  border-radius:4px;pointer-events:none;z-index:100;
  line-height:1.3;letter-spacing:0.04em;
  opacity:0.6;
`;
document.body.appendChild(fpsDiv);

let _fpsFrames = 0;
let _fpsLastTime = performance.now();
const _fpsLoop = () => {
  requestAnimationFrame(_fpsLoop);
  _fpsFrames++;
  const now = performance.now();
  const elapsed = now - _fpsLastTime;
  if (elapsed >= 500) {
    const fps = (_fpsFrames / elapsed * 1000).toFixed(0);
    const frameTime = (elapsed / _fpsFrames).toFixed(1);
    fpsDiv.textContent = `${fps} FPS\n${frameTime} ms`;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }
};
requestAnimationFrame(_fpsLoop);

// ── HUD elements ───────────────────────────────────────���──────────────

// Player info panel (top-left) — combined: name + HP bar + score
const hudDiv = document.createElement('div');
hudDiv.id = 'player-panel';
hudDiv.style.cssText = `
  position:fixed;top:16px;left:16px;
  color:#fff5e6;font:13px 'Russo One',sans-serif;
  background:linear-gradient(180deg, rgba(26,14,8,0.88) 0%, rgba(10,6,3,0.92) 100%);
  border:2px solid rgba(255,102,0,0.3);
  padding:10px 14px;
  border-radius:10px;pointer-events:none;z-index:10;
  display:none;letter-spacing:0.05em;
  min-width:180px;
  box-shadow:0 4px 16px rgba(0,0,0,0.4);
`;
hudDiv.innerHTML = `
  <div id="pp-name" style="color:#c9a87c;font-size:11px;margin-bottom:6px;letter-spacing:0.08em;"></div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
    <span id="pp-hp-label" style="color:#44ff44;font:14px 'Luckiest Guy',cursive;min-width:28px;text-shadow:0 1px 0 #1a0e08;">HP</span>
    <div style="flex:1;height:12px;background:rgba(20,12,6,0.8);border:2px solid rgba(255,102,0,0.2);border-radius:6px;overflow:hidden;box-shadow:inset 0 2px 3px rgba(0,0,0,0.4);">
      <div id="pp-hp-fill" style="height:100%;width:100%;border-radius:4px;background:#44ff44;transition:width 0.25s ease-out, background-color 0.3s, filter 0.1s;background-image:linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 50%);"></div>
    </div>
    <span id="pp-hp-val" style="color:#44ff44;font:14px 'Luckiest Guy',cursive;min-width:30px;text-align:right;text-shadow:0 1px 0 #1a0e08;">100</span>
  </div>
  <div style="display:flex;align-items:baseline;gap:6px;">
    <span style="color:#886644;font-size:10px;">SCORE</span>
    <span id="pp-score" style="font:28px 'Luckiest Guy',cursive;color:#fff5e6;text-shadow:0 2px 0 #1a0e08;letter-spacing:0.03em;">0</span>
  </div>
`;
document.body.appendChild(hudDiv);

const ppName = hudDiv.querySelector('#pp-name');
const ppHpLabel = hudDiv.querySelector('#pp-hp-label');
const ppHpFill = hudDiv.querySelector('#pp-hp-fill');
const ppHpVal = hudDiv.querySelector('#pp-hp-val');
const ppScore = hudDiv.querySelector('#pp-score');

// hpDiv is no longer standalone — kept as null reference for backward compat
const hpDiv = { style: { display: '', color: '', textShadow: '' }, textContent: '' };

// Ability cooldown ring (bottom-right, below power-up)
const abilityHud = document.createElement('div');
abilityHud.style.cssText = `
  position:fixed;bottom:max(12px, env(safe-area-inset-bottom, 0px));right:max(12px, env(safe-area-inset-right, 0px));
  width:72px;
  pointer-events:none;z-index:10;display:none;
  flex-direction:column;align-items:center;
`;
const ringCircumference = 2 * Math.PI * 30;
abilityHud.innerHTML = `
  <div style="position:relative;width:72px;height:72px;">
    <svg viewBox="0 0 72 72" style="width:100%;height:100%">
      <circle cx="36" cy="36" r="30" fill="rgba(26,14,8,0.7)" stroke="#553322" stroke-width="3"/>
      <circle id="ability-ring" cx="36" cy="36" r="30" fill="none"
        stroke="#ffcc00" stroke-width="4" stroke-linecap="round"
        stroke-dasharray="${ringCircumference}" stroke-dashoffset="0"
        transform="rotate(-90 36 36)"/>
    </svg>
    <div id="ability-letter" style="
      position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      font:22px 'Luckiest Guy',cursive;color:#ffcc00;
      text-shadow:0 2px 0 #1a0e08, 0 0 8px rgba(0,0,0,0.8);
    "></div>
  </div>
  <div id="ability-label" style="
    text-align:center;margin-top:3px;
    color:#c9a87c;font:9px 'Russo One',sans-serif;
    text-shadow:0 1px 0 #1a0e08;white-space:pre-line;
    letter-spacing:0.04em;
  "></div>
`;
document.body.appendChild(abilityHud);

const abilityRing = abilityHud.querySelector('#ability-ring');
const abilityLabel = abilityHud.querySelector('#ability-label');
const abilityLetter = abilityHud.querySelector('#ability-letter');

// Power-up HUD slot (top-right, large Mario Kart style)
const powerupHud = document.createElement('div');
powerupHud.id = 'powerup-hud';
powerupHud.style.cssText = `
  position:fixed;
  top:16px;right:16px;
  width:128px;
  pointer-events:none;z-index:10;display:none;
  font-family:'Russo One',sans-serif;
`;
powerupHud.innerHTML = `
  <div id="pu-box" style="
    width:120px;height:120px;margin:0 auto;
    border:4px solid #553322;border-radius:16px;
    background:linear-gradient(180deg, rgba(26,14,8,0.9) 0%, rgba(15,8,4,0.95) 100%);
    transition:border-color .25s,box-shadow .25s,transform .15s;
    position:relative;overflow:hidden;
    box-shadow:inset 0 2px 8px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.5);
  ">
    <div id="pu-icon" style="
      width:100%;height:100%;
      background-size:60% 60%;
      background-repeat:no-repeat;
      background-position:center;
      transition:opacity .2s;
      opacity:0;
    "></div>
    <div id="pu-flash" style="
      position:absolute;inset:0;
      background:radial-gradient(circle,rgba(255,200,100,0.6) 0%,transparent 70%);
      opacity:0;pointer-events:none;
      transition:opacity .3s;
    "></div>
  </div>
  <div id="pu-label" style="
    text-align:center;font:12px 'Russo One',sans-serif;
    color:#886644;margin-top:6px;letter-spacing:0.1em;
    transition:color .2s;
  ">[E] ITEM</div>
`;
document.body.appendChild(powerupHud);

const puBox = powerupHud.querySelector('#pu-box');
const puIcon = powerupHud.querySelector('#pu-icon');
const puLabel = powerupHud.querySelector('#pu-label');
const puFlash = powerupHud.querySelector('#pu-flash');

// Power-up icon/color mapping
const PU_DISPLAY = {
  MISSILE:        { icon: '/assets/icons/Missile.png',       label: 'MISSILE' },
  HOMING_MISSILE: { icon: '/assets/icons/HomingMissile.png', label: 'HOMING' },
  SHIELD:         { icon: '/assets/icons/Shield.png',        label: 'SHIELD' },
  REPAIR_KIT:     { icon: '/assets/icons/RepairKit.webp',    label: 'REPAIR' },
  HOLO_EVADE:     { icon: '/assets/icons/HoloEvade.webp',    label: 'HOLO' },
  AUTO_TURRET:    { icon: '/assets/icons/Turret.webp',       label: 'TURRET' },
  GLITCH_BOMB:    { icon: '/assets/icons/RetroBomb.webp',    label: 'GLITCH' },
};

// Preload icons so the first pickup of each type doesn't show a blank box
// while the browser fetches the PNG.
for (const { icon } of Object.values(PU_DISPLAY)) {
  if (icon) { const img = new Image(); img.src = icon; }
}

// flashPowerUpUsed schedules a delayed setPowerUpHud(null). If a new pickup
// arrives inside that window, the stale timeout would wipe the fresh icon —
// track and cancel it whenever setPowerUpHud is called again.
let _puFlashClearTimeout = null;
let _puBoxScaleTimeout = null;

function setPowerUpHud(type) {
  if (_puFlashClearTimeout) { clearTimeout(_puFlashClearTimeout); _puFlashClearTimeout = null; }
  if (_puBoxScaleTimeout) { clearTimeout(_puBoxScaleTimeout); _puBoxScaleTimeout = null; }

  if (!type) {
    puBox.style.borderColor = '#553322';
    puBox.style.boxShadow = 'inset 0 2px 8px rgba(0,0,0,0.5), 0 0 8px rgba(0,0,0,0.4)';
    puBox.style.transform = 'scale(1)';
    puIcon.style.opacity = '0';
    puIcon.style.backgroundImage = 'none';
    puLabel.textContent = '[E] ITEM';
    puLabel.style.color = '#886644';
    return;
  }
  const powerupCfg = game.powerUpManager.getHeldConfig(game.localPlayer);
  const colorHex = powerupCfg ? '#' + powerupCfg.color.toString(16).padStart(6, '0') : '#fff';
  const display = PU_DISPLAY[type] || { icon: '', label: type };

  puBox.style.borderColor = colorHex;
  puBox.style.boxShadow = `0 0 16px ${colorHex}55, inset 0 0 20px ${colorHex}22`;
  puIcon.style.backgroundImage = `url("${display.icon}")`;
  puIcon.style.opacity = '1';
  puLabel.textContent = `[E] ${display.label}`;
  puLabel.style.color = colorHex;

  puBox.style.transform = 'scale(1.2)';
  _puBoxScaleTimeout = setTimeout(() => {
    puBox.style.transform = 'scale(1)';
    _puBoxScaleTimeout = null;
  }, 200);
}

function flashPowerUpUsed() {
  if (_puFlashClearTimeout) clearTimeout(_puFlashClearTimeout);
  puFlash.style.opacity = '1';
  puBox.style.transform = 'scale(1.15)';
  _puFlashClearTimeout = setTimeout(() => {
    _puFlashClearTimeout = null;
    puFlash.style.opacity = '0';
    puBox.style.transform = 'scale(1)';
    setPowerUpHud(null);
  }, 300);
}

// ── Leaderboard (left side) ─────────────────────────────────────────
const leaderboardDiv = document.createElement('div');
leaderboardDiv.style.cssText = `
  position:fixed;top:130px;left:16px;
  color:#fff5e6;font:13px 'Russo One',sans-serif;
  background:linear-gradient(180deg, rgba(26,14,8,0.88) 0%, rgba(10,6,3,0.92) 100%);
  border:2px solid rgba(255,102,0,0.25);
  padding:10px 14px;
  border-radius:10px;pointer-events:none;z-index:10;
  display:none;min-width:190px;
  box-shadow:0 4px 16px rgba(0,0,0,0.4);
  letter-spacing:0.03em;
`;
document.body.appendChild(leaderboardDiv);

// ── RPM Tachometer (bottom-left, Mario Kart style) ─────────────────
const rpmContainer = document.createElement('div');
rpmContainer.id = 'rpm-tach';
rpmContainer.style.cssText = `
  position:fixed;
  bottom:max(20px, env(safe-area-inset-bottom, 0px));
  left:max(20px, env(safe-area-inset-left, 0px));
  pointer-events:none;z-index:10;display:none;
  font-family:'Russo One',sans-serif;
`;

// Inject tachometer styles
const rpmStyle = document.createElement('style');
rpmStyle.textContent = `
  @keyframes rpm-redline-pulse {
    0%,100% { opacity:0.7; }
    50% { opacity:1; }
  }
  @keyframes rpm-shift-flash {
    0% { opacity:1; transform:scale(1.15); }
    100% { opacity:0; transform:scale(1); }
  }

  .rpm-outer {
    position:relative;
    width:220px;
    padding:10px 14px 8px 14px;
    background: linear-gradient(180deg, rgba(26,14,8,0.92) 0%, rgba(15,8,4,0.95) 100%);
    border:2px solid rgba(255,102,0,0.3);
    border-radius:12px;
    box-shadow: 0 0 12px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04);
  }

  .rpm-header {
    display:flex;align-items:center;justify-content:space-between;
    margin-bottom:6px;
  }
  .rpm-label {
    font:10px 'Russo One',sans-serif;
    color:#886644;letter-spacing:0.2em;text-transform:uppercase;
  }
  .rpm-value {
    font:13px 'Russo One',sans-serif;
    color:#fff5e6;text-shadow:0 0 6px rgba(255,170,0,0.3);
    min-width:60px;text-align:right;
  }

  .rpm-track {
    position:relative;
    width:100%;height:18px;
    background:rgba(20,12,6,0.8);
    border-radius:9px;
    overflow:hidden;
    border:1px solid rgba(255,102,0,0.2);
    box-shadow:inset 0 2px 4px rgba(0,0,0,0.5);
  }

  .rpm-fill {
    position:absolute;top:0;left:0;
    height:100%;width:0%;
    border-radius:9px;
    background: linear-gradient(90deg,
      #00cc44 0%,
      #44dd22 20%,
      #aadd00 40%,
      #ddcc00 55%,
      #ff9900 70%,
      #ff4400 85%,
      #ff0033 100%
    );
    transition: width 0.05s linear;
    box-shadow: 0 0 8px rgba(255,150,0,0.3);
  }

  .rpm-fill-glow {
    position:absolute;top:0;left:0;
    height:100%;width:0%;
    border-radius:9px;
    background: linear-gradient(90deg,
      transparent 0%,
      transparent 60%,
      rgba(255,100,0,0.25) 80%,
      rgba(255,0,50,0.4) 100%
    );
    pointer-events:none;
    transition: width 0.05s linear;
  }

  .rpm-shine {
    position:absolute;top:0;left:0;right:0;
    height:50%;
    border-radius:9px 9px 0 0;
    background:linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 100%);
    pointer-events:none;
  }

  .rpm-ticks {
    position:absolute;top:0;left:0;right:0;bottom:0;
    display:flex;align-items:stretch;
    padding:0 2px;
    pointer-events:none;
  }
  .rpm-tick {
    flex:1;
    border-right:1px solid rgba(255,255,255,0.06);
  }
  .rpm-tick:last-child { border-right:none; }
  .rpm-tick-major {
    border-right:1px solid rgba(255,255,255,0.15);
  }

  .rpm-redline-zone {
    position:absolute;top:0;right:0;
    width:15%;height:100%;
    background:repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 2px,
      rgba(255,0,50,0.15) 2px,
      rgba(255,0,50,0.15) 4px
    );
    border-radius:0 9px 9px 0;
    pointer-events:none;
  }

  .rpm-footer {
    display:flex;align-items:center;justify-content:space-between;
    margin-top:5px;
  }

  .rpm-gear-badge {
    display:flex;align-items:center;justify-content:center;
    width:28px;height:28px;
    border-radius:6px;
    background:linear-gradient(180deg, rgba(40,22,10,0.9) 0%, rgba(20,12,6,0.95) 100%);
    border:2px solid rgba(255,140,0,0.5);
    font:16px 'Luckiest Guy',cursive;
    color:#fff5e6;
    text-shadow:0 0 8px rgba(255,170,0,0.5);
    box-shadow:0 0 6px rgba(0,0,0,0.4);
    transition:border-color 0.2s, text-shadow 0.2s, color 0.15s;
  }

  .rpm-speed-text {
    font:10px 'Russo One',sans-serif;
    color:#c9a87c;
    letter-spacing:0.05em;
  }

  .rpm-shift-indicator {
    position:absolute;top:-2px;right:-2px;bottom:-2px;left:-2px;
    border-radius:14px;
    border:2px solid transparent;
    pointer-events:none;
    opacity:0;
    transition:opacity 0.15s;
  }
`;
document.head.appendChild(rpmStyle);

rpmContainer.innerHTML = `
  <div class="rpm-outer">
    <div class="rpm-shift-indicator" id="rpm-shift-ind"></div>
    <div class="rpm-header">
      <span class="rpm-label">TACH</span>
      <span class="rpm-value" id="rpm-val">0 RPM</span>
    </div>
    <div class="rpm-track">
      <div class="rpm-fill" id="rpm-fill"></div>
      <div class="rpm-fill-glow" id="rpm-glow"></div>
      <div class="rpm-redline-zone"></div>
      <div class="rpm-ticks">
        ${Array.from({ length: 10 }, (_, i) =>
          `<div class="rpm-tick${i % 2 === 0 ? ' rpm-tick-major' : ''}"></div>`
        ).join('')}
      </div>
      <div class="rpm-shine"></div>
    </div>
    <div class="rpm-footer">
      <div class="rpm-gear-badge" id="rpm-gear">1</div>
      <span class="rpm-speed-text" id="rpm-speed">0 km/h</span>
    </div>
  </div>
`;
document.body.appendChild(rpmContainer);

const rpmFill = rpmContainer.querySelector('#rpm-fill');
const rpmGlow = rpmContainer.querySelector('#rpm-glow');
const rpmVal = rpmContainer.querySelector('#rpm-val');
const rpmGearBadge = rpmContainer.querySelector('#rpm-gear');
const rpmSpeedText = rpmContainer.querySelector('#rpm-speed');
const rpmShiftInd = rpmContainer.querySelector('#rpm-shift-ind');
const rpmOuter = rpmContainer.querySelector('.rpm-outer');

let _prevGear = 0;
let _rpmShiftTimer = 0;

function updateRpmHud(dt) {
  if (!game.localPlayer) return;

  const voice = sampleEngineAudio._engines.get(game.localPlayer);
  if (!voice) return;

  const { gearSim, profile } = voice;
  const rpm = gearSim.rpm;
  const gear = gearSim.gear;
  const idleRPM = profile.idleRPM;
  const redlineRPM = profile.redlineRPM;

  // RPM fraction (0 at idle, 1 at redline)
  const rpmFrac = Math.max(0, Math.min(1, (rpm - idleRPM) / (redlineRPM - idleRPM)));
  const pct = (rpmFrac * 100).toFixed(1);

  rpmFill.style.width = pct + '%';
  rpmGlow.style.width = pct + '%';

  // RPM number display
  rpmVal.textContent = Math.round(rpm).toLocaleString() + ' RPM';

  // Gear badge
  rpmGearBadge.textContent = String(gear);

  // Speed display (convert internal units to km/h for display flavor)
  const absSpeed = Math.abs(game.localPlayer._currentSpeed);
  const kmh = Math.round(absSpeed * 3.6); // rough unit conversion
  rpmSpeedText.textContent = kmh + ' km/h';

  // Color-code the gear badge by RPM zone
  if (rpmFrac > 0.85) {
    // Redline zone
    rpmGearBadge.style.borderColor = '#ff2244';
    rpmGearBadge.style.color = '#ff4466';
    rpmGearBadge.style.textShadow = '0 0 10px rgba(255,30,60,0.8)';
    rpmOuter.style.borderColor = 'rgba(255,30,60,0.6)';
    rpmOuter.style.boxShadow = '0 0 16px rgba(255,30,60,0.25), inset 0 1px 0 rgba(255,255,255,0.04)';
    rpmFill.style.boxShadow = '0 0 14px rgba(255,50,0,0.5)';
  } else if (rpmFrac > 0.6) {
    // High RPM
    rpmGearBadge.style.borderColor = 'rgba(255,160,30,0.7)';
    rpmGearBadge.style.color = '#ffbb44';
    rpmGearBadge.style.textShadow = '0 0 8px rgba(255,180,0,0.5)';
    rpmOuter.style.borderColor = 'rgba(255,140,0,0.4)';
    rpmOuter.style.boxShadow = '0 0 12px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)';
    rpmFill.style.boxShadow = '0 0 10px rgba(255,150,0,0.4)';
  } else {
    // Normal
    rpmGearBadge.style.borderColor = 'rgba(255,140,0,0.5)';
    rpmGearBadge.style.color = '#fff5e6';
    rpmGearBadge.style.textShadow = '0 0 8px rgba(255,170,0,0.5)';
    rpmOuter.style.borderColor = 'rgba(255,102,0,0.3)';
    rpmOuter.style.boxShadow = '0 0 12px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)';
    rpmFill.style.boxShadow = '0 0 8px rgba(255,150,0,0.3)';
  }

  // Gear shift flash effect
  if (gear !== _prevGear && _prevGear !== 0) {
    _rpmShiftTimer = 0.35;
    rpmShiftInd.style.borderColor = gear > _prevGear ? '#00ccff' : '#ff8800';
    rpmShiftInd.style.opacity = '1';
    rpmShiftInd.style.animation = 'rpm-shift-flash 0.35s ease-out forwards';
  }
  _prevGear = gear;

  if (_rpmShiftTimer > 0) {
    _rpmShiftTimer -= dt;
    if (_rpmShiftTimer <= 0) {
      rpmShiftInd.style.opacity = '0';
      rpmShiftInd.style.animation = 'none';
    }
  }
}

// ── Kill streak indicator (center) ──────────────────────────────────
const streakDiv = document.createElement('div');
streakDiv.style.cssText = `
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  color:#ffcc00;font:42px 'Luckiest Guy',cursive;
  text-shadow:0 3px 0 #1a0e08, 0 0 20px rgba(255,170,0,0.6), 0 0 40px rgba(255,102,0,0.3);
  pointer-events:none;z-index:50;display:none;
  transition:opacity 0.5s;
`;
document.body.appendChild(streakDiv);

function updateLeaderboard(entries) {
  const top5 = entries.slice(0, 5);
  const localId = game.networkManager?.localPlayerId || 'local';
  const hostId = game.networkManager?.hostId || null;
  leaderboardDiv.innerHTML = '<div style="color:#ff8c00;margin-bottom:6px;letter-spacing:0.12em;font-family:Luckiest Guy,cursive;font-size:14px;">LEADERBOARD</div>' +
    top5.map((e, i) => {
      const isLocal = e.playerId === localId;
      const isHost = hostId && e.playerId === hostId;
      const color = isHost ? '#ff8800' : (isLocal ? '#ffcc00' : (i === 0 ? '#ff8c00' : '#c9a87c'));
      const hostTag = isHost ? ' [H]' : '';
      const streakText = e.streak >= 3 ? ` ${e.streak}x` : '';
      return `<div style="color:${color};padding:3px 0;border-bottom:1px solid rgba(255,102,0,0.1);">${i + 1}. ${e.nickname}${hostTag} — ${e.score}${streakText}</div>`;
    }).join('');
}

function showStreakNotification(streak, multiplier) {
  if (streak < 3) return;
  streakDiv.textContent = `${multiplier}× KILL STREAK!`;
  streakDiv.style.display = 'block';
  streakDiv.style.opacity = '1';
  sfxPlayer.play('multi-kill', { priority: 10, volume: 1.0, effect: 'announcer', announcerOverride: true });
  setTimeout(() => {
    streakDiv.style.opacity = '0';
    setTimeout(() => { streakDiv.style.display = 'none'; }, 500);
  }, 1500);
}

// ── HUD update functions ────────────────────────────────────────────────

let currentCarType = null;

function showHUD(nickname, carType) {
  currentCarType = carType;
  const c = CARS[carType];
  ppName.textContent = `${nickname} · ${c.name}`;
  ppScore.textContent = '0';
  ppHpFill.style.width = '100%';
  ppHpFill.style.backgroundColor = '#44ff44';
  ppHpVal.textContent = '100';
  ppHpLabel.style.color = '#44ff44';
  ppHpVal.style.color = '#44ff44';
  hudDiv.style.display = 'block';
  abilityHud.style.display = 'flex';
  powerupHud.style.display = 'block';
  leaderboardDiv.style.display = 'block';
  rpmContainer.style.display = 'block';
  abilityLetter.textContent = c.ability.name[0];
  abilityLabel.textContent = `${c.ability.name}\n[SPACE]`;
  setPowerUpHud(null);
  _prevGear = 0;

  // Set ability name on mobile controls
  if (game.mobileControls?.isActive) {
    game.mobileControls.setAbilityName(c.ability.name);
  }
}

function updateAbilityHud() {
  const ability = game.localAbility;
  if (!ability) return;

  const progress = ability.cooldownProgress;
  abilityRing.setAttribute('stroke-dashoffset', String(ringCircumference * (1 - progress)));

  if (ability.state === 'ready') {
    abilityRing.setAttribute('stroke', '#ffcc00');
    abilityLetter.style.color = '#ffcc00';
    abilityLabel.style.color = '#c9a87c';
  } else if (ability.state === 'active') {
    abilityRing.setAttribute('stroke', '#ff6600');
    abilityLetter.style.color = '#ff6600';
    abilityLabel.style.color = '#ff6600';
  } else {
    abilityRing.setAttribute('stroke', '#553322');
    abilityLetter.style.color = '#886644';
    abilityLabel.style.color = '#886644';
  }
}

function updateHpHud() {
  if (game.localPlayer) {
    const hp = Math.ceil(game.localPlayer.hp);
    const ratio = Math.max(0, hp / game.localPlayer.maxHp);
    ppHpFill.style.width = `${ratio * 100}%`;
    ppHpVal.textContent = String(hp);

    let color;
    if (ratio > 0.6) {
      color = '#44ff44';
    } else if (ratio > 0.3) {
      color = '#ffcc00';
    } else {
      color = '#ff3333';
    }
    ppHpFill.style.backgroundColor = color;
    ppHpLabel.style.color = color;
    ppHpVal.style.color = color;
  }
}

// ── Game event listeners ────────────────────────────────────────────────

// Score events → leaderboard + streak notifications
game.scoreManager.on('leaderboard', ({ entries }) => {
  updateLeaderboard(entries);
  // Update local player score in panel
  const localId = game.networkManager?.localPlayerId || 'local';
  const localEntry = entries.find(e => e.playerId === localId);
  if (localEntry) {
    const prev = parseInt(ppScore.textContent) || 0;
    ppScore.textContent = String(localEntry.score);
    if (localEntry.score > prev) {
      ppScore.style.color = '#ffcc00';
      ppScore.style.textShadow = '0 2px 0 #1a0e08, 0 0 16px rgba(255,170,0,0.5)';
      clearTimeout(ppScore._flashTimer);
      ppScore._flashTimer = setTimeout(() => {
        ppScore.style.color = '#fff5e6';
        ppScore.style.textShadow = '0 2px 0 #1a0e08';
      }, 350);
    }
  }
});

game.scoreManager.on('scoreUpdate', ({ playerId, streak, multiplier, isHit }) => {
  const localId = game.networkManager?.localPlayerId || 'local';
  // Only show streak notification on kills (not on every hit)
  if (playerId === localId && streak >= 3 && !isHit) {
    showStreakNotification(streak, multiplier);
  }
});

// ── Power-up events ────────────────────────────────────────────────────

game.powerUpManager.on('pickup', ({ car, type }) => {
  if (car === game.localPlayer) {
    setPowerUpHud(type);
    // Update mobile power-up button
    if (game.mobileControls?.isActive) {
      const cfg = game.powerUpManager.getHeldConfig(car);
      const hex = cfg ? '#' + cfg.color.toString(16).padStart(6, '0') : null;
      game.mobileControls.setPowerUp(hex);
    }
  }
});

game.powerUpManager.on('used', ({ car, type }) => {
  if (car === game.localPlayer) {
    flashPowerUpUsed();
    if (game.mobileControls?.isActive) {
      game.mobileControls.setPowerUp(null);
    }
  }
});

game.powerUpManager.on('drop', ({ car }) => {
  if (car === game.localPlayer) {
    setPowerUpHud(null);
    if (game.mobileControls?.isActive) {
      game.mobileControls.setPowerUp(null);
    }
  }
});

// HUD updates each frame via a polling approach in rAF
let _hudLastTime = performance.now();
const _hudLoop = () => {
  requestAnimationFrame(_hudLoop);
  const now = performance.now();
  const hudDt = (now - _hudLastTime) / 1000;
  _hudLastTime = now;

  // Always update HP (server can send damage outside of playing state)
  updateHpHud();

  if (game.gameState.isPlaying) {
    updateAbilityHud();
    updateRpmHud(hudDt);

    // Sync mobile controls with ability state
    if (game.mobileControls?.isActive && game.localAbility) {
      game.mobileControls.updateAbility(
        game.localAbility.state,
        game.localAbility.cooldownProgress,
      );
    }
  }
};
requestAnimationFrame(_hudLoop);

// ── Damage feedback flash ───────────────────────────────────────────────

game.on('damage', ({ target, amount }) => {
  if (target === game.localPlayer && amount > 0) {
    // Flash HP bar white on hit
    ppHpFill.style.filter = 'brightness(2.0)';
    ppHpVal.style.color = '#ff2200';
    setTimeout(() => {
      ppHpFill.style.filter = 'none';
      updateHpHud();
    }, 150);
  }
});

game.on('eliminated', ({ victim }) => {
  if (victim === game.localPlayer) {
    ppHpFill.style.width = '0%';
    ppHpVal.textContent = 'KO';
    ppHpVal.style.color = '#ff2200';
    ppHpLabel.style.color = '#ff2200';
  }
});

// When player respawns with new car, update HUD
game.on('playerSpawned', ({ carBody, carType }) => {
  if (carBody === game.localPlayer) {
    showHUD(game.playerNickname, carType);
  }
});

// ── Disconnect notification ──────────────────────────────────────────
game.on('disconnected', () => {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(0,0,0,0.85);display:flex;flex-direction:column;
    align-items:center;justify-content:center;z-index:9999;
    color:#fff5e6;font-family:'Russo One',sans-serif;`;
  overlay.innerHTML = `
    <h2 style="margin-bottom:10px;color:#ff4422;letter-spacing:0.1em;font-family:'Luckiest Guy',cursive;font-size:2rem;">Connection Lost</h2>
    <p style="margin-bottom:24px;color:#c9a87c;">You have been disconnected from the server.</p>
    <div>
      <button id="btn-continue-offline" style="padding:10px 24px;margin:6px;cursor:pointer;background:linear-gradient(180deg,#ff7700,#ff5500);border:2px solid #ff8800;color:#fff;border-radius:8px;font:14px 'Russo One',sans-serif;letter-spacing:0.05em;">Continue Offline</button>
      <button id="btn-reconnect" style="padding:10px 24px;margin:6px;cursor:pointer;background:linear-gradient(180deg,#2266ff,#0044dd);border:2px solid #3377ff;color:#fff;border-radius:8px;font:14px 'Russo One',sans-serif;letter-spacing:0.05em;">Reconnect</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-continue-offline').onclick = () => { overlay.remove(); };
  document.getElementById('btn-reconnect').onclick = () => { overlay.remove(); location.reload(); };
});

// ── Respawn car select callback ───────────────────────────��─────────────

game._onRespawnCarSelect = (onCarChosen) => {
  new CarSelect(game.playerNickname, (carType) => {
    onCarChosen(carType);
  }, { respawnMode: true });
};

// ── Start game ──────────────────────────────────────────────────────────

let _startingGame = false;
async function startGame(nickname, carType) {
  if (_startingGame) return;
  _startingGame = true;
  await menuMusic.stop();
  await game.setPlayer(nickname, carType);

  // Connect to multiplayer — auto-redirect to next room if full
  {
    let currentRoom = roomId;
    const MAX_ROOM_ATTEMPTS = 10;
    for (let attempt = 0; attempt < MAX_ROOM_ATTEMPTS; attempt++) {
      try {
        await game.connectMultiplayer(currentRoom);
        showMultiplayerIndicator(currentRoom);
        break;
      } catch (err) {
        if (err && err.roomFull && err.suggestedRoom) {
          // Room full — try the suggested room
          currentRoom = err.suggestedRoom;
          continue;
        }
        // Actual connection error — offer offline play via styled overlay
        const userChoice = await new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;color:#fff5e6;font-family:Russo One,sans-serif;';
          overlay.innerHTML = `
            <h2 style="margin-bottom:10px;color:#ff4422;letter-spacing:0.1em;font-family:Luckiest Guy,cursive;font-size:2rem;">Connection Failed</h2>
            <p style="margin-bottom:24px;color:#c9a87c;max-width:400px;text-align:center;">${err?.message || String(err)}</p>
            <div>
              <button id="btn-offline" style="padding:10px 24px;margin:6px;cursor:pointer;background:linear-gradient(180deg,#ff7700,#ff5500);border:2px solid #ff8800;color:#fff;border-radius:8px;font:14px Russo One,sans-serif;letter-spacing:0.05em;">Play Offline</button>
              <button id="btn-retry" style="padding:10px 24px;margin:6px;cursor:pointer;background:linear-gradient(180deg,#2266ff,#0044dd);border:2px solid #3377ff;color:#fff;border-radius:8px;font:14px Russo One,sans-serif;letter-spacing:0.05em;">Retry</button>
            </div>
          `;
          document.body.appendChild(overlay);
          document.getElementById('btn-offline').onclick = () => { overlay.remove(); resolve('offline'); };
          document.getElementById('btn-retry').onclick = () => { overlay.remove(); resolve('retry'); };
        });
        if (userChoice === 'retry') { location.reload(); return; }
        break; // 'offline' — continue without multiplayer
      }
    }
  }

  showHUD(nickname, carType);
  game.start();
  arenaMusic.play();

  // Emit initial leaderboard
  const entries = game.scoreManager.getLeaderboard();
  updateLeaderboard(entries);
}

// ── Multiplayer indicator ────────────────────────────────────────────────

function showMultiplayerIndicator(rid) {
  // Insert room info inside the RPM container, below the tach
  const div = document.createElement('div');
  div.style.cssText = `
    margin-top:6px;
    color:#886644;font:10px 'Russo One',sans-serif;
    letter-spacing:0.05em;
    text-align:center;
  `;
  div.innerHTML = `ROOM: <span style="color:#ff8c00;">${rid}</span>`;
  rpmContainer.appendChild(div);
}

// ── Start game ──────────────────────────────────────────────────────────

if (isPortalEntry) {
  // Portal entry: skip all menus, instant join
  const nickname = portalUsername || 'PLAYER';
  const randomCar = CAR_ORDER[Math.floor(Math.random() * CAR_ORDER.length)];

  // Preload assets then start immediately
  preloadCarModels(() => {}).then(() => {
    startGame(nickname, randomCar);
  });
} else {
  // Normal flow: Splash → CarSelect → Game
  new SplashScreen({
    loadAssets: (onProgress) => preloadCarModels(onProgress),
    onReady: (nickname) => {
      new CarSelect(nickname, async (carType) => {
        startGame(nickname, carType);
      });
    },
  });
}
