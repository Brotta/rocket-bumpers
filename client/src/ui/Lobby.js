import { PLAYERS } from '../core/Config.js';

/**
 * Lobby overlay — nickname input screen.
 * Shows a neon-styled nickname form, calls onReady(nickname) when submitted.
 */
export class Lobby {
  constructor(onReady) {
    this._onReady = onReady;
    this._el = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'lobby-overlay';
    el.innerHTML = `
      <div class="lobby-box">
        <h1 class="lobby-title">ROCKET<br>BUMPERS</h1>
        <label class="lobby-label">ENTER NICKNAME</label>
        <input
          id="lobby-nick"
          type="text"
          maxlength="${PLAYERS.nicknameMaxLength}"
          placeholder="${PLAYERS.nicknameDefault}${String(Math.floor(Math.random() * 900) + 100)}"
          spellcheck="false"
          autocomplete="off"
        />
        <button id="lobby-go">PLAY</button>
      </div>
    `;
    el.style.cssText = `
      position:fixed;inset:0;z-index:1000;
      display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at center bottom, #1a0a04 0%, #0d0604 50%, #050202 100%);
      font-family:'Courier New',monospace;
      opacity:0;transition:opacity 0.6s ease-in;
    `;
    // Fade in after splash
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    const style = document.createElement('style');
    style.textContent = `
      #lobby-overlay .lobby-box{text-align:center}
      #lobby-overlay .lobby-title{
        font-size:clamp(2rem,8vw,5rem);color:#ff6b20;
        text-shadow:0 0 20px #ff4400,0 0 60px #ff220066;
        margin-bottom:2rem;letter-spacing:0.15em;line-height:1.1;
      }
      #lobby-overlay .lobby-label{
        display:block;color:#aa7755;font-size:0.9rem;
        letter-spacing:0.2em;margin-bottom:0.5rem;
      }
      #lobby-overlay input{
        background:#1a0e08;border:2px solid #ff6b20;color:#ffe0c0;
        font:bold 1.4rem 'Courier New',monospace;
        padding:0.6rem 1rem;text-align:center;
        text-transform:uppercase;width:min(300px,80vw);
        outline:none;border-radius:4px;
      }
      #lobby-overlay input:focus{box-shadow:0 0 12px #ff6b20,0 0 24px #ff440044}
      #lobby-overlay input::placeholder{color:#664422}
      #lobby-overlay button{
        display:block;margin:1.5rem auto 0;
        background:transparent;border:2px solid #ff8c00;color:#ff8c00;
        font:bold 1.4rem 'Courier New',monospace;
        padding:0.7rem 3rem;cursor:pointer;letter-spacing:0.2em;
        border-radius:4px;transition:all .15s;
      }
      #lobby-overlay button:hover{
        background:rgba(255,100,0,0.1);
        box-shadow:0 0 16px #ff6b20,0 0 30px #ff440033;
      }
    `;
    el.appendChild(style);
    document.body.appendChild(el);
    this._el = el;

    const inp = el.querySelector('#lobby-nick');
    const btn = el.querySelector('#lobby-go');

    const submit = () => {
      const raw = inp.value.trim().toUpperCase();
      const nick = raw || inp.placeholder.toUpperCase();
      this.hide();
      this._onReady(nick);
    };

    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    // Auto focus
    requestAnimationFrame(() => inp.focus());
  }

  hide() {
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }
}
