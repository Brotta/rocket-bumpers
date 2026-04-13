import { Game } from './core/Game.js';
import { CARS, CAR_ORDER } from './core/Config.js';
import { SplashScreen } from './ui/SplashScreen.js';
import { CarSelect } from './ui/CarSelect.js';
import { preloadCarModels } from './rendering/CarFactory.js';
import { menuMusic } from './audio/MenuMusic.js';

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

// ── HUD elements ───────────────────────────────────────���──────────────

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
  position:fixed;bottom:max(12px, env(safe-area-inset-bottom, 0px));right:max(12px, env(safe-area-inset-right, 0px));
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

// ── Leaderboard (left side) ─────────────────────────────────────────
const leaderboardDiv = document.createElement('div');
leaderboardDiv.style.cssText = `
  position:fixed;top:100px;left:16px;
  color:#fff;font:bold 13px 'Courier New',monospace;
  background:rgba(0,0,0,0.5);padding:10px 14px;
  border-radius:6px;pointer-events:none;z-index:10;
  display:none;min-width:180px;
`;
document.body.appendChild(leaderboardDiv);

// ── Kill streak indicator (center) ──────────────────────────────────
const streakDiv = document.createElement('div');
streakDiv.style.cssText = `
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  color:#ff0;font:bold 36px 'Courier New',monospace;
  text-shadow:0 0 20px #ff0,0 0 40px #ff8800;
  pointer-events:none;z-index:50;display:none;
  transition:opacity 0.5s;
`;
document.body.appendChild(streakDiv);

function updateLeaderboard(entries) {
  const top5 = entries.slice(0, 5);
  const localId = game.networkManager?.localPlayerId || 'local';
  leaderboardDiv.innerHTML = '<div style="color:#0ff;margin-bottom:6px;letter-spacing:0.15em;">LEADERBOARD</div>' +
    top5.map((e, i) => {
      const isLocal = e.playerId === localId;
      const color = isLocal ? '#ff0' : (i === 0 ? '#0ff' : '#aaa');
      const streakText = e.streak >= 3 ? ` 🔥${e.streak}` : '';
      return `<div style="color:${color};padding:2px 0;">${i + 1}. ${e.nickname} — ${e.score}${streakText}</div>`;
    }).join('');
}

function showStreakNotification(streak, multiplier) {
  if (streak < 3) return;
  streakDiv.textContent = `${multiplier}× KILL STREAK!`;
  streakDiv.style.display = 'block';
  streakDiv.style.opacity = '1';
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
  hudDiv.textContent = `${nickname} — ${c.name}`;
  hudDiv.style.display = 'block';
  hpDiv.style.display = 'block';
  abilityHud.style.display = 'block';
  powerupHud.style.display = 'block';
  leaderboardDiv.style.display = 'block';
  abilityLabel.textContent = `${c.ability.name}\n[SPACE]`;
  setPowerUpHud(null);

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

// ── Game event listeners ────────────────────────────────────────────────

// Score events → leaderboard + streak notifications
game.scoreManager.on('leaderboard', ({ entries }) => {
  updateLeaderboard(entries);
});

game.scoreManager.on('scoreUpdate', ({ playerId, streak, multiplier }) => {
  const localId = game.networkManager?.localPlayerId || 'local';
  if (playerId === localId && streak >= 3) {
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

// HUD updates each frame via a polling approach in rAF
const _hudLoop = () => {
  requestAnimationFrame(_hudLoop);
  if (game.gameState.isPlaying) {
    updateAbilityHud();
    updateHpHud();

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

// When player respawns with new car, update HUD
game.on('playerSpawned', ({ carBody, carType }) => {
  if (carBody === game.localPlayer) {
    showHUD(game.playerNickname, carType);
  }
});

// ── Disconnect notification ──────────────────────────────────────────
game.on('disconnected', () => {
  const banner = document.createElement('div');
  banner.textContent = 'Connection lost — playing offline';
  banner.style.cssText = `
    position:fixed;top:16px;left:50%;transform:translateX(-50%);
    color:#ff4444;font:bold 14px 'Courier New',monospace;
    background:rgba(0,0,0,0.8);padding:8px 16px;border-radius:4px;
    z-index:9999;pointer-events:none;`;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 5000);
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
        // Actual connection error — offer offline play
        const goOffline = confirm('Multiplayer connection failed: ' + (err?.message || String(err)) + '\n\nPlay offline instead?');
        if (!goOffline) { _startingGame = false; return; }
        break;
      }
    }
  }

  showHUD(nickname, carType);
  game.start();

  // Emit initial leaderboard
  const entries = game.scoreManager.getLeaderboard();
  updateLeaderboard(entries);
}

// ── Multiplayer indicator ────────────────────────────────────────────────

function showMultiplayerIndicator(rid) {
  const div = document.createElement('div');
  div.style.cssText = `
    position:fixed;bottom:16px;left:16px;
    color:#0ff;font:bold 12px 'Courier New',monospace;
    background:rgba(0,0,0,0.6);padding:6px 10px;
    border-radius:4px;pointer-events:none;z-index:10;
    border:1px solid #0ff44;
  `;
  div.innerHTML = `ROOM: ${rid}<br><span style="color:#888;font-size:10px;">Share URL to invite</span>`;
  document.body.appendChild(div);
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
