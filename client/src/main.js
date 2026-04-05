import { Game } from './core/Game.js';
import { CARS, GAME_STATES } from './core/Config.js';
import { SplashScreen } from './ui/SplashScreen.js';
import { CarSelect } from './ui/CarSelect.js';
import { preloadCarModels } from './rendering/CarFactory.js';
import { menuMusic } from './audio/MenuMusic.js';

// ── Create game instance ──────────────────────────────────────────────
const game = new Game();

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

// Score (top-left, under player info)
const scoreDiv = document.createElement('div');
scoreDiv.style.cssText = `
  position:fixed;top:52px;left:16px;
  color:#0f0;font:bold 22px 'Courier New',monospace;
  text-shadow:0 0 8px #0f0;
  pointer-events:none;z-index:10;display:none;
`;
document.body.appendChild(scoreDiv);

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
  width:72px;height:84px;
  pointer-events:none;z-index:10;display:none;
  font-family:'Courier New',monospace;
`;
powerupHud.innerHTML = `
  <div id="pu-box" style="
    width:64px;height:64px;margin:0 auto;
    border:3px solid #333;border-radius:10px;
    background:rgba(10,10,26,0.8);
    display:flex;align-items:center;justify-content:center;
    transition:border-color .25s,box-shadow .25s,transform .15s;
    position:relative;overflow:hidden;
  ">
    <div id="pu-icon" style="
      font-size:28px;line-height:1;
      text-shadow:0 0 10px currentColor;
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
    text-align:center;font:bold 9px 'Courier New',monospace;
    color:#666;margin-top:3px;letter-spacing:0.1em;
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
  ROCKET_BOOST: { icon: '🚀', label: 'BOOST' },
  SHOCKWAVE:    { icon: '💥', label: 'SHOCK' },
  SHIELD:       { icon: '🛡️', label: 'SHIELD' },
  MAGNET:       { icon: '🧲', label: 'MAGNET' },
};

function setPowerUpHud(type) {
  if (!type) {
    // Empty slot
    puBox.style.borderColor = '#333';
    puBox.style.boxShadow = 'none';
    puBox.style.transform = 'scale(1)';
    puIcon.style.opacity = '0';
    puLabel.textContent = '[E] ITEM';
    puLabel.style.color = '#666';
    return;
  }
  const cfg = CARS.FANG; // just need POWERUPS
  const powerupCfg = game.powerUpManager.getHeldConfig(game.localPlayer);
  const colorHex = powerupCfg ? '#' + powerupCfg.color.toString(16).padStart(6, '0') : '#fff';
  const display = PU_DISPLAY[type] || { icon: '?', label: type };

  puBox.style.borderColor = colorHex;
  puBox.style.boxShadow = `0 0 16px ${colorHex}55, inset 0 0 20px ${colorHex}22`;
  puIcon.textContent = display.icon;
  puIcon.style.color = colorHex;
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
  scoreDiv.style.display = 'block';
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

function updateScoreHud() {
  if (game.localPlayer) {
    scoreDiv.textContent = `SCORE: ${game.localPlayer.score}`;
  }
}

function showResults(results) {
  resultsDiv.style.display = 'flex';
  resultsDiv.innerHTML = `
    <h1 style="color:#0ff;font-size:2.5rem;margin-bottom:1.5rem;
      text-shadow:0 0 20px #0ff;letter-spacing:0.15em;">ROUND OVER</h1>
    <div style="width:min(400px,90vw)">
      ${results.map((r, i) => `
        <div style="display:flex;justify-content:space-between;padding:8px 12px;
          color:${i === 0 ? '#ff0' : '#ccc'};font-size:${i === 0 ? '1.2rem' : '1rem'};
          border-bottom:1px solid #222;">
          <span>${i + 1}. ${r.nickname} (${r.carType})</span>
          <span style="font-weight:bold">${r.score}</span>
        </div>
      `).join('')}
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
    updateScoreHud();
  }
};
requestAnimationFrame(_hudLoop);

// ── Hit feedback flash ──────────────────────────────────────────────────

game.on('hit', ({ attacker, victim, tier }) => {
  if (attacker === game.localPlayer) {
    _flashScore(tier);
  }
});

game.on('ko', ({ attacker, isAbilityKO }) => {
  if (attacker === game.localPlayer) {
    _flashScore(isAbilityKO ? 'abilityKO' : 'ko');
  }
});

function _flashScore(tier) {
  const colors = { normal: '#fff', big: '#ff0', mega: '#f40', ko: '#0ff', abilityKO: '#f0f' };
  scoreDiv.style.color = colors[tier] || '#0f0';
  setTimeout(() => { scoreDiv.style.color = '#0f0'; }, 300);
}

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
