/**
 * MenuMusic — background music for splash / lobby / car-select screens.
 * Plays `hot_roadway_bpm160.ogg` in a loop, with fade-in on start
 * and fade-out on stop.
 */

const FADE_IN_MS = 1500;
const FADE_OUT_MS = 800;
const VOLUME = 0.45;

let _audio = null;
let _fading = null;

function _fade(from, to, duration) {
  return new Promise((resolve) => {
    if (_fading) cancelAnimationFrame(_fading);
    if (!_audio) { resolve(); return; }

    const start = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      if (_audio) _audio.volume = from + (to - from) * t;
      if (t < 1) {
        _fading = requestAnimationFrame(tick);
      } else {
        _fading = null;
        resolve();
      }
    };
    _fading = requestAnimationFrame(tick);
  });
}

export const menuMusic = {
  _pendingRetry: false,

  /** Start looping menu music with fade-in. Safe to call multiple times. */
  play() {
    if (_audio) return; // already playing
    _audio = new Audio('assets/splash/hot_roadway_bpm160.ogg');
    _audio.loop = true;
    _audio.volume = 0;
    _audio.play().then(() => {
      _fade(0, VOLUME, FADE_IN_MS);
      this._pendingRetry = false;
    }).catch(() => {
      // Autoplay blocked — retry on first user gesture
      _audio = null;
      if (!this._pendingRetry) {
        this._pendingRetry = true;
        const retry = () => {
          window.removeEventListener('click', retry);
          window.removeEventListener('keydown', retry);
          window.removeEventListener('touchstart', retry);
          this._pendingRetry = false;
          this.play();
        };
        window.addEventListener('click', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
        window.addEventListener('touchstart', retry, { once: true });
      }
    });
  },

  /** Fade out and stop. Returns a promise that resolves when silent. */
  async stop() {
    if (!_audio) return;
    await _fade(_audio.volume, 0, FADE_OUT_MS);
    if (_audio) {
      _audio.pause();
      _audio.src = '';
      _audio = null;
    }
  },
};
