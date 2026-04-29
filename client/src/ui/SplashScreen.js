import { PLAYERS } from '../core/Config.js';
import { menuMusic } from '../audio/MenuMusic.js';

/**
 * SplashScreen — Background image + nickname input + PLAY button.
 * Assets preload silently in the background; PLAY waits if needed.
 */
export class SplashScreen {
  /**
   * @param {object} opts
   * @param {(cb: Function) => Promise<void>} opts.loadAssets
   * @param {(nickname: string) => void} opts.onReady
   */
  constructor({ loadAssets, onReady }) {
    this._onReady = onReady;
    this._el = null;
    this._assetsReady = loadAssets(() => {}).catch((err) => {
      console.error('Asset loading error:', err);
    });
    this._build();
  }

  _build() {
    const placeholder = `${PLAYERS.nicknameDefault}${String(Math.floor(Math.random() * 900) + 100)}`;

    const el = document.createElement('div');
    el.id = 'splash-screen';
    el.innerHTML = `
      <div class="splash-bg"></div>
      <div class="splash-corner-mask"></div>
      <div class="splash-center">
        <div class="splash-login">
          <label class="splash-label">ENTER NICKNAME</label>
          <input
            id="splash-nick"
            type="text"
            maxlength="${PLAYERS.nicknameMaxLength}"
            placeholder="${placeholder}"
            spellcheck="false"
            autocomplete="off"
          />
          <button id="splash-go">PLAY</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #splash-screen {
        position: fixed; inset: 0; z-index: 2000;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
      }

      #splash-screen .splash-bg {
        position: absolute; inset: 0;
        background: url('assets/splash/Background.webp') center top / cover no-repeat;
        background-color: #0d0604;
      }

      /* Dark gradient mask over bottom-right to hide watermark */
      #splash-screen .splash-corner-mask {
        position: absolute; bottom: 0; right: 0;
        width: 220px; height: 120px;
        background: radial-gradient(ellipse at 100% 100%, #0d0604 0%, #0d0604dd 40%, transparent 70%);
        pointer-events: none; z-index: 1;
      }

      #splash-screen .splash-center {
        position: relative; z-index: 2;
        display: flex; flex-direction: column; align-items: center;
        width: min(90vw, 600px);
        margin-top: 40vh;
      }

      #splash-screen .splash-login {
        text-align: center;
        font-family: 'Russo One', sans-serif;
        opacity: 0;
        animation: splash-fade-in 0.6s ease-in 0.3s forwards;
      }

      @keyframes splash-fade-in {
        to { opacity: 1; }
      }

      #splash-screen .splash-label {
        display: block; color: #c9a87c; font-size: 0.85rem;
        font-family: 'Luckiest Guy', cursive;
        letter-spacing: 0.15em; margin-bottom: 0.5rem;
        text-shadow: 0 2px 0 #1a0e08;
      }

      #splash-screen .splash-login input {
        background: rgba(26,14,8,0.9); border: 2px solid #ff6b20; color: #fff5e6;
        font: 1.2rem 'Russo One', sans-serif;
        padding: 0.65rem 1rem; text-align: center;
        text-transform: uppercase; width: min(300px, 80vw);
        outline: none; border-radius: 8px;
        letter-spacing: 0.08em;
      }
      #splash-screen .splash-login input:focus {
        box-shadow: 0 0 12px rgba(255,107,32,0.5), 0 0 24px rgba(255,68,0,0.2);
      }
      #splash-screen .splash-login input::placeholder { color: #886644; }

      #splash-screen .splash-login button {
        display: block; margin: 1.5rem auto 0;
        background: linear-gradient(180deg, rgba(255,107,32,0.15) 0%, transparent 100%);
        border: 3px solid #ff8c00; color: #ff8c00;
        font: 1.4rem 'Luckiest Guy', cursive;
        padding: 0.7rem 3rem; cursor: pointer; letter-spacing: 0.15em;
        border-radius: 10px; transition: all .15s;
        text-shadow: 0 2px 0 #1a0e08;
      }
      #splash-screen .splash-login button:hover {
        background: linear-gradient(180deg, rgba(255,107,32,0.25) 0%, rgba(255,68,0,0.05) 100%);
        box-shadow: 0 0 16px rgba(255,107,32,0.5), 0 0 30px rgba(255,68,0,0.2);
      }
      #splash-screen .splash-login button:disabled {
        opacity: 0.5; cursor: wait;
      }

      /* Ember particles */
      #splash-screen .splash-ember {
        position: absolute;
        width: 4px; height: 4px;
        background: radial-gradient(circle, #ffaa33 0%, #ff4400 60%, transparent 100%);
        border-radius: 50%;
        pointer-events: none;
        animation: ember-rise linear infinite;
        opacity: 0;
      }
      @keyframes ember-rise {
        0%   { transform: translateY(0) scale(1); opacity: 0; }
        10%  { opacity: 0.9; }
        80%  { opacity: 0.4; }
        100% { transform: translateY(-40vh) scale(0.3); opacity: 0; }
      }
    `;
    el.appendChild(style);
    document.body.appendChild(el);
    this._el = el;

    // Wire up nickname submit
    const inp = el.querySelector('#splash-nick');
    const btn = el.querySelector('#splash-go');

    const submit = async () => {
      btn.disabled = true;
      btn.textContent = 'LOADING...';

      // Wait for assets if still loading
      await this._assetsReady;

      const raw = inp.value.trim().toUpperCase();
      const nick = raw || inp.placeholder.toUpperCase();

      // Fade out entire splash
      this._el.style.transition = 'opacity 0.6s ease-out';
      this._el.style.opacity = '0';
      setTimeout(() => {
        this._el.remove();
        this._el = null;
        this._onReady(nick);
      }, 600);
    };

    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    // Spawn ambient embers
    this._spawnEmbers();

    // Start music
    menuMusic.play();

    // Auto focus after fade-in
    setTimeout(() => inp.focus(), 400);
  }

  _spawnEmbers() {
    const container = this._el.querySelector('.splash-bg');
    for (let i = 0; i < 18; i++) {
      const ember = document.createElement('div');
      ember.className = 'splash-ember';
      ember.style.left = `${Math.random() * 100}%`;
      ember.style.bottom = `${Math.random() * 30}%`;
      ember.style.animationDuration = `${2.5 + Math.random() * 3}s`;
      ember.style.animationDelay = `${Math.random() * 3}s`;
      ember.style.width = ember.style.height = `${3 + Math.random() * 4}px`;
      container.appendChild(ember);
    }
  }
}
