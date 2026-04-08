import { Game } from './core/Game.js';
import { CARS, GAME_STATES } from './core/Config.js';
import { SplashScreen } from './ui/SplashScreen.js';
import { CarSelect } from './ui/CarSelect.js';
import { preloadCarModels } from './rendering/CarFactory.js';
import { menuMusic } from './audio/MenuMusic.js';

// ── Create game instance ──────────────────────────────────────────────
const game = new Game();

// ── FPS / Frame-time counter (top-right) ─────────────────────────────
const fpsDiv = document.createElement('div');
fpsDiv.style.cssText = `
  position:fixed;top:16px;right:16px;
  color:#0f0;font:bold 14px 'Courier New',monospace;
  background:rgba(0,0,0,0.6);padding:6px 10px;
  border-radius:4px;pointer-events:none;z-index:100;
  line-height:1.4;
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

// ── HUD elements ──────────────────────────────────────────────────────

// Player info (top-left)
const hudDiv = document.createElement('div');
hudDiv.style.cssText = `
  position:fixed;top:16px;left:16px;
  color:#fff;font:bold 16px 'Courier New',monospace;
  background:rgba(0,0,0,0.5);padding:8px 14px;
  border-radius:6px;pointer-events:none;z-index:10;
  display:none;
`;
document.body.appendChild(hudDiv);

// HP display (top-left, under player info)
const hpDiv = document.createElement('div');
hpDiv.style.cssText = `
  position:fixed;top:52px;left:16px;
  color:#44ff44;font:bold 22px 'Courier New',monospace;
  text-shadow:0 0 8px #44ff44;
  pointer-events:none;z-index:10;display:none;
`;
document.body.appendChild(hpDiv);

// Ability cooldown ring (bottom-right)
const abilityHud = document.createElement('div');
abilityHud.style.cssText = `
  position:fixed;bottom:24px;right:24px;
  width:72px;height:72px;
  pointer-events:none;z-index:10;display:none;
`;
const ringCircumference = 2 * Math.PI * 30;
abilityHud.innerHTML = `
  <svg viewBox="0 0 72 72" style="width:100%;height:100%">
    <circle cx="36" cy="36" r="30" fill="rgba(0,0,0,0.5)" stroke="#333" stroke-width="3"/>
    <circle id="ability-ring" cx="36" cy="36" r="30" fill="none"
      stroke="#0f0" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${ringCircumference}" stroke-dashoffset="0"
      transform="rotate(-90 36 36)"/>
  </svg>
  <div id="ability-label" style="
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#fff;font:bold 11px 'Courier New',monospace;text-align:center;
    text-shadow:0 0 6px #000;white-space:pre-line;
  "></div>
`;
document.body.appendChild(abilityHud);

const abilityRing = abilityHud.querySelector('#ability-ring');
const abilityLabel = abilityHud.querySelector('#ability-label');

// Power-up HUD slot (Mario Kart style — top-right area)
const powerupHud = document.createElement('div');
powerupHud.id = 'powerup-hud';
powerupHud.style.cssText = `
  position:fixed;top:16px;right:16px;
  width:96px;height:110px;
  pointer-events:none;z-index:10;display:none;
  font-family:'Courier New',monospace;
`;
powerupHud.innerHTML = `
  <div id="pu-box" style="
    width:88px;height:88px;margin:0 auto;
    border:3px solid #333;border-radius:12px;
    background:rgba(10,10,26,0.85);
    transition:border-color .25s,box-shadow .25s,transform .15s;
    position:relative;overflow:hidden;
  ">
    <div id="pu-icon" style="
      width:100%;height:100%;
      background-size:contain;
      background-repeat:no-repeat;
      background-position:center;
      transition:opacity .2s;
      opacity:0;
    "></div>
    <div id="pu-flash" style="
      position:absolute;inset:0;
      background:radial-gradient(circle,rgba(255,255,255,0.6) 0%,transparent 70%);
      opacity:0;pointer-events:none;
      transition:opacity .3s;
    "></div>
  </div>
  <div id="pu-label" style="
    text-align:center;font:bold 11px 'Courier New',monospace;
    color:#666;margin-top:4px;letter-spacing:0.1em;
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
  REPAIR_KIT:     { icon: '/assets/icons/RepairKit.png',     label: 'REPAIR' },
  HOLO_EVADE:     { icon: '/assets/icons/HoloEvade.png',     label: 'HOLO' },
  AUTO_TURRET:    { icon: '/assets/icons/Turret.png',        label: 'TURRET' },
};

