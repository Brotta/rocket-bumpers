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
      font-family:'Russo One',sans-serif;
      opacity:0;transition:opacity 0.6s ease-in;
    `;
    // Fade in after splash
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    const style = document.createElement('style');
    style.textContent = `
      #lobby-overlay .lobby-box{text-align:center}
      #lobby-overlay .lobby-title{
        font-family:'Luckiest Guy',cursive;
        font-size:clamp(2rem,8vw,5rem);color:#ff6b20;
        text-shadow:0 4px 0 #1a0e08, 0 0 20px rgba(255,68,0,0.5), 0 0 60px rgba(255,34,0,0.2);
        margin-bottom:2rem;letter-spacing:0.1em;line-height:1.1;
      }
      #lobby-overlay .lobby-label{
        display:block;color:#c9a87c;font-size:0.85rem;
        font-family:'Luckiest Guy',cursive;
        letter-spacing:0.15em;margin-bottom:0.5rem;
        text-shadow:0 2px 0 #1a0e08;
      }
      #lobby-overlay input{
        background:rgba(26,14,8,0.9);border:2px solid #ff6b20;color:#fff5e6;
        font:1.2rem 'Russo One',sans-serif;
        padding:0.65rem 1rem;text-align:center;
        text-transform:uppercase;width:min(300px,80vw);
        outline:none;border-radius:8px;letter-spacing:0.08em;
      }
      #lobby-overlay input:focus{box-shadow:0 0 12px rgba(255,107,32,0.5),0 0 24px rgba(255,68,0,0.2)}
      #lobby-overlay input::placeholder{color:#886644}
      #lobby-overlay button{
        display:block;margin:1.5rem auto 0;
        background:linear-gradient(180deg, rgba(255,107,32,0.15) 0%, transparent 100%);
        border:3px solid #ff8c00;color:#ff8c00;
        font:1.4rem 'Luckiest Guy',cursive;
        padding:0.7rem 3rem;cursor:pointer;letter-spacing:0.15em;
        border-radius:10px;transition:all .15s;
        text-shadow:0 2px 0 #1a0e08;
      }
      #lobby-overlay button:hover{
        background:linear-gradient(180deg, rgba(255,107,32,0.25) 0%, rgba(255,68,0,0.05) 100%);
        box-shadow:0 0 16px rgba(255,107,32,0.5),0 0 30px rgba(255,68,0,0.2);
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