function setPowerUpHud(type) {
  if (!type) {
    // Empty slot
    puBox.style.borderColor = '#333';
    puBox.style.boxShadow = 'none';
    puBox.style.transform = 'scale(1)';
    puIcon.style.opacity = '0';
    puIcon.style.backgroundImage = 'none';
    puLabel.textContent = '[E] ITEM';
    puLabel.style.color = '#666';
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

  // Pickup pop animation
  puBox.style.transform = 'scale(1.2)';
  setTimeout(() => { puBox.style.transform = 'scale(1)'; }, 200);
}

function flashPowerUpUsed() {
  puFlash.style.opacity = '1';
  puBox.style.transform = 'scale(1.15)';
  setTimeout(() => {
    puFlash.style.opacity = '0';
    puBox.style.transform = 'scale(1)';
    setPowerUpHud(null);
  }, 300);
}

// Results overlay
const resultsDiv = document.createElement('div');
resultsDiv.style.cssText = `
  position:fixed;inset:0;z-index:60;
  display:none;align-items:center;justify-content:center;flex-direction:column;
  background:rgba(5,5,16,0.85);
  font-family:'Courier New',monospace;
`;
document.body.appendChild(resultsDiv);

// ── HUD update functions ────────────────────────────────────────────────

let currentCarType = null;

function showHUD(nickname, carType) {
  currentCarType = carType;
  const c = CARS[carType];
  hudDiv.textContent = `${nickname} — ${c.name}`;
  hudDiv.style.display = 'block';
  hpDiv.style.display = 'block';
  abilityHud.style.display = 'block';
  powerupHud.style.display = 'block';
  abilityLabel.textContent = `${c.ability.name}\n[SPACE]`;
  setPowerUpHud(null);
}

function updateAbilityHud() {
  const ability = game.localAbility;
  if (!ability) return;

  const progress = ability.cooldownProgress;
  abilityRing.setAttribute('stroke-dashoffset', String(ringCircumference * (1 - progress)));

  if (ability.state === 'ready') {
    abilityRing.setAttribute('stroke', '#0f0');
    abilityLabel.style.color = '#0f0';
  } else if (ability.state === 'active') {
    abilityRing.setAttribute('stroke', '#ff0');
    abilityLabel.style.color = '#ff0';
  } else {
    abilityRing.setAttribute('stroke', '#666');
    abilityLabel.style.color = '#666';
  }
}

function updateHpHud() {
  if (game.localPlayer) {
    const hp = Math.ceil(game.localPlayer.hp);
    hpDiv.textContent = `HP: ${hp}`;
    if (hp > 60) {
      hpDiv.style.color = '#44ff44';
      hpDiv.style.textShadow = '0 0 8px #44ff44';
    } else if (hp > 30) {
      hpDiv.style.color = '#ffcc00';
      hpDiv.style.textShadow = '0 0 8px #ffcc00';
    } else {
      hpDiv.style.color = '#ff3333';
      hpDiv.style.textShadow = '0 0 8px #ff3333';
    }
  }
}

function showResults(results) {
  resultsDiv.style.display = 'flex';
  const winner = results[0];
  const title = winner && !winner.isEliminated ? `${winner.nickname} WINS!` : 'ROUND OVER';
  resultsDiv.innerHTML = `
    <h1 style="color:#0ff;font-size:2.5rem;margin-bottom:1.5rem;
      text-shadow:0 0 20px #0ff;letter-spacing:0.15em;">${title}</h1>
    <div style="width:min(400px,90vw)">
      ${results.map((r, i) => {
        const hpText = r.isEliminated ? 'ELIMINATED' : `${Math.ceil(r.hp)} HP`;
        const color = r.isEliminated ? '#666' : (i === 0 ? '#ff0' : '#ccc');
        const size = i === 0 ? '1.2rem' : '1rem';
        return `
          <div style="display:flex;justify-content:space-between;padding:8px 12px;
            color:${color};font-size:${size};
            border-bottom:1px solid #222;${r.isEliminated ? 'text-decoration:line-through;opacity:0.6;' : ''}">
            <span>${i + 1}. ${r.nickname} (${r.carType})</span>
            <span style="font-weight:bold">${hpText}</span>
          </div>
        `;
      }).join('')}
    </div>
    <p style="color:#666;margin-top:1.5rem;font-size:0.8rem">Next round starting...</p>
  `;
}

// ── Game event listeners ────────────────────────────────────────────────

game.on('stateChange', ({ from, to }) => {
  if (to === GAME_STATES.COUNTDOWN) {
    resultsDiv.style.display = 'none';
  }
});

game.on('roundEnd', ({ results }) => {
  showResults(results);
});

// ── Power-up events ────────────────────────────────────────────────────

game.powerUpManager.on('pickup', ({ car, type }) => {
  if (car === game.localPlayer) {
    setPowerUpHud(type);
  }
});

game.powerUpManager.on('used', ({ car, type }) => {
  if (car === game.localPlayer) {
    flashPowerUpUsed();
  }
});

// HUD updates each frame via a polling approach in rAF
const _hudLoop = () => {
  requestAnimationFrame(_hudLoop);
  if (game.gameState.isPlaying) {
    updateAbilityHud();
    updateHpHud();
  }
};
requestAnimationFrame(_hudLoop);

// ── Damage feedback flash ───────────────────────────────────────────────

game.on('damage', ({ target, amount }) => {
  if (target === game.localPlayer && amount > 0) {
    // Flash HP display red when taking damage
    hpDiv.style.color = '#ff0000';
    hpDiv.style.textShadow = '0 0 12px #ff0000';
    setTimeout(() => updateHpHud(), 200);
  }
});

game.on('eliminated', ({ victim }) => {
  if (victim === game.localPlayer) {
    hpDiv.textContent = 'ELIMINATED';
    hpDiv.style.color = '#ff0000';
    hpDiv.style.textShadow = '0 0 12px #ff0000';
  }
});

// ── UI Flow: Splash (load + nickname) → CarSelect → Game ─────────────

new SplashScreen({
  loadAssets: (onProgress) => preloadCarModels(onProgress),
  onReady: (nickname) => {
    new CarSelect(nickname, async (carType) => {
      await menuMusic.stop();
      await game.setPlayer(nickname, carType);
      showHUD(nickname, carType);
      game.start();
    });
  },
});
